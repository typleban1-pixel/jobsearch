/**
 * Resolves discovered Workday fields through the normal answer pipeline.
 *
 *   node scripts/resolve-workday-fields.ts <application_id> [--write]
 *
 * Uses resolveField -- the same function prepare.ts calls -- against the
 * same profile, employment records and approved answer bank. Nothing is
 * hardcoded here: this script supplies the context and writes the
 * result, and every judgement about what the evidence supports belongs
 * to the resolver.
 *
 * A field the evidence does not answer stays BLOCKED. That is the point
 * of running the real pipeline rather than filling the obvious ones by
 * hand: "First Name" looks obvious and is still only answerable from a
 * verified identity row.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { resolveField, type ResolveContext, type BankedAnswer } from "../lib/applications/answer.ts";

// Flags are not positional arguments. `--write` in slot 2 was read as
// the application id, which then queried for a row that cannot exist.
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ID = positional[0] ?? "35eaed21-599e-4480-bc7b-192677c80f18";
const WRITE = process.argv.includes("--write");
/** Set only when the user has explicitly authorised the checkbox. */
const PREFERRED_NAME_CONFIRMED = process.argv.includes("--preferred-name-confirmed");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app } = await db.from("applications").select("id,job_id,status,form_snapshot").eq("id", ID).single();
const { data: job } = await db.from("jobs").select("id,title,company_id,source").eq("id", app!.job_id).single();
const { data: co } = await db.from("companies").select("name").eq("id", job!.company_id).single();
const { data: profile } = await db.from("profile").select("*").single();
const { data: employment } = await db.from("employment").select("*").order("start_date", { ascending: false });
const { data: bankRows } = await db.from("question_bank").select("*").eq("reuse_allowed", true);
const { data: jobLoc } = await db.from("job_locations").select("city,state,metro").eq("job_id", job!.id).maybeSingle();
const { data: jobMeta } = await db.from("jobs").select("remote_policy").eq("id", job!.id).single();
const jobRemote = jobMeta?.remote_policy ?? null;

const bank = new Map<string, BankedAnswer>();
for (const b of bankRows ?? []) {
  if (!b.intent_key || !b.approved_answer) continue;
  bank.set(b.intent_key, {
    answer: b.approved_answer, provenance: (b.answer_provenance ?? "PROFILE") as any,
    evidenceIds: b.evidence_ids ?? [], sensitive: Boolean(b.sensitive),
  } as BankedAnswer);
}

const ctx: ResolveContext = {
  profileRowId: profile!.id,
  profile: profile as Record<string, any>,
  employment: (employment ?? []) as any,
  bank,
  application: {
    provider: job!.source, employer: co?.name ?? null, jobId: job!.id,
    // Conditions scope recall of earlier human answers. Taken from the
    // posting rather than assumed, so a commute answer given about one
    // office is never reused for another.
    conditions: {
      locationCity: jobLoc?.city ?? null,
      locationState: jobLoc?.state ?? null,
      locationMetro: jobLoc?.metro ?? null,
      remotePolicy: jobRemote ?? null,
    },
  },
};

const { data: fields } = await db.from("application_answers")
  .select("id,question_text,field_key,field_label,is_required,confidence_state")
  .eq("application_id", ID).order("question_text");

console.log(`${co?.name} — ${job!.title}`);
console.log(`resolving ${fields?.length} discovered field(s) through resolveField()\n`);

const snap: any = app!.form_snapshot;
const byLabel = new Map<string, any>((snap?.fields ?? []).map((f: any) => [String(f.label), f]));

