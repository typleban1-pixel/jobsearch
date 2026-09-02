/**
 * Records one human answer against a grouped blocked question.
 *
 *   node scripts/answer-question.ts --list
 *   node scripts/answer-question.ts --n 1 --answer "LinkedIn Jobs"
 *   node scripts/answer-question.ts --n 1 --answer "LinkedIn Jobs" --write
 *   node scripts/answer-question.ts --n 4 --blank --write
 *
 * The answer becomes HUMAN_CONFIRMED with USER_RESPONSE provenance,
 * because a person supplied it: it is not derived from evidence and must
 * never claim to be.
 *
 * Grouping is a reading convenience. Writing is per application, and an
 * answer is written to an application only when that employer's own
 * frozen snapshot lists that exact string. Anything else stays blocked
 * and keeps asking. Nothing is rewritten, approximated or substituted,
 * and no "close enough" option is ever chosen.
 *
 * Nothing here submits anything.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { loadBlockedGroups } from "../lib/portal/applyBoard.ts";
import { applicabilityFor } from "../lib/portal/questionGroups.ts";

const argv = process.argv;
const arg = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i > 0 && argv[i + 1] ? argv[i + 1]! : null;
};
const list = argv.includes("--list");
const write = argv.includes("--write");
const blank = argv.includes("--blank");
const n = Number(arg("--n") ?? NaN);
const answer = arg("--answer") ?? "";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const groups = await loadBlockedGroups(db);

if (list || Number.isNaN(n)) {
  groups.forEach((g, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${g.category}] ${String(g.label).replace(/\s+/g, " ").slice(0, 82)}`);
    console.log(`    ${g.fields.length} application(s)${g.required ? ", REQUIRED" : ""}`
      + `${g.options.length ? `, ${g.options.length} choices` : ", free text"}`
      + `${g.optionsVary ? " (choices differ between them)" : ""}`);
  });
  console.log(`\n${groups.length} questions`);
  process.exit(0);
}

const g = groups[n - 1];
if (!g) { console.error(`no question ${n}; there are ${groups.length}`); process.exit(2); }
if (!blank && !answer) { console.error("give --answer \"...\" or --blank"); process.exit(2); }

console.log(`Q${n}. ${g.label}`);
console.log(`applies to ${g.fields.length} application(s):`);
for (const f of g.fields) console.log(`  ${f.applicationLabel}`);

// Blank is a real answer: declining is not choosing a value, so it needs
// no option to exist and applies everywhere in the group.
const { compatible, incompatible } = blank
  ? { compatible: g.fields, incompatible: [] as typeof g.fields }
  : applicabilityFor(g, answer);

if (!blank && compatible.length === 0) {
  console.error(`\nREFUSED: "${answer}" is not offered by any of these forms.`);
  console.error(`Choices: ${g.options.join(" | ")}`);
  process.exit(1);
}

console.log(`\nanswer: ${blank ? "(left blank)" : JSON.stringify(answer)}`);
console.log(`  writes to ${compatible.length}: ${compatible.map((f) => f.applicationLabel.split(" — ")[0]).join(", ")}`);
if (incompatible.length) {
  console.log(`  STAYS BLOCKED on ${incompatible.length}, this form does not offer that choice:`);
  for (const f of incompatible) console.log(`    ${f.applicationLabel}`);
}
if (!write) { console.log("\ndry run. Pass --write to record."); process.exit(0); }

// The answer rows behind the compatible fields.
const { data: rows } = await db.from("application_answers")
  .select("id,application_id,field_key,confidence_state")
  .in("application_id", compatible.map((f) => f.applicationId));

const now = new Date().toISOString();
let written = 0;
let primaryId: string | null = null;
let primaryApp: string | null = null;

for (const f of compatible) {
  const row = (rows ?? []).find((r: any) => r.application_id === f.applicationId && r.field_key === f.fieldKey);
  if (!row) { console.log(`  (no answer row for ${f.applicationLabel}, skipped)`); continue; }
  if (row.confidence_state !== "BLOCKED") { console.log(`  (${f.applicationLabel} is no longer blocked, skipped)`); continue; }

  const isPrimary = primaryId === null;
  const { error } = await db.from("application_answers").update({
    answer_text: blank ? null : answer,
    confidence_state: "HUMAN_CONFIRMED",
    provenance: "USER_RESPONSE",
    block_kind: null,
    blocked_reason: null,
    resolved_at: now,
    // The record says the answer was given once and applied to several
    // forms because the reader said so, rather than showing several
    // answers that merely agree.
    ...(isPrimary ? {} : {
      considered_evidence: [{
        kind: "DELIBERATE_REUSE",
        reusedFromAnswerId: primaryId,
        reusedFromApplicationId: primaryApp,
        chosenAt: now,
        note: "You gave this answer once for a question these employers ask identically. "
          + "It was written here because this employer's own form offers that exact choice.",
      }],
    }),
  }).eq("id", row.id);

  if (error) { console.log(`  FAILED ${f.applicationLabel}: ${error.message}`); continue; }
  if (isPrimary) { primaryId = row.id; primaryApp = row.application_id; }
  written++;
}

// An application whose last block just cleared is ready to be read. The
// employer-form handoffs are deliberately untouched by this: they are
// not blocked on questions.
for (const f of compatible) {
  const { data: still } = await db.from("application_answers")
    .select("id").eq("application_id", f.applicationId).eq("confidence_state", "BLOCKED").limit(1);
  if (still?.length) continue;
  const { data: app } = await db.from("applications")
    .select("status,blocked_reason").eq("id", f.applicationId).single();
  if (app?.status !== "BLOCKED_NEEDS_INPUT") continue;
  if (/HANDOFF/i.test(String(app.blocked_reason ?? ""))) continue;
  await db.from("applications").update({ status: "AWAITING_REVIEW" }).eq("id", f.applicationId);
  console.log(`  ${f.applicationLabel}: all questions answered, now AWAITING_REVIEW`);
}

console.log(`\nrecorded on ${written} application(s) as HUMAN_CONFIRMED.`);
if (incompatible.length) console.log(`${incompatible.length} still blocked and still asking.`);
