/**
 * That 0062 and 0063 are actually in force.
 *
 * Every check probes behaviour rather than reading a catalog: a column
 * that exists but whose constraint was not applied would pass a schema
 * query and fail the thing the constraint is for.
 *
 * Read-mostly. The rows it writes are removed in a finally.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { PERSONAL_FACT_INTENTS } from "../lib/feedback/classify.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};
const refused = (e: { message: string } | null, pattern: RegExp) => Boolean(e && pattern.test(e.message));

const made: Array<[string, string]> = [];
const cleanup = async () => { for (const [t, id] of made.reverse()) await db.from(t).delete().eq("id", id); };

try {
  // ---- 0062: the two enum values -------------------------------------
  console.log("\n0062, the new enum values");
  {
    const { error } = await db.from("contextual_answers").insert({
      intent_key: null, normalized_question: "verify 0062 probe", answer: "Yes", scope: "QUESTION",
    }).select("id").single();
    check("feedback_reuse_scope accepts QUESTION", !error, error?.message);
    if (!error) {
      const { data } = await db.from("contextual_answers").select("id").eq("normalized_question", "verify 0062 probe").maybeSingle();
      if (data) made.push(["contextual_answers", data.id]);
    }
  }

  // ---- 0063: keying rules --------------------------------------------
  console.log("\n0063, a reusable answer must be keyed on something");
  {
    const { error } = await db.from("contextual_answers").insert({
      intent_key: null, normalized_question: null, answer: "Yes", scope: "QUESTION",
    });
    check("a row keyed on neither an intent nor a question is refused",
      refused(error, /contextual_answer_has_a_scope/), error?.message ?? "it was accepted");
  }
  {
    const { error } = await db.from("contextual_answers").insert({
      intent_key: "can_commute", normalized_question: null, answer: "Yes", scope: "QUESTION",
    });
    check("a QUESTION-scoped row with no wording is refused",
      refused(error, /contextual_answer_has_a_scope/), error?.message ?? "it was accepted");
  }
  {
    const { error } = await db.from("contextual_answers").insert({
      intent_key: "can_commute", answer: "Yes", scope: "LOCATION", conditions: {},
    });
    check("a LOCATION-scoped row with no location is still refused",
      refused(error, /contextual_answer_has_a_scope/), error?.message ?? "it was accepted");
  }
  {
    const { error } = await db.from("contextual_answers").insert({
      intent_key: "can_commute", answer: "Yes", scope: "NONE", conditions: { locationCity: "Chicago" },
    });
    check("a NONE-scoped row is still refused", refused(error, /contextual_answer_has_a_scope/),
      error?.message ?? "it was accepted");
  }

  // ---- 0063: new columns ---------------------------------------------
  console.log("\n0063, the new columns");
  for (const [table, cols] of [
    ["question_bank", "source_application_id,source_answer_id,source_event_id,source_question_raw"],
    ["answer_feedback_events", "resulting_question_bank_id"],
    ["application_answers", "promoted_event_id"],
    ["contextual_answers", "normalized_question"],
  ] as const) {
    const { error } = await db.from(table).select(cols).limit(1);
    check(`${table} has ${cols}`, !error, error?.message);
  }

  console.log("\n0063, conflicts can name a bank answer");
  {
    const { data, error } = await db.from("feedback_conflicts").insert({
      kind: "BANK_ANSWER", subject: "verify probe", existing: "a", incoming: "b", status: "OPEN",
    }).select("id").single();
    check("feedback_conflicts accepts BANK_ANSWER", !error, error?.message);
    if (data) made.push(["feedback_conflicts", data.id]);
  }
  {
    const { error } = await db.from("feedback_conflicts").insert({
      kind: "NOT_A_KIND", subject: "verify probe", existing: "a", incoming: "b", status: "OPEN",
    });
    check("and still refuses a kind it does not know", refused(error, /kind_check/), error?.message ?? "accepted");
  }

  // ---- the map that would have thrown --------------------------------
  console.log("\nevery promotable profile column exists");
  {
    const { data } = await db.from("profile").select("*").eq("singleton", true).maybeSingle();
    const cols = new Set(Object.keys(data ?? {}));
    for (const [intent, column] of Object.entries(PERSONAL_FACT_INTENTS)) {
      check(`${intent} -> profile.${column}`, cols.has(column),
        "this column does not exist, so promoting this intent would throw");
    }
  }
} finally {
  await cleanup();
  const { count } = await db.from("contextual_answers").select("*", { count: "exact", head: true });
  console.log(`\n  cleanup: ${count ?? 0} contextual answers remain`);
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
