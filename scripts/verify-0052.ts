/**
 * Is the feedback layer actually live, and does it refuse what it says
 * it refuses?
 *
 * Deliberately writes nothing that survives. answer_feedback_events is
 * append-only history with no purge door, so a probe row would be
 * permanent: a fabricated record of an intervention that never happened,
 * sitting in the audit trail forever. Everything below is either a read
 * or an insert engineered to be REJECTED, which leaves no row behind.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}\n         ${detail}`); }
};

// 1. The tables exist and the worker can read them. This matters more
//    than it looks: loadRecallStore falls back to an empty store on
//    error, so a missing grant would degrade to "nothing was ever
//    learned" without saying so.
for (const t of ["answer_feedback_events", "semantic_mappings", "contextual_answers",
                 "ats_adapter_rules", "feedback_conflicts"]) {
  const { error, count } = await db.from(t).select("*", { count: "exact", head: true });
  check(`${t} exists and is readable by the worker`, !error, error?.message ?? "");
  if (!error) console.log(`         ${count} row(s)`);
}

const { data: metrics, error: viewErr } = await db.from("feedback_learning_metrics").select("*").single();
check("feedback_learning_metrics is queryable", !viewErr, viewErr?.message ?? "");
if (metrics) {
  check("the view reports automation and correction together",
    "fields_answered_automatically" in metrics && "corrections_to_filled_fields" in metrics
    && "open_conflicts" in metrics, JSON.stringify(Object.keys(metrics)));
}

// 2. The constraints, exercised by inserts that must fail. A rejected
//    insert writes nothing, so this leaves the tables as it found them.
const { data: anyApp } = await db.from("applications").select("id").limit(1).single();

const { error: notHuman } = await db.from("answer_feedback_events").insert({
  application_id: anyApp!.id, question_raw: "probe", question_normalized: "probe",
  confidence_before: "BLOCKED", why_stopped: "probe", human_answer: "probe",
  classification: "ONE_OFF", reuse_scope: "NONE", actor: "system:automation",
});
check("an intervention with a non-human actor is refused",
  Boolean(notHuman) && /feedback_actor_is_human/.test(notHuman!.message), notHuman?.message ?? "IT WAS ACCEPTED");

const { error: badClass } = await db.from("answer_feedback_events").insert({
  application_id: anyApp!.id, question_raw: "probe", question_normalized: "probe",
  confidence_before: "BLOCKED", why_stopped: "probe", human_answer: "probe",
  classification: "SOMETHING_ELSE", reuse_scope: "NONE", actor: "user:human_confirmed",
});
check("the classification set is closed", Boolean(badClass), badClass?.message ?? "IT WAS ACCEPTED");

const { error: unscoped } = await db.from("contextual_answers").insert({
  intent_key: "can_commute", answer: "Yes", scope: "NONE", conditions: {},
});
check("a contextual answer with no scope is refused",
  Boolean(unscoped) && /contextual_answer_has_a_scope/.test(unscoped!.message), unscoped?.message ?? "IT WAS ACCEPTED");

const { error: unconditioned } = await db.from("contextual_answers").insert({
  intent_key: "can_commute", answer: "Yes", scope: "LOCATION", conditions: { remotePolicy: "HYBRID" },
});
check("a location-scoped answer naming no location is refused",
  Boolean(unconditioned) && /contextual_answer_has_a_scope/.test(unconditioned!.message),
  unconditioned?.message ?? "IT WAS ACCEPTED");

const { error: badStatus } = await db.from("semantic_mappings").insert({
  normalized_question: "probe", intent_key: "probe", status: "TRUSTED",
});
check("a mapping status outside the closed set is refused", Boolean(badStatus), badStatus?.message ?? "IT WAS ACCEPTED");

const { error: unresolved } = await db.from("feedback_conflicts").insert({
  kind: "PROFILE_FACT", subject: "probe", existing: "a", incoming: "b", status: "RESOLVED",
});
check("a conflict cannot be marked resolved without naming who resolved it and how",
  Boolean(unresolved) && /resolution_names_a_person/.test(unresolved!.message), unresolved?.message ?? "IT WAS ACCEPTED");

// 3. Nothing above left a trace.
for (const t of ["answer_feedback_events", "contextual_answers", "semantic_mappings", "feedback_conflicts"]) {
  const { count } = await db.from(t).select("*", { count: "exact", head: true });
  check(`${t} still holds no probe rows`, count === 0, `${count} rows`);
}

console.log(`\n${pass + fails.length} checks, ${pass} passed`);
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log("0052 is live");
