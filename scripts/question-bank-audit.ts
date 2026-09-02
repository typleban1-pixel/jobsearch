/**
 * Does every stored answer claim only what its provenance entitles it to?
 *
 * Written because four EEO rows were resolving as VERIFIED while citing
 * no evidence, which the database refused and which stranded a whole
 * application. The interesting question was never those four rows: it
 * was whether anything else in the bank disagrees with itself the same
 * way. So this walks every row and prints what the resolver used to say
 * beside what it says now.
 *
 * Read-only. Nothing here writes, and nothing here invents an evidence
 * id to make a row satisfy a constraint.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { confidenceForBankedAnswer, type BankProvenance } from "../lib/applications/answer.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: rows, error } = await db.from("question_bank")
  .select("intent_key,category,approved_answer,answer_provenance,evidence_ids,reuse_allowed,sensitive,classification,source_application_id")
  .order("intent_key");
if (error) { console.error(error.message); process.exit(1); }

// What the resolver did before the fix: any banked answer that fit the
// control came back VERIFIED, whatever its provenance said.
const previously = (r: any) => (r.approved_answer === null ? "not resolved (no approved answer)" : "VERIFIED");

const pad = (s: string, n: number) => String(s ?? "").padEnd(n);
console.log(pad("intent key", 20), pad("provenance", 18), pad("class", 10), "ev", pad("  was", 8), pad("now", 16), "reuse");
console.log("-".repeat(94));

let disagreements = 0;
let corrected = 0;

for (const r of rows ?? []) {
  const n = (r.evidence_ids ?? []).length;
  const g = confidenceForBankedAnswer((r.answer_provenance ?? null) as BankProvenance | null, n);
  const now = "block" in g ? "BLOCKED" : g.confidence;
  const was = previously(r);
  if (now !== was) corrected++;
  // A row that still cannot be given at all is worth a human's attention
  // in a way that a corrected confidence is not.
  if ("block" in g) disagreements++;
  console.log(pad(r.intent_key, 20), pad(r.answer_provenance ?? "(none)", 18), pad(r.classification, 10),
    String(n).padStart(2), pad("  " + was, 8), pad(now, 16), r.reuse_allowed);
  if ("block" in g) console.log(pad("", 20), "^ ", g.block);
}

console.log(`\n${(rows ?? []).length} rows, ${corrected} whose resolved confidence changes, ${disagreements} that cannot be given as stored`);

// The specific thing the constraint cares about: a row that would be
// written VERIFIED or DERIVED with nothing to cite.
const wouldViolate = (rows ?? []).filter((r: any) => {
  const g = confidenceForBankedAnswer((r.answer_provenance ?? null) as BankProvenance | null, (r.evidence_ids ?? []).length);
  return !("block" in g) && (g.confidence === "VERIFIED" || g.confidence === "DERIVED") && (r.evidence_ids ?? []).length === 0;
});
console.log(wouldViolate.length === 0
  ? "no row would be written as a grounded state without citing evidence"
  : `WOULD STILL VIOLATE grounded_states_cite_evidence: ${wouldViolate.map((r: any) => r.intent_key).join(", ")}`);

// Sensitive rows are the ones that must never be inferred. Their only
// legitimate route is an explicit stored response.
// Nothing in the bank may trace back to a test application, and nothing
// may look like test text. A rehearsal once promoted a placeholder "No"
// to "Are you 18 years of age or older?" and it auto-filled a real
// application; this is the standing check that it has not happened again.
const { data: testApps } = await db.from("applications").select("id").eq("is_test", true);
const testIds = new Set((testApps ?? []).map((a: any) => a.id));
const PLACEHOLDER = /placeholder|rehearsal|not a real answer|lorem|dummy|test only/i;
const contaminated = (rows ?? []).filter((r: any) =>
  (r.source_application_id && testIds.has(r.source_application_id))
  || (r.approved_answer && PLACEHOLDER.test(r.approved_answer)));
console.log(contaminated.length === 0
  ? "no approved answer traces to a test application or reads as placeholder text"
  : `TEST DATA IN THE BANK: ${contaminated.map((r: any) => `${r.intent_key} = ${JSON.stringify(r.approved_answer)}`).join(", ")}`);

// A retracted row holds no answer, so there is nothing for it to have
// inferred. Only rows that could actually be given are checked.
const sensitive = (rows ?? []).filter((r: any) =>
  (r.sensitive || r.classification === "SENSITIVE") && r.approved_answer !== null);
const notUserGiven = sensitive.filter((r: any) => r.answer_provenance !== "USER_RESPONSE");
console.log(notUserGiven.length === 0
  ? `all ${sensitive.length} sensitive rows carry USER_RESPONSE, so none is inferred`
  : `SENSITIVE ROWS NOT FROM THE USER: ${notUserGiven.map((r: any) => `${r.intent_key} (${r.answer_provenance})`).join(", ")}`);

process.exit(wouldViolate.length === 0 && notUserGiven.length === 0 && contaminated.length === 0 ? 0 : 1);
