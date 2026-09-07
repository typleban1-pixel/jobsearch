/**
 * The lifecycle of an answer the profile could not supply.
 *
 * unknown question -> BLOCKED -> shown verbatim -> answered -> stored as
 * HUMAN_CONFIRMED/USER_RESPONSE -> promoted only if asked -> reused only
 * where the question is the same question.
 *
 * The last clause is the one worth testing hardest. "Do you have 5+
 * years of SEO experience?" and "Do you have SEO experience?" are
 * different propositions, and a system that answers the first from the
 * second has invented a duration nobody confirmed. Several cases below
 * exist only to prove that does not happen.
 *
 * Pure functions throughout: classification, learning and recall are
 * decisions over a snapshot, so the whole lifecycle can be run offline
 * without touching the database.
 */
import { classifyFeedback, normalizeQuestion } from "../lib/feedback/classify.ts";
import { learnFromFeedback, type BeliefSnapshot } from "../lib/feedback/learn.ts";
import { recallAnswer } from "../lib/feedback/recall.ts";
import { mayCarry, reconcileAnswers, type ExistingAnswer } from "../lib/applications/reconcile.ts";
import { resolveField, type ResolveContext, type FormField, type ResolvedField } from "../lib/applications/answer.ts";
import type { ContextualAnswer, FeedbackEvent } from "../lib/feedback/types.ts";

let failures = 0;
function check(what: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const SEO = "Do you have 5+ years of SEO experience?";
const SEO_GENERIC = "Do you have SEO experience?";
const PROFILE_ROW = "00000000-0000-4000-8000-000000000001";

const f = (label: string, over: Partial<FormField> = {}): FormField =>
  ({ key: label.toLowerCase().replace(/\W+/g, "_").slice(0, 40), label, type: "text", required: true, ...over });

const event = (over: Partial<FeedbackEvent> = {}): FeedbackEvent => ({
  applicationId: "app-1", jobId: "job-1", canonicalOpeningId: null,
  employer: "Acme", provider: "GREENHOUSE",
  questionRaw: SEO, questionNormalized: normalizeQuestion(SEO), providerFieldKey: "seo_years",
  intentBefore: null, confidenceBefore: "BLOCKED", whyStopped: "not in the catalog",
  proposedAnswer: null, humanAnswer: "Yes", intentConfirmed: null,
  conditions: {}, occurredAt: new Date().toISOString(), ...over,
});

const snapshot = (over: Partial<BeliefSnapshot> = {}): BeliefSnapshot => ({
  profile: {}, verifiedFields: new Set(), mappings: [], contextual: [], adapters: [], bank: [], ...over,
});

const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  profileRowId: PROFILE_ROW,
  profile: { legal_first_name: "Ty", legal_last_name: "Pleban", email_job_search: "x@example.com", country: "US" },
  bank: new Map(), ...over,
});

const stored = (over: Partial<ContextualAnswer> = {}): ContextualAnswer => ({
  id: "c-seo", intentKey: null, normalizedQuestion: normalizeQuestion(SEO),
  answer: "Yes", scope: "QUESTION", conditions: {},
  employer: null, provider: null, jobId: null,
  expiresAt: null, confirmations: 1, fromEventIds: ["ev-1"], ...over,
});

// ============================================================
console.log("\n1. an unknown question stops and asks");

{
  const r = resolveField(f(SEO), ctx());
  check("an unknown non-sensitive question is BLOCKED", r.confidence === "BLOCKED" && r.answer === null, r.confidence);
  check("and it is BLOCKED as UNKNOWN, not guessed at", r.blockKind === "UNKNOWN", String(r.blockKind));
  check("and the exact question is preserved for the person to read",
    r.field.label === SEO, r.field.label);
}

// ============================================================
console.log("\n2. answering it, without asking for reuse");

