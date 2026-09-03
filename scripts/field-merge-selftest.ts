/**
 * Rediscovery must not erase what was answered.
 *
 *   node scripts/field-merge-selftest.ts
 *
 * Discovery deleted every answer row and re-inserted from the DOM, so
 * each pass over the Northern Trust form reset fields already resolved.
 * A VERIFIED answer can be regenerated; a HUMAN_CONFIRMED one cannot --
 * it came from a person, and deleting it throws away the only kind of
 * answer this system cannot reproduce.
 *
 * Every case below is a real field from that application.
 */
import { mergeDiscovery, materialChanges, summarise,
         type StoredField, type DiscoveredField } from "../lib/applications/fieldMerge.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};

const S = (q: string, answer: string | null, conf: string, over: Partial<StoredField> = {}): StoredField => ({
  field_key: q.toLowerCase().replace(/\W+/g, "_"), question_text: q, is_required: false,
  options: null, answer_text: answer, confidence_state: conf, category: "A_VERIFIED_FACT",
  provenance: "PROFILE", block_kind: null, blocked_reason: null, evidence_ids: ["ev1"], ...over,
});
const D = (q: string, over: Partial<DiscoveredField> = {}): DiscoveredField => ({
  field_key: q.toLowerCase().replace(/\W+/g, "_"), question_text: q, is_required: false,
  options: null, ...over,
});

// The application as it actually stands.
const STORED: StoredField[] = [
  S("First Name", "Tyler", "VERIFIED", { is_required: true }),
  S("Last Name", "Pleban", "VERIFIED", { is_required: true }),
  S("Address Line 1", "740 W. Superior Ave #609", "VERIFIED", { is_required: true }),
  S("City", "Cleveland", "VERIFIED", { is_required: true }),
  S("Postal Code", "44113", "VERIFIED", { is_required: true }),
  S("I have a preferred name", "Yes", "HUMAN_CONFIRMED", { provenance: "USER_RESPONSE" }),
  S("Country Phone Code", "United States of America (+1)", "HUMAN_CONFIRMED",
    { is_required: true, provenance: "USER_RESPONSE", options: ["United States of America (+1)"] }),
  S("Yes", "No", "HUMAN_CONFIRMED", { provenance: "USER_RESPONSE", options: ["Yes", "No"] }),
  S("How Did You Hear About Us?", "Northern Trust Web Site", "HUMAN_CONFIRMED",
    { is_required: true, provenance: "USER_RESPONSE",
      options: ["Career Fair", "Job Board", "Newspapers", "Northern Trust Web Site"] }),
];
const find = (r: any[], q: string) => r.find((x) => x.field.question_text === q);

console.log("\n1. rediscovering the same page preserves every answer:");
{
  const found = STORED.map((s) => D(s.question_text, { is_required: s.is_required, options: s.options }));
  const r = mergeDiscovery(STORED, found);
  check("nothing is dropped", r.length === STORED.length, `${r.length}`);
  check("every field is PRESERVED", summarise(r).PRESERVED === STORED.length, JSON.stringify(summarise(r)));
  check("Tyler survives", find(r, "First Name").field.answer_text === "Tyler");
  check("Pleban survives", find(r, "Last Name").field.answer_text === "Pleban");
  check("the verified address survives", find(r, "Address Line 1").field.answer_text === "740 W. Superior Ave #609");
  check("City and Postal Code survive",
    find(r, "City").field.answer_text === "Cleveland" && find(r, "Postal Code").field.answer_text === "44113");
  check("confidence is not downgraded", find(r, "First Name").field.confidence_state === "VERIFIED");
  check("evidence ids survive", JSON.stringify(find(r, "First Name").field.evidence_ids) === '["ev1"]');
}

console.log("\n2. the HUMAN_CONFIRMED answers survive, which is the point:");
{
  const found = STORED.map((s) => D(s.question_text, { is_required: s.is_required, options: s.options }));
  const r = mergeDiscovery(STORED, found);
  const pref = find(r, "I have a preferred name").field;
  check("preferred name stays Yes", pref.answer_text === "Yes");
  check("and stays HUMAN_CONFIRMED", pref.confidence_state === "HUMAN_CONFIRMED");
  const pc = find(r, "Country Phone Code").field;
  check("the +1 phone code stays", pc.answer_text === "United States of America (+1)");
  check("and stays HUMAN_CONFIRMED", pc.confidence_state === "HUMAN_CONFIRMED");
  const prior = find(r, "Yes").field;
  check("Northern Trust prior employment stays No", prior.answer_text === "No");
  check("and stays HUMAN_CONFIRMED", prior.confidence_state === "HUMAN_CONFIRMED");
  const src = find(r, "How Did You Hear About Us?").field;
  check("the referral source stays", src.answer_text === "Northern Trust Web Site");
  check("and stays HUMAN_CONFIRMED", src.confidence_state === "HUMAN_CONFIRMED");
  check("their provenance is still USER_RESPONSE", src.provenance === "USER_RESPONSE");
}

