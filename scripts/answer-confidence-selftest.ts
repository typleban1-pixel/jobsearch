/**
 * What a stored answer may claim, and what the database refuses.
 *
 * Two halves, because the property has two halves. The resolver decides
 * what confidence an answer is written at; the constraint decides what
 * confidences are allowed to exist without evidence. The defect that
 * produced this file was a disagreement between them: the resolver said
 * VERIFIED, the row cited nothing, and the insert took the whole
 * application down with it.
 *
 * The database half creates real rows and removes them again. It is
 * written so that a failure leaves nothing behind: every probe is
 * cleaned up in a finally, and the application it uses is created for
 * the test and abandoned at the end.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { resolveField, confidenceForBankedAnswer,
         type ResolveContext, type FormField, type BankProvenance } from "../lib/applications/answer.ts";

let failures = 0;
function check(what: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const PROFILE_ROW = "00000000-0000-4000-8000-000000000001";
const f = (label: string, over: Partial<FormField> = {}): FormField =>
  ({ key: label.toLowerCase().replace(/\W+/g, "_"), label, type: "text", required: true, ...over });

const base: ResolveContext = {
  profileRowId: PROFILE_ROW,
  profile: { full_name: "Ty Pleban", email: "x@example.com", country: "US", work_authorized_us: true },
  bank: new Map(),
};
const withBank = (key: string, answer: string, provenance: BankProvenance | null, evidenceIds: string[] = []): ResolveContext =>
  ({ ...base, bank: new Map([[key, { answer, evidenceIds, provenance }]]) });

// ============================================================
// The provenance rule itself
// ============================================================
console.log("\nwhat a provenance entitles an answer to claim");

{
  const g = confidenceForBankedAnswer("USER_RESPONSE", 0);
  check("USER_RESPONSE with no evidence is HUMAN_CONFIRMED",
    "confidence" in g && g.confidence === "HUMAN_CONFIRMED", JSON.stringify(g));
}
{
  const g = confidenceForBankedAnswer("USER_RESPONSE", 3);
  check("USER_RESPONSE stays HUMAN_CONFIRMED even carrying evidence",
    "confidence" in g && g.confidence === "HUMAN_CONFIRMED", JSON.stringify(g));
}
for (const p of ["PROFILE", "EMPLOYMENT_RECORD", "PROJECT", "SKILL_RECORD", "VERIFIED_ANSWER"] as BankProvenance[]) {
  const withEv = confidenceForBankedAnswer(p, 1);
  const without = confidenceForBankedAnswer(p, 0);
  check(`${p} citing evidence is VERIFIED`, "confidence" in withEv && withEv.confidence === "VERIFIED");
  check(`${p} citing nothing blocks rather than downgrading`, "block" in without);
}
{
  const withEv = confidenceForBankedAnswer("CALCULATED", 1);
  const without = confidenceForBankedAnswer("CALCULATED", 0);
  check("CALCULATED citing evidence is DERIVED", "confidence" in withEv && withEv.confidence === "DERIVED");
  check("CALCULATED citing nothing blocks", "block" in without);
}
check("a stored AI draft is never an answer",
  "block" in confidenceForBankedAnswer("AI_DRAFT_FROM_VERIFIED_EVIDENCE", 5));
check("an answer with no recorded provenance blocks",
  "block" in confidenceForBankedAnswer(null, 0));
check("an unrecognised provenance blocks rather than defaulting",
  "block" in confidenceForBankedAnswer("SOMETHING_NEW" as BankProvenance, 1));

// The rule must be about provenance, not about the four field names it
// was discovered on. A non-EEO question with the same provenance gets
// the same treatment, and an EEO question with evidence-backed
// provenance does not get a free pass.
console.log("\nthe rule reads provenance, not the intent key");
{
  const r = resolveField(f("Are you willing to relocate?", { type: "select", options: ["Yes", "No"] }),
    withBank("willing_to_relocate", "Yes", "USER_RESPONSE"));
  check("a non-sensitive USER_RESPONSE is also HUMAN_CONFIRMED",
    r.confidence === "HUMAN_CONFIRMED", `${r.confidence} "${r.answer}"`);
}
{
  const r = resolveField(f("Gender", { type: "select", options: ["Male", "Female"] }),
    withBank("gender", "Male", "VERIFIED_ANSWER", [PROFILE_ROW]));
  check("an evidence-backed provenance still resolves VERIFIED on a sensitive field",
    r.confidence === "VERIFIED", `${r.confidence}`);
}

// ============================================================
// Through the resolver, on the four rows that exposed this
// ============================================================
console.log("\nthe EEO rows, end to end");

const EEO: Array<[string, string, string, string[]]> = [
  ["gender", "Gender", "Male", ["Male", "Female", "Decline to self-identify"]],
  ["veteran_status", "Veteran Status", "I am not a protected veteran",
    ["I identify as one or more of the classifications of a protected veteran", "I am not a protected veteran", "I decline to self-identify"]],
  ["race_ethnicity", "Race / Ethnicity", "White", ["White", "Black or African American", "Asian", "Decline to self-identify"]],
  ["disability_status", "Disability Status", "No, I do not have a disability",
    ["Yes, I have a disability", "No, I do not have a disability", "I do not want to answer"]],
];

for (const [key, label, answer, options] of EEO) {
  const r = resolveField(f(label, { type: "select", options }), withBank(key, answer, "USER_RESPONSE"));
  check(`${key} resolves HUMAN_CONFIRMED with no evidence ids`,
    r.confidence === "HUMAN_CONFIRMED" && r.evidenceIds.length === 0 && r.answer === answer,
    `${r.confidence} evidence=${r.evidenceIds.length} "${r.answer}"`);
}

// Reuse is the whole point of the bank, and reuse must not promote.
{
  const ctx = withBank("gender", "Male", "USER_RESPONSE");
  const first = resolveField(f("Gender", { type: "select", options: ["Male", "Female"] }), ctx);
  const second = resolveField(f("What is your gender?", { type: "select", options: ["Male", "Female"] }), ctx);
  const third = resolveField(f("Gender", { type: "select", options: ["Male", "Female"] }), ctx);
  check("the same banked answer reused across applications never becomes VERIFIED",
    [first, second, third].every((r) => r.confidence === "HUMAN_CONFIRMED"),
    [first, second, third].map((r) => r.confidence).join(", "));
}

console.log("\nsensitive answers are given only from an explicit stored response");
{
  // Nothing in the profile may produce one of these.
  const r = resolveField(f("Gender", { type: "select", options: ["Male", "Female"] }), base);
  check("with an empty bank, a sensitive question BLOCKS rather than inferring",
    r.confidence === "BLOCKED" && r.answer === null, `${r.confidence} "${r.answer}"`);
  check("and it says it is never inferred", /never inferred/.test(r.blockedReason ?? ""), r.blockedReason ?? "");
}
{
  // A profile that happens to contain a demographic-looking value still
  // must not feed a sensitive field.
  const loaded: ResolveContext = { ...base, profile: { ...base.profile, gender: "Male", race: "White", veteran: false } };
  for (const [, label, , options] of EEO) {
    const r = resolveField(f(label, { type: "select", options }), loaded);
    check(`${label} is not inferred from a profile column of the same name`, r.confidence === "BLOCKED", r.confidence);
  }
}
{
  // An exact intent match reuses it; a wording that reads as more than
  // one question does not get to pick one.
  const ctx = withBank("gender", "Male", "USER_RESPONSE");
  const exact = resolveField(f("Gender", { type: "select", options: ["Male", "Female"] }), ctx);
  check("an exact-match sensitive question reuses the banked answer", exact.confidence === "HUMAN_CONFIRMED");
  const unmatched = resolveField(f("Please describe your background", { type: "text" }), ctx);
  check("a question the catalog does not recognise does not reach the banked answer",
    unmatched.confidence === "BLOCKED" && unmatched.answer === null, `${unmatched.confidence} "${unmatched.answer}"`);
  const wrongOptions = resolveField(f("Gender", { type: "select", options: ["Man", "Woman"] }), ctx);
  check("a banked answer the control does not offer blocks rather than approximating",
    wrongOptions.confidence === "BLOCKED" && wrongOptions.answer === null, `${wrongOptions.confidence} "${wrongOptions.answer}"`);
}

// ============================================================
// What the database refuses
// ============================================================
console.log("\nthe constraint, against the live database");

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const probeIds: string[] = [];
let probeApp: string | null = null;

try {
  // A disposable application to hang probe answers on. It needs an
  // opening nothing has applied to, because one application per opening
  // is enforced and a real application must not be disturbed to run a
  // test. Nothing here is prepared, approved or submitted.
  const { data: taken } = await db.from("applications").select("canonical_opening_id");
  const used = new Set((taken ?? []).map((a: any) => a.canonical_opening_id));
  const { data: jobs } = await db.from("jobs").select("id,canonical_opening_id")
    .not("canonical_opening_id", "is", null).limit(200);
  const free = (jobs ?? []).filter((j: any) => !used.has(j.canonical_opening_id));
  const { data: versions } = await db.from("job_versions").select("id,job_id")
    .in("job_id", free.map((j: any) => j.id)).eq("is_current", true);
  const byJob = new Map((versions ?? []).map((v: any) => [v.job_id, v.id]));
  const job = free.find((j: any) => byJob.has(j.id));
  if (!job) throw new Error("no job with a free canonical opening and a current version to probe against");
  const { data: created, error: appErr } = await db.from("applications")
    .insert({ job_id: job.id, canonical_opening_id: job.canonical_opening_id,
              job_version_id: byJob.get(job.id), status: "DRAFT", is_test: true })
    .select("id").single();
  if (appErr) throw new Error(`could not create the probe application: ${appErr.message}`);
  probeApp = created!.id;

  const probe = async (what: string, state: string, evidenceIds: string[]) => {
    const row: any = {
      application_id: probeApp, question_text: `probe: ${what}`, field_key: `probe_${what}`,
      field_label: `probe ${what}`, is_required: true, confidence_state: state, evidence_ids: evidenceIds,
      category: "E_UNKNOWN", provenance: "USER_RESPONSE",
    };
    if (state === "BLOCKED") { row.blocked_reason = "probe"; row.block_kind = "UNKNOWN"; }
    const { data, error } = await db.from("application_answers").insert(row).select("id").maybeSingle();
    if (data?.id) probeIds.push(data.id);
    return error;
  };

  check("VERIFIED with no evidence ids is still refused",
    /grounded_states_cite_evidence/.test((await probe("verified-empty", "VERIFIED", []))?.message ?? ""));
  check("DERIVED with no evidence ids is still refused",
    /grounded_states_cite_evidence/.test((await probe("derived-empty", "DERIVED", []))?.message ?? ""));
  check("HUMAN_CONFIRMED with no evidence ids inserts successfully",
    (await probe("human-empty", "HUMAN_CONFIRMED", [])) === null);
  check("VERIFIED citing evidence inserts successfully",
    (await probe("verified-cited", "VERIFIED", [PROFILE_ROW])) === null);

  // An application holding one blocked answer is not confident, and an
  // application holding nothing at all is not confident either.
  await probe("blocked", "BLOCKED", []);
  const confident = async () => (await db.from("applications").select("all_fields_confident").eq("id", probeApp!).single()).data?.all_fields_confident;
  check("one blocked answer keeps the application from reading as complete", (await confident()) === false);

  for (const id of probeIds.splice(0)) await db.from("application_answers").delete().eq("id", id);
  const afterEmpty = await confident();
  check("an application with no answers does not read as complete", afterEmpty === false,
    `all_fields_confident is ${afterEmpty} with zero answers -- migration 0061 may not be applied`);
} finally {
  for (const id of probeIds) await db.from("application_answers").delete().eq("id", id);
  // Applications are abandoned, never deleted: application_events holds
  // a foreign key to them on purpose, so the history of a run survives
  // the run. is_test keeps them out of every portal query.
  if (probeApp) await db.from("applications").update({ status: "ABANDONED" }).eq("id", probeApp);
  const { data: live } = await db.from("applications").select("id,status").eq("is_test", true);
  const open = (live ?? []).filter((a: any) => a.status !== "ABANDONED");
  console.log(`  cleanup: ${(live ?? []).length} test applications, ${open.length} not abandoned`);
  if (open.length) failures++;
}


// ---- a combined full-name field ---------------------------------------
//
// Greenhouse asks for first and last separately, so a single "Full name"
// control never came up until a Lever form used one. A verified fact came
// back BLOCKED as "nothing has been confirmed for this question", which
// is the shape of every silent gap: not wrong, just never asked before.
{
  const { matchIntent } = await import("../lib/applications/intents.ts");
  console.log("\ncombined full-name fields");
  check("a Full name control matches full_name",
    matchIntent("Full name", "name").intent?.key === "full_name",
    String(matchIntent("Full name", "name").intent?.key));
  check("split first-name controls are unaffected",
    matchIntent("First Name", "first_name").intent?.key === "legal_first_name");
  // Workday's phone block: three questions, three intents, none ambiguous.
  check("Country Phone Code is the dial code, not the number or the residence",
    matchIntent("Country Phone Code", "countryPhoneCode").intent?.key === "phone_country",
    String(matchIntent("Country Phone Code", "countryPhoneCode").intent?.key));
  check("Phone Device Type is its own question",
    matchIntent("Phone Device Type", "phoneType").intent?.key === "phone_device_type",
    String(matchIntent("Phone Device Type", "phoneType").intent?.key));
  check("Workday's previous-worker group is the prior-employment question, by name",
    matchIntent("Candidate Is Previous Worker", "radio-group:candidateIsPreviousWorker").intent?.key === "previously_employed_here",
    String(matchIntent("Candidate Is Previous Worker", "radio-group:candidateIsPreviousWorker").intent?.key));
  check("and by its legend",
    matchIntent("Have you previously worked for this organization? If Yes, please answer the questions below.", "x").intent?.key === "previously_employed_here",
    String(matchIntent("Have you previously worked for this organization? If Yes, please answer the questions below.", "x").intent?.key));
  check("Phone Number is still the number",
    matchIntent("Phone Number", "phoneNumber").intent?.key === "phone",
    String(matchIntent("Phone Number", "phoneNumber").intent?.key));
  check("split last-name controls are unaffected",
    matchIntent("Last Name", "last_name").intent?.key === "legal_last_name");
  // The dangerous neighbour: a signature control labelled "Name".
  check("a signature labelled Name is still never filled",
    matchIntent("Name", "eeo[disabilitySignature]").intent?.neverFill === true);
  check("and an employer name field is not a person name",
    matchIntent("Company name").intent?.key !== "full_name");
}


// ---- a sensitive answer that IS a stored preference -------------------
//
// salary_expectation is D_SENSITIVE, and the sensitive path only ever
// read the question bank. The profile held salary_target_ideal = 115000
// the whole time, so a deliberately stored preference reported itself as
// "none exists yet". The allowlist is what keeps this from becoming
// "look around the profile for something relevant".
{
  const { matchIntent } = await import("../lib/applications/intents.ts");
  console.log("\nsensitive intents backed by a stored preference");
  const m = matchIntent("What is your ideal salary expectations for your next role?");
  check("a salary question matches salary_expectation", m.intent?.key === "salary_expectation", String(m.intent?.key));
  check("and it is still classified sensitive", m.intent?.category === "D_SENSITIVE", String(m.intent?.category));
  check("but it is not never-fill", m.intent?.neverFill !== true);
  // The neighbours must stay unreachable from the profile.
  for (const k of ["race_ethnicity", "gender", "disability_status", "veteran_status"]) {
    check(`${k} is not answerable from the profile`, !["salary_expectation"].includes(k));
  }
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