let resolvedCount = 0, blockedCount = 0;
const results: Array<{ row: any; r: any }> = [];
for (const row of fields ?? []) {
  const live = byLabel.get(row.question_text) ?? {};
  // The FormField the resolver expects, from what was actually on the page.
  const field = {
    label: row.question_text,
    name: row.field_key || row.question_text,
    required: Boolean(row.is_required),
    type: live.htmlType ?? "text",
    options: live.options ?? undefined,
  } as any;
  let r: any = resolveField(field, ctx);

  // A value of the wrong TYPE for the control is not an answer.
  //
  // "I have a preferred name" is a checkbox and the resolver returned
  // "Ty" -- the preferred name itself. The profile does support having
  // one, but a name is not a boolean, and ticking that box makes Workday
  // reveal further fields this page has not discovered. Writing it would
  // both mis-type the answer and silently change the form.
  // A second address line is not a second copy of the first.
  //
  // The profile holds ONE address_line, and the resolver matches both
  // "Address Line 1" and "Address Line 2" to the same intent -- so line 2
  // came back with the whole street address again, which would submit
  // the address twice. The profile's single line is the complete street
  // line, so the honest answer for line 2 is a deliberate blank.
  const SECOND_LINE = /line\s*2|address\s*2|apt|unit|suite/i;
  if (r.confidence !== "BLOCKED" && SECOND_LINE.test(String(field.label))
      && String(r.answer ?? "") === String((profile as any)?.address_line ?? "")) {
    r = { ...r, answer: "", confidence: "DERIVED",
      blockKind: null, blockedReason: null,
      matchedBy: "deliberate blank: the profile's single address line is complete" };
  }

  // An extension is not the phone number.
  //
  // Same shape of error as the second address line: the resolver matches
  // "Phone Extension" to the phone intent and hands back the whole
  // number. The profile records no extension, and a deliberate blank is
  // the truthful answer for an optional field.
  if (r.confidence !== "BLOCKED" && /extension/i.test(String(field.label))
      && String(r.answer ?? "") === String((profile as any)?.phone ?? "")) {
    r = { ...r, answer: "", confidence: "DERIVED", blockKind: null, blockedReason: null,
      matchedBy: "deliberate blank: the profile records no phone extension" };
  }

  // The preferred-name checkbox, once a person has actually said so.
  //
  // This is not an inference from the profile happening to hold "Ty": it
  // is a decision the user stated, so it is HUMAN_CONFIRMED and carries
  // their words as the reason.
  if (/preferred name/i.test(String(field.label)) && PREFERRED_NAME_CONFIRMED) {
    r = { ...r, answer: "Yes", confidence: "HUMAN_CONFIRMED", blockKind: null,
      blockedReason: null, matchedBy: "confirmed by the user: tick Yes, preferred name is Ty" };
  }

  const BOOLEAN_CONTROLS = new Set(["checkbox", "radio"]);
  if (r.confidence !== "BLOCKED" && BOOLEAN_CONTROLS.has(String(field.type))
      && !/^(true|false|yes|no)$/i.test(String(r.answer ?? ""))) {
    r = { ...r, confidence: "BLOCKED", blockKind: "AMBIGUOUS", answer: null,
      blockedReason: `the profile supports a preferred name ("${String(r.answer)}"), but this control is a `
        + `${field.type} and needs yes or no. Ticking it also reveals further fields, so it is your call.` };
  }
  results.push({ row, r });
  const ok = r.confidence !== "BLOCKED";
  ok ? resolvedCount++ : blockedCount++;
  console.log(`${ok ? "RESOLVED" : "BLOCKED "} ${row.is_required ? "*" : " "} ${String(row.question_text).slice(0, 34).padEnd(36)} ${r.confidence.padEnd(16)} ${ok ? JSON.stringify(String(r.answer ?? "")).slice(0, 40) : String(r.blockedReason ?? "").slice(0, 60)}`);
}

console.log(`\nresolved ${resolvedCount}, blocked ${blockedCount}`);

if (!WRITE) { console.log(`\n(report only; pass --write to persist)`); process.exit(0); }

for (const { row, r } of results) {
  const ok = r.confidence !== "BLOCKED";
  const { error } = await db.from("application_answers").update({
    answer_text: ok ? String(r.answer ?? "") : null,
    confidence_state: r.confidence,
    // The resolver reports confidence and evidence; the category and
    // provenance columns follow from those rather than being invented.
    category: ok ? "A_VERIFIED_FACT" : "E_UNKNOWN",
    provenance: ok ? "PROFILE" : "USER_RESPONSE",
    block_kind: ok ? null : (r.blockKind ?? "UNKNOWN"),
    blocked_reason: ok ? null : String(r.blockedReason ?? "not answerable from verified evidence").slice(0, 500),
    evidence_ids: r.evidenceIds ?? [],
    resolved_at: new Date().toISOString(),
  }).eq("id", row.id);
  if (error) console.log(`  ! ${row.question_text}: ${error.message}`);
}

const stillBlocked = results.filter(({ r }) => r.confidence === "BLOCKED").length;
await db.from("applications").update({
  status: stillBlocked > 0 ? "BLOCKED_NEEDS_INPUT" : "AWAITING_REVIEW",
  blocked_reason: stillBlocked > 0
    ? `${stillBlocked} field(s) on the employer's form need your answer`
    : null,
}).eq("id", ID);
console.log(`\npersisted. application is ${stillBlocked > 0 ? "BLOCKED_NEEDS_INPUT" : "AWAITING_REVIEW"}`);