console.log("\n3. a newly revealed field is added without disturbing the rest:");
{
  const found = [...STORED.map((s) => D(s.question_text, { is_required: s.is_required, options: s.options })),
    D("Phone Number", { is_required: true })];
  const r = mergeDiscovery(STORED, found);
  const t = summarise(r);
  check("one ADDED, the rest PRESERVED", t.ADDED === 1 && t.PRESERVED === STORED.length, JSON.stringify(t));
  const added = find(r, "Phone Number").field;
  check("the new field arrives BLOCKED, not answered", added.confidence_state === "BLOCKED" && added.answer_text === null);
  check("and existing answers are untouched", find(r, "First Name").field.answer_text === "Tyler");
}

console.log("\n4. a materially changed field does NOT inherit the old answer:");
{
  // Same key, different question. This is the case that must fail closed.
  const changed = D("How Did You Hear About Us?", { is_required: true,
    options: ["Career Fair", "Job Board", "Newspapers", "LinkedIn"] });   // "Northern Trust Web Site" gone
  const r = mergeDiscovery(STORED, [changed]);
  const f = find(r, "How Did You Hear About Us?");
  check("it is flagged RECONCILE", f.action === "RECONCILE", f.action);
  check("the old answer is NOT carried over", f.field.answer_text === null, String(f.field.answer_text));
  check("it is BLOCKED", f.field.confidence_state === "BLOCKED");
  check("as AMBIGUOUS, needing a person", f.field.block_kind === "AMBIGUOUS");
  check("the reason names what changed", /available choices/.test(f.field.blocked_reason ?? ""), f.field.blocked_reason ?? "");
  check("and quotes the answer that was set aside",
    /Northern Trust Web Site/.test(f.field.blocked_reason ?? ""), f.field.blocked_reason ?? "");
  // Each axis independently.
  check("changed wording alone triggers it",
    materialChanges(STORED[0]!, D("First Name", { question_text: "Legal First Name", is_required: true })).includes("question text"));
  check("changed required status alone triggers it",
    materialChanges(STORED[0]!, D("First Name", { is_required: false })).includes("required status"));
  check("unchanged is unchanged",
    materialChanges(STORED[0]!, D("First Name", { is_required: true })).length === 0);
}

console.log("\n5. earlier steps survive a later step's discovery:");
{
  // Page 2's DOM contains none of page 1's fields. A delete-and-recreate
  // here would discard the entire first page.
  const page2 = [D("Work Experience 1 - Job Title", { is_required: true }),
                 D("Work Experience 1 - Company", { is_required: true })];
  const r = mergeDiscovery(STORED, page2);
  const t = summarise(r);
  check("every page-1 field is retained", t.RETAINED_OFFPAGE === STORED.length, JSON.stringify(t));
  check("both page-2 fields are added", t.ADDED === 2);
  check("nothing was reconciled or lost", t.RECONCILE === 0 && r.length === STORED.length + 2);
  check("Tyler is still there after moving to page 2", find(r, "First Name").field.answer_text === "Tyler");
  check("and so is the confirmed phone code",
    find(r, "Country Phone Code").field.answer_text === "United States of America (+1)");
}

console.log("\n6. identity is the key, then the question text:");
{
  const stored = [S("Q", "a", "VERIFIED", { field_key: "k1" })];
  check("the same key matches even if wording is cosmetically identical",
    mergeDiscovery(stored, [D("Q", { field_key: "k1" })])[0]!.action === "PRESERVED");
  check("a different key is a different field",
    summarise(mergeDiscovery(stored, [D("Q", { field_key: "k2" })])).ADDED === 1);
  const noKey = [{ ...S("Q", "a", "VERIFIED"), field_key: null }];
  check("with no key, the question text identifies it",
    mergeDiscovery(noKey, [{ field_key: null, question_text: "Q", is_required: false, options: null }])[0]!.action === "PRESERVED");
}

console.log("\n7. nothing is ever deleted:");
{
  const r = mergeDiscovery(STORED, []);
  check("an empty discovery retains everything", r.length === STORED.length);
  check("all as RETAINED_OFFPAGE", summarise(r).RETAINED_OFFPAGE === STORED.length);
  check("with their answers intact", find(r, "First Name").field.answer_text === "Tyler");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("rediscovery adds and preserves; it never erases");