{
  const c = classifyFeedback(event({ reuseRequested: false }));
  check("an answer given without ticking the box is ONE_OFF", c.classification === "ONE_OFF", c.classification);
  check("and its scope is NONE, so nothing can recall it", c.scope === "NONE", c.scope);
  const o = learnFromFeedback(event({ reuseRequested: false }), snapshot());
  check("no reusable answer is created", o.contextual === null && o.bank === null);
  check("no mapping is created", o.mapping === null);
  check("no profile fact is written", o.profileFact === null);
}

// The old default, where reuse was neither requested nor refused, is
// unchanged: the CLI recorder and its tests behave exactly as before.
{
  const o = learnFromFeedback(event(), snapshot());
  check("an event that says nothing about reuse is still ONE_OFF for an unknown question",
    o.classification.classification === "ONE_OFF", o.classification.classification);
}

// ============================================================
console.log("\n3. answering it and asking for reuse");

{
  const o = learnFromFeedback(event({ reuseRequested: true }), snapshot());
  check("it is stored as a reusable answer", o.contextual !== null);
  check("keyed on the exact wording, not an invented intent",
    o.contextual?.normalizedQuestion === normalizeQuestion(SEO) && o.contextual?.intentKey === null,
    JSON.stringify({ q: o.contextual?.normalizedQuestion, i: o.contextual?.intentKey }));
  check("at QUESTION scope", o.contextual?.scope === "QUESTION", String(o.contextual?.scope));
  check("and nothing was promoted to the profile", o.profileFact === null);
}

// ============================================================
console.log("\n4. reuse, on a later application");

{
  const store = { mappings: [], contextual: [stored()] };

  const same = recallAnswer({ intentKey: null, questionNormalized: normalizeQuestion(SEO),
    provider: "LEVER", employer: "Other Co", jobId: "job-2", conditions: {} }, store);
  check("the same question on a different ATS and employer is reused",
    !("blocked" in same) && same.answer === "Yes" && same.confidence === "HUMAN_CONFIRMED",
    JSON.stringify(same));

  // The case this whole design exists for.
  const generic = recallAnswer({ intentKey: null, questionNormalized: normalizeQuestion(SEO_GENERIC),
    provider: "GREENHOUSE", employer: "Acme", jobId: "job-3", conditions: {} }, store);
  check("a question without the duration qualifier is NOT answered from it", "blocked" in generic,
    JSON.stringify(generic));

  const longer = recallAnswer({ intentKey: null,
    questionNormalized: normalizeQuestion("Do you have 7+ years of SEO experience?"),
    provider: "GREENHOUSE", employer: "Acme", jobId: "job-4", conditions: {} }, store);
  check("a longer duration is not answered from it either", "blocked" in longer);

  const related = recallAnswer({ intentKey: null,
    questionNormalized: normalizeQuestion("Do you have 5+ years of SEM experience?"),
    provider: "GREENHOUSE", employer: "Acme", jobId: "job-5", conditions: {} }, store);
  check("a neighbouring discipline is not answered from it", "blocked" in related);

  // Through the resolver, which is where it actually matters.
  const learned = ctx({ learned: store, application: { provider: "LEVER", employer: "Other Co", jobId: "job-2", conditions: {} } });
  const viaResolver = resolveField(f(SEO), learned);
  check("the resolver reuses it as HUMAN_CONFIRMED",
    viaResolver.confidence === "HUMAN_CONFIRMED" && viaResolver.answer === "Yes", viaResolver.confidence);
  check("and never as VERIFIED", viaResolver.confidence !== "VERIFIED");
  const viaResolverNear = resolveField(f(SEO_GENERIC), learned);
  check("and the near match still BLOCKS through the resolver",
    viaResolverNear.confidence === "BLOCKED", viaResolverNear.confidence);
}

// Option controls still gate a recalled answer.
{
  const store = { mappings: [], contextual: [stored({ answer: "Yes" })] };
  const learned = ctx({ learned: store, application: { provider: "GREENHOUSE", employer: "Acme", jobId: "j", conditions: {} } });
  const r = resolveField(f(SEO, { type: "select", options: ["Definitely", "Not at all"] }), learned);
  check("a recalled answer the control does not offer BLOCKS", r.confidence === "BLOCKED", r.confidence);
}

