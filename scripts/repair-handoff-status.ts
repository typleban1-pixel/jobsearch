/**
 * Repairs two applications whose status was flipped by a defect.
 *
 *   node scripts/repair-handoff-status.ts            inspect only
 *   node scripts/repair-handoff-status.ts --commit   write the repair
 *
 * What went wrong
 * ---------------
 * The Apply board's self-heal moved any BLOCKED_NEEDS_INPUT application
 * with zero BLOCKED answers to AWAITING_REVIEW, on the assumption that
 * "no blocked questions" means "the questions have all been answered".
 * That assumption holds when questions were the blocker. It is false for
 * an employer-form handoff, where the blocker is that the form cannot be
 * read at all, so there are no answer rows to be blocked and the count
 * is zero from the moment the application is created.
 *
 * Two real applications were flipped that way. Both are Workday, both
 * still need a person to open the employer's form, and neither has been
 * submitted. AWAITING_REVIEW says something is prepared and waiting for
 * a reviewer, which is not true of either.
 *
 * The fix that prevents recurrence is already in
 * answerCompleteness.staleBlockedStatus, which now refuses to clear an
 * employer-form handoff. This script only repairs the two records that
 * predate it.
 *
 * Why this is the narrowest path
 * ------------------------------
 * The transition guard ALREADY permits AWAITING_REVIEW ->
 * BLOCKED_NEEDS_INPUT. So the repair is an ordinary status update that
 * the normal state machine validates, exactly like any other transition.
 * Nothing is bypassed, no flag is set, no guard is relaxed, and no
 * migration is needed. The status_change event is written by the
 * existing AFTER trigger; this script appends one further event saying
 * why a human-visible state moved without a human doing anything.
 *
 * Safety
 * ------
 * Every precondition is re-checked here rather than trusted from an
 * earlier session, and each application is repaired only if all of them
 * still hold. Only `status` is written. Every other column is captured
 * before and compared after, so an unintended write cannot pass quietly.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { isEmployerFormHandoff } from "../lib/portal/answerCompleteness.ts";
import { present, type ApplicationFacts } from "../lib/portal/presentationState.ts";
import { firstSentenceOf } from "../lib/portal/applyBoard.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

/** The only two records this script may touch. */
const TARGETS = [
  "1194017d-337a-40ab-960d-20d4253b9db7", // University of Chicago, Program Director
  "35eaed21-599e-4480-bc7b-192677c80f18", // Northern Trust, Program Manager
];

const FROM = "AWAITING_REVIEW";
const TO = "BLOCKED_NEEDS_INPUT";

/**
 * Columns the repair is allowed to move.
 *
 * last_status_change_at and updated_at belong to the status change
 * itself. Everything else, and in particular the bound artifact, the
 * approval and its timestamp, must be byte-identical afterwards.
 */
const MAY_CHANGE = new Set(["status", "last_status_change_at", "updated_at"]);

let refused = 0;
let repaired = 0;