// ============================================================
// ============================================================
console.log("\n4b. a sensitive question recalls the person's own answer for THIS employer only");
{
  const NT = "Have you ever been an employee of either Northern Trust or any affiliates of Northern Trust?";
  const own = stored({ id: "c-nt", intentKey: "previously_employed_here", normalizedQuestion: null, answer: "No",
    scope: "EMPLOYER", employer: "Northern Trust", provider: "WORKDAY", jobId: "job-nt" });
  const store = { mappings: [], contextual: [own] };
  const here = ctx({ learned: store, application: { provider: "WORKDAY", employer: "Northern Trust", jobId: "job-nt-2", conditions: {} } });
  const r = resolveField(f(NT, { type: "select", options: ["Yes", "No"] }), here);
  check("the same employer's question is answered from his own earlier answer",
    r.confidence === "HUMAN_CONFIRMED" && r.answer === "No", `${r.confidence} ${r.blockedReason ?? ""}`);
  const elsewhere = ctx({ learned: store, application: { provider: "WORKDAY", employer: "Lorain County Community College", jobId: "job-l", conditions: {} } });
  const r2 = resolveField(f("Have you ever been an employee of either Lorain County Community College or any affiliates?", { type: "select", options: ["Yes", "No"] }), elsewhere);
  check("another employer's version stays blocked", r2.confidence === "BLOCKED", r2.confidence);
  const generalised = { mappings: [], contextual: [stored({ id: "c-gen", intentKey: "previously_employed_here", normalizedQuestion: null, answer: "No", scope: "INTENT" })] };
  const r3 = resolveField(f(NT, { type: "select", options: ["Yes", "No"] }), ctx({ learned: generalised, application: { provider: "WORKDAY", employer: "Northern Trust", jobId: "j", conditions: {} } }));
  check("an intent-scoped reply never answers a sensitive question", r3.confidence === "BLOCKED", r3.confidence);
}

console.log("\n5. a question the catalog does know");

{
  const ev = event({ questionRaw: "Are you 18 years of age or older?",
    questionNormalized: normalizeQuestion("Are you 18 years of age or older?"),
    intentBefore: "age_over_18", humanAnswer: "Yes", reuseRequested: true });
  const o = learnFromFeedback(ev, snapshot());
  check("a recognised question is promoted to the question bank", o.bank !== null, JSON.stringify(o.classification));
  check("with its intent key", o.bank?.intentKey === "age_over_18", String(o.bank?.intentKey));
  check("and no reusable free-text answer is created instead", o.contextual === null);
}

// A never-filled intent is never stored, reuse request or not.
{
  const ev = event({ questionRaw: "Social Security Number", questionNormalized: "social security number",
    intentBefore: "ssn", humanAnswer: "123", reuseRequested: true });
  const o = learnFromFeedback(ev, snapshot());
  check("an intent this system never fills is never stored for reuse",
    o.bank === null && o.contextual === null && o.classification.classification === "ONE_OFF",
    o.classification.classification);
}

// ============================================================
console.log("\n6. conflicts are never resolved automatically");

{
  const snap = snapshot({ bank: [{ id: "b1", intentKey: "age_over_18", answer: "Yes", provenance: "USER_RESPONSE" }] });
  const ev = event({ questionRaw: "Are you 18 years of age or older?",
    questionNormalized: normalizeQuestion("Are you 18 years of age or older?"),
    intentBefore: "age_over_18", humanAnswer: "No", reuseRequested: true });
  const o = learnFromFeedback(ev, snap);
  check("a contradicting bank answer opens a conflict", o.conflicts.length === 1, JSON.stringify(o.conflicts));
  check("and nothing is written over the old answer", o.bank === null);
  check("and the conflict names both answers",
    o.conflicts[0]?.existing === "Yes" && o.conflicts[0]?.incoming === "No", JSON.stringify(o.conflicts[0]));
}
{
  const snap = snapshot({ bank: [{ id: "b1", intentKey: "age_over_18", answer: "Yes", provenance: "USER_RESPONSE" }] });
  const ev = event({ questionRaw: "Are you 18 years of age or older?",
    questionNormalized: normalizeQuestion("Are you 18 years of age or older?"),
    intentBefore: "age_over_18", humanAnswer: "yes", reuseRequested: true });
  const o = learnFromFeedback(ev, snap);
  check("re-answering the same way changes nothing and opens nothing",
    o.bank === null && o.conflicts.length === 0);
}
{
  const snap = snapshot({ contextual: [stored({ answer: "Yes" })] });
  const o = learnFromFeedback(event({ humanAnswer: "No", reuseRequested: true }), snap);
  check("a contradicting answer to the same exact question opens a conflict", o.conflicts.length === 1);
  check("and does not overwrite the stored one", o.contextual === null);
}

// Two stored answers of equal scope that disagree stop the field.
{
  const store = { mappings: [], contextual: [
    stored({ id: "a", answer: "Yes" }), stored({ id: "b", answer: "No" }),
  ] };
  const r = recallAnswer({ intentKey: null, questionNormalized: normalizeQuestion(SEO),
    provider: "GREENHOUSE", employer: "Acme", jobId: "j", conditions: {} }, store);
  check("two stored answers that disagree block rather than picking one",
    "blocked" in r && /reconciliation/.test(r.blocked), JSON.stringify(r));
}

// ============================================================
console.log("\n7. sensitive answers are never inferred, and near matches never reused");

{
  // A stored self-identification answer worded for a different control.
  const bank = new Map([["gender", { answer: "Male", evidenceIds: [], provenance: "USER_RESPONSE" as const }]]);
  const r = resolveField(f("Gender", { type: "select", options: ["Woman", "Man", "Prefer not to say"] }), ctx({ bank }));
  check("a stored 'Male' does not answer a control offering 'Man'",
    r.confidence === "BLOCKED" && r.answer === null, `${r.confidence} ${r.answer}`);

  const r2 = resolveField(f("Are you Hispanic or Latino?", { type: "select", options: ["Yes", "No"] }),
    ctx({ bank: new Map([["race_ethnicity", { answer: "White", evidenceIds: [], provenance: "USER_RESPONSE" as const }]]) }));
  check("a stored race does not answer an ethnicity question",
    r2.confidence === "BLOCKED", `${r2.confidence} ${r2.answer}`);
}
{
  // Feedback must not open a second door to a sensitive field.
  const store = { mappings: [], contextual: [stored({
    id: "c-gender", normalizedQuestion: normalizeQuestion("Gender"), answer: "Male" })] };
  const r = resolveField(f("Gender", { type: "select", options: ["Male", "Female"] }),
    ctx({ learned: store, application: { provider: "GREENHOUSE", employer: "Acme", jobId: "j", conditions: {} } }));
  check("a sensitive question with an empty bank still BLOCKS despite stored feedback",
    r.confidence === "BLOCKED", `${r.confidence} ${r.answer}`);
}

// ============================================================
console.log("\n8. re-preparation preserves human work");

const human = (over: Partial<ExistingAnswer> = {}): ExistingAnswer => ({
  id: "a1", fieldKey: f(SEO).key, fieldLabel: SEO, questionText: SEO,
  answerText: "Yes", confidenceState: "HUMAN_CONFIRMED", provenance: "USER_RESPONSE",
  evidenceIds: [], promoteToBank: null, questionBankId: null, ...over,
});
const blockedAgain = (label = SEO, over: Partial<FormField> = {}): ResolvedField => ({
  field: f(label, over), intentKey: null, matchedBy: "no match", answer: null,
  confidence: "BLOCKED", blockKind: "UNKNOWN", blockedReason: "not in the catalog",
  evidenceIds: [], considered: [], refused: false,
});