for (const id of TARGETS) {
  const { data: before } = await db.from("applications").select("*").eq("id", id).maybeSingle();
  if (!before) { console.log(`\n${id}: NOT FOUND, skipping`); refused++; continue; }

  const { data: jobRow } = await db.from("jobs").select("title,source,company_id").eq("id", before.job_id).single();
  const job = jobRow!;
  const { data: companyRow } = await db.from("companies").select("name").eq("id", job.company_id).single();
  const company = companyRow!;
  const { data: runs } = await db.from("application_fill_runs").select("id,outcome").eq("application_id", id);
  const { count: blocked } = await db.from("application_answers")
    .select("*", { count: "exact", head: true }).eq("application_id", id).eq("confidence_state", "BLOCKED");
  const { data: events } = await db.from("application_events")
    .select("event,detail,from_status,to_status,actor,occurred_at")
    .eq("application_id", id).order("occurred_at", { ascending: true });

  console.log(`\n=== ${company.name} / ${String(job.title).slice(0, 52)} (${id.slice(0, 8)}) ===`);

  // The defect's signature: a status_change into AWAITING_REVIEW, written
  // by the system with no detail, after the application had settled in
  // BLOCKED_NEEDS_INPUT. A human review would have carried a detail and
  // an actor that is not "system".
  const flip = (events ?? []).find((e) =>
    e.to_status === FROM && e.from_status === TO && e.actor === "system" && !e.detail);

  const checks: Array<[string, boolean, string]> = [
    ["still an employer-form handoff", isEmployerFormHandoff(before.blocked_reason), String(before.blocked_reason).slice(0, 60)],
    ["currently AWAITING_REVIEW", before.status === FROM, before.status],
    ["never submitted", before.submitted_at === null, String(before.submitted_at)],
    ["no submit click was ever attempted", before.submit_click_attempted_at === null, String(before.submit_click_attempted_at)],
    ["no fill run exists", (runs ?? []).length === 0, `${(runs ?? []).length}`],
    ["no completed HANDOFF run made the blocker obsolete",
      !(runs ?? []).some((r) => r.outcome === "HANDOFF"), (runs ?? []).map((r) => r.outcome).join(",")],
    ["zero blocked answers, which is what triggered the defect", blocked === 0, String(blocked)],
    ["the audit trail shows the defective self-heal flip", Boolean(flip), flip ? flip.occurred_at : "no matching event"],
    ["not a test application", before.is_test === false, String(before.is_test)],
  ];

  let allOk = true;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? "ok  " : "STOP"} ${name}${ok ? "" : `  (${detail})`}`);
    if (!ok) allOk = false;
  }

  if (!allOk) {
    console.log("  REFUSED: a precondition no longer holds, so this record is left alone.");
    refused++;
    continue;
  }

  if (!commit) {
    console.log(`  would repair: ${FROM} -> ${TO}  (pass --commit to write)`);
    continue;
  }

  // The repair itself: one column, through the ordinary guard.
  const { error: upErr } = await db.from("applications").update({ status: TO }).eq("id", id);
  if (upErr) { console.log(`  FAILED: ${upErr.message}`); refused++; continue; }

  // Why a status moved with no human involved. The trigger has already
  // written the bare status_change; this is the explanation beside it.
  const { error: evErr } = await db.from("application_events").insert({
    application_id: id,
    event: "STATUS_REPAIRED_HANDOFF",
    detail:
      `Repaired ${FROM} -> ${TO}. The earlier ${TO} -> ${FROM} transition at ${flip!.occurred_at} was a defect, `
      + "not a review: the Apply board's self-heal treated zero BLOCKED answers as \"the questions have been answered\". "
      + "This application is an employer-form handoff, so it has no answer rows at all and that count was zero from "
      + "creation. The blocker is unchanged and unresolved: the employer's form still has to be opened by a person. "
      + "Verified before repairing: never submitted, no submit click attempted, no fill run, no completed handoff run. "
      + "Only status was written; artifact, approval and answers are untouched. "
      + "Recurrence is prevented by staleBlockedStatus, which no longer clears an employer-form handoff.",
    actor: "system",
  });
  if (evErr) console.log(`  (repair event not recorded: ${evErr.message})`);

  // Prove only the intended columns moved.
  const { data: after } = await db.from("applications").select("*").eq("id", id).single();
  const drifted = Object.keys(before).filter(
    (k) => !MAY_CHANGE.has(k) && JSON.stringify(before[k]) !== JSON.stringify((after as any)[k]));
  console.log(`  status now ${after.status}`);
  console.log(`  columns changed outside the repair: ${drifted.length === 0 ? "none" : drifted.join(", ")}`);
  if (drifted.length) console.log("  WARNING: unintended write, inspect immediately");

  // And prove the card still reads correctly to a person.
  const facts: ApplicationFacts = {
    status: after.status,
    humanApproved: Boolean(after.human_approved),
    allFieldsConfident: Boolean(after.all_fields_confident),
    blockedAnswers: blocked ?? 0,
    submittedAt: after.submitted_at ?? null,
    confirmationReceived: Boolean(after.confirmation_email_received || after.confirmation_reference),
    provider: job.source,
    refusals: [],
    handoff: isEmployerFormHandoff(after.blocked_reason),
    applyUrl: null,
    handoffReason: firstSentenceOf(after.blocked_reason),
  };
  const p = present(facts, id);
  console.log(`  renders as: ${p.state}  "${p.summary}"`);
  if (p.state !== "NEEDS_YOU") console.log("  WARNING: no longer renders as Needs You");
  repaired++;
}

console.log(`\n${commit ? `${repaired} repaired, ${refused} refused` : "inspection only, nothing written"}`);