{
  const d = mayCarry(human(), f(SEO), blockedAgain());
  check("a materially identical question keeps the human answer", d.carry, d.because);
}
{
  const changed = f("Do you have 7+ years of SEO experience?");
  const d = mayCarry(human(), changed, blockedAgain("Do you have 7+ years of SEO experience?"));
  check("a materially changed question does NOT keep it", !d.carry, d.because);
}
{
  const opts = { type: "select" as const, options: ["Definitely", "No"] };
  const d = mayCarry(human(), f(SEO, opts), blockedAgain(SEO, opts));
  check("changed options that no longer offer the answer do NOT keep it", !d.carry, d.because);
}
{
  const opts = { type: "select" as const, options: ["Yes", "No"] };
  const d = mayCarry(human(), f(SEO, opts), blockedAgain(SEO, opts));
  check("changed options that still offer the answer do keep it", d.carry, d.because);
}
{
  const d = mayCarry(human({ answerText: null }), f(SEO), blockedAgain());
  check("a deliberate blank is human work too and is kept", d.carry, d.because);
}
{
  const d = mayCarry(human({ confidenceState: "VERIFIED" }), f(SEO), blockedAgain());
  check("a VERIFIED answer is recomputed rather than carried", !d.carry, d.because);
}
{
  const nowAnswerable: ResolvedField = { ...blockedAgain(), confidence: "DERIVED", answer: "No", blockKind: null, blockedReason: null };
  const d = mayCarry(human(), f(SEO), nowAnswerable);
  check("truth the system can now establish wins over a remembered reply", !d.carry, d.because);
}
{
  const r = reconcileAnswers([blockedAgain()], [human()]);
  check("reconciliation substitutes the carried answer", r.resolved[0]!.confidence === "HUMAN_CONFIRMED");
  check("and records that it carried it", r.carried.length === 1 && r.dropped.length === 0);
  check("and gives it no evidence it did not have", r.resolved[0]!.evidenceIds.length === 0);
}
{
  const r = reconcileAnswers([blockedAgain("A brand new question")], [human()]);
  check("an answer whose question is gone is reported as dropped, not silently lost",
    r.dropped.length === 1 && /no longer asks/.test(r.dropped[0]!.because), JSON.stringify(r.dropped));
  check("and the new question is left blocked", r.resolved[0]!.confidence === "BLOCKED");
}
{
  // The resolver answering it identically is not a loss, and must not
  // be logged as one.
  const reproduced: ResolvedField = { ...blockedAgain(), confidence: "HUMAN_CONFIRMED",
    answer: "Yes", blockKind: null, blockedReason: null };
  const r = reconcileAnswers([reproduced], [human({ answerText: "Yes" })]);
  check("an answer the resolver reproduces is not reported as dropped human work",
    r.dropped.length === 0, JSON.stringify(r.dropped));
}
{
  const changedTo: ResolvedField = { ...blockedAgain(), confidence: "DERIVED",
    answer: "No", blockKind: null, blockedReason: null };
  const r = reconcileAnswers([changedTo], [human({ answerText: "Yes" })]);
  check("but one the system now answers differently IS reported", r.dropped.length === 1,
    JSON.stringify(r.dropped));
}

// ============================================================
console.log("\n9. the lifecycle, end to end");

{
  // Blocked, answered, promoted, and reused on a different posting.
  const first = resolveField(f(SEO), ctx());
  const learned = learnFromFeedback(event({ reuseRequested: true }), snapshot());
  const store = { mappings: [], contextual: [{ id: "c1", ...learned.contextual! } as ContextualAnswer] };
  const later = resolveField(f(SEO), ctx({ learned: store,
    application: { provider: "ASHBY", employer: "Third Co", jobId: "job-9", conditions: {} } }));

  check("blocked, then answered, then reused",
    first.confidence === "BLOCKED" && later.confidence === "HUMAN_CONFIRMED" && later.answer === "Yes",
    `${first.confidence} -> ${later.confidence}`);
  check("and the reuse cites the event rather than evidence",
    later.evidenceIds.length === 0 || later.evidenceIds.every((id) => !id.startsWith("00000000")),
    JSON.stringify(later.evidenceIds));
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
