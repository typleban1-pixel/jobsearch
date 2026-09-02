/**
 * What a human correction is allowed to teach, and what it is not.
 *
 * The failure this suite exists to prevent is the obvious
 * implementation: remember the question, remember the answer, reuse it
 * next time. That system, asked whether he can commute to an office in
 * New York, answers yes, because he once said yes about Chicago. Every
 * case below is a version of that mistake.
 *
 * Runs offline against in-memory snapshots. Nothing touches the database.
 */
import { classifyFeedback, normalizeQuestion } from "../lib/feedback/classify.ts";
import { learnFromFeedback, BROADENING_CONFIRMATIONS, type BeliefSnapshot } from "../lib/feedback/learn.ts";
import { recallAnswer, recallIntent, conditionsHold, type RecallStore } from "../lib/feedback/recall.ts";
import { resolveField, type ResolveContext } from "../lib/applications/answer.ts";
import type { ContextualAnswer, FeedbackEvent, SemanticMapping } from "../lib/feedback/types.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
};

const CHICAGO = { locationCity: "Chicago", locationState: "IL", locationMetro: "Chicagoland" };
const NEW_YORK = { locationCity: "New York", locationState: "NY", locationMetro: "New York City" };

const event = (over: Partial<FeedbackEvent>): FeedbackEvent => ({
  applicationId: "app-1", jobId: "job-1", canonicalOpeningId: null,
  employer: "SpotHero", provider: "GREENHOUSE",
  questionRaw: "Do you require relocation assistance?",
  questionNormalized: normalizeQuestion(over.questionRaw ?? "Do you require relocation assistance?"),
  providerFieldKey: "question_1",
  intentBefore: null, confidenceBefore: "BLOCKED", whyStopped: "nothing in the question catalog matches this wording",
  proposedAnswer: null, humanAnswer: "No", intentConfirmed: null,
  conditions: {}, occurredAt: "2026-08-31T12:00:00Z",
  ...over,
});

const emptySnap = (over: Partial<BeliefSnapshot> = {}): BeliefSnapshot => ({
  profile: {}, verifiedFields: new Set(), mappings: [], contextual: [], adapters: [], ...over,
});

// ---- 1. A global fact, learned once, answers the same question later --
{
  const ev = event({ intentConfirmed: "relocation_assistance", humanAnswer: "No" });
  const out = learnFromFeedback(ev, emptySnap());
  check("an unambiguous personal fact is classified as one",
    out.classification.classification === "PROFILE_FACT" && out.classification.scope === "GLOBAL_FACT",
    JSON.stringify(out.classification));
  check("it is written to the profile column that holds it",
    out.profileFact?.field === "relocation_assistance_required" && out.profileFact?.value === false,
    JSON.stringify(out.profileFact));
  check("with HUMAN_CONFIRMED provenance",
    out.profileFact?.provenance === "HUMAN_CONFIRMED", JSON.stringify(out.profileFact));

  // Which means a later, differently worded question is answered by the
  // ordinary truth path, not by remembering a string.
  const ctx: ResolveContext = {
    profileRowId: "row-1",
    profile: { relocation_assistance_required: false },
    bank: new Map(),
  };
  const later = resolveField(
    { key: "q9", label: "Will you need relocation assistance from us?", type: "select", required: true, options: ["Yes", "No"] },
    ctx);
  check("a future application answers the same question from the fact, not from the text",
    later.answer === "No" && later.confidence === "DERIVED", JSON.stringify(later).slice(0, 160));
}

// ---- 2. A contextual answer cannot leave its context ------------------
{
  const ev = event({
    questionRaw: "Are you able to commute to our Chicago office three days per week?",
    questionNormalized: normalizeQuestion("Are you able to commute to our Chicago office three days per week?"),
    intentBefore: "can_commute", intentConfirmed: "can_commute",
    humanAnswer: "Yes", conditions: CHICAGO,
  });
  const out = learnFromFeedback(ev, emptySnap());
  check("a commute answer is contextual, never a personal fact",
    out.classification.classification === "CONTEXTUAL_ANSWER" && out.profileFact === null,
    JSON.stringify(out.classification));
  check("and is scoped to the place it was given about",
    out.classification.scope === "LOCATION" && out.contextual?.conditions.locationCity === "Chicago",
    JSON.stringify(out.contextual));

  const store: RecallStore = { mappings: [], contextual: [{ id: "c1", ...out.contextual!, fromEventIds: ["e1"] }] };

  const chicagoAgain = recallAnswer({
    intentKey: "can_commute", questionNormalized: "are you able to commute to our chicago office",
    provider: "LEVER", employer: "Another Co", jobId: "job-2", conditions: CHICAGO,
  }, store);
  check("asked about Chicago again, the confirmed answer is reused",
    "answer" in chicagoAgain && chicagoAgain.answer === "Yes" && chicagoAgain.confidence === "HUMAN_CONFIRMED",
    JSON.stringify(chicagoAgain));

  const newYork = recallAnswer({
    intentKey: "can_commute", questionNormalized: "are you able to commute to our new york office",
    provider: "GREENHOUSE", employer: "Some Co", jobId: "job-3", conditions: NEW_YORK,
  }, store);
  check("asked about New York, it answers nothing at all",
    "blocked" in newYork, JSON.stringify(newYork));
  check("and says why, naming both places",
    "blocked" in newYork && /Chicago/.test(newYork.blocked) && /New York/.test(newYork.blocked), JSON.stringify(newYork));

  const unknownPlace = recallAnswer({
    intentKey: "can_commute", questionNormalized: "can you commute to the office",
    provider: "GREENHOUSE", employer: "Some Co", jobId: "job-4", conditions: {},
  }, store);
  check("asked about an office whose location is unknown, it answers nothing",
    "blocked" in unknownPlace, JSON.stringify(unknownPlace));

  // Same metro, different city, is the case worth being explicit about.
  const suburb = recallAnswer({
    intentKey: "can_commute", questionNormalized: "commute to evanston",
    provider: "GREENHOUSE", employer: "Some Co", jobId: "job-5",
    conditions: { locationCity: "Evanston", locationState: "IL", locationMetro: "Chicagoland" },
  }, store);
  check("the same metro area does match, because that is what was confirmed",
    "answer" in suburb, JSON.stringify(suburb));
  check("but a different state entirely does not",
    !conditionsHold(CHICAGO, { locationCity: "Springfield", locationState: "MA" }).ok, "");
}

// ---- 3. A one-off is never reused ------------------------------------
{
  const ev = event({
    questionRaw: "Why do you want to work at SpotHero specifically?",
    intentBefore: null, intentConfirmed: null,
    humanAnswer: "I have used the product for years and the parking problem is one I understand.",
  });
  const out = learnFromFeedback(ev, emptySnap());
  check("an answer that generalises to nothing is kept as ONE_OFF",
    out.classification.classification === "ONE_OFF" && out.classification.scope === "NONE",
    JSON.stringify(out.classification));
  check("and produces no reusable rule of any kind",
    !out.profileFact && !out.mapping && !out.contextual && !out.adapter, JSON.stringify(out));

  const store: RecallStore = { mappings: [], contextual: [{
    id: "c-oneoff", normalizedQuestion: null, intentKey: "why_this_company", answer: "...", scope: "NONE", conditions: CHICAGO,
    employer: "SpotHero", provider: "GREENHOUSE", jobId: "job-1", expiresAt: null, confirmations: 1, fromEventIds: [],
  } as ContextualAnswer] };
  check("even stored, an answer marked not reusable is never served",
    "blocked" in recallAnswer({ intentKey: "why_this_company", questionNormalized: "why us",
      provider: "GREENHOUSE", employer: "SpotHero", jobId: "job-1", conditions: CHICAGO }, store), "");
}

// ---- 4. Contradicting an established fact stops, it does not win -----
{
  const ev = event({ intentConfirmed: "willing_to_relocate", humanAnswer: "No" });
  const snap = emptySnap({ profile: { willing_to_relocate: true }, verifiedFields: new Set(["willing_to_relocate"]) });
  const out = learnFromFeedback(ev, snap);
  check("a correction that contradicts an established fact writes nothing",
    out.profileFact === null, JSON.stringify(out.profileFact));
  check("it opens a conflict for a person to settle",
    out.conflicts.length === 1 && out.conflicts[0]!.status === "OPEN"
    && out.conflicts[0]!.existing === "true" && out.conflicts[0]!.incoming === "false",
    JSON.stringify(out.conflicts));
  check("and the audit says the existing value was verified truth",
    out.audit.some((a) => /VERIFIED truth/.test(a)), JSON.stringify(out.audit));

  // Agreeing with it is not a change, and not a conflict either.
  const agreeing = learnFromFeedback(event({ intentConfirmed: "willing_to_relocate", humanAnswer: "Yes" }), snap);
  check("a correction that agrees changes nothing and conflicts with nothing",
    agreeing.profileFact === null && agreeing.conflicts.length === 0, JSON.stringify(agreeing.audit));
}

// ---- 5. Semantic learning is about wording, not resemblance ----------
{
  const ev = event({
    questionRaw: "Would you need help with moving costs?",
    questionNormalized: normalizeQuestion("Would you need help with moving costs?"),
    intentBefore: null, intentConfirmed: "relocation_assistance", humanAnswer: "No",
  });
  // The intent is on the personal-fact list, so this teaches the fact.
  // The mapping case is a wording whose intent is not a personal fact.
  const mappingEv = event({
    questionRaw: "Which market are you targeting for your next role?",
    questionNormalized: normalizeQuestion("Which market are you targeting for your next role?"),
    intentBefore: null, intentConfirmed: "desired_work_location",
    humanAnswer: "Chicago", conditions: CHICAGO,
  });
  check("a wording whose intent is a personal fact teaches the fact",
    learnFromFeedback(ev, emptySnap()).classification.classification === "PROFILE_FACT", "");

  const out = learnFromFeedback(mappingEv, emptySnap());
  check("a posting-dependent intent stays contextual even when the human names the intent",
    out.classification.classification === "CONTEXTUAL_ANSWER", JSON.stringify(out.classification));

  // Wording learning proper: an intent that is neither personal nor
  // contextual, confirmed by the human.
  const wordingEv = event({
    questionRaw: "Tell us about your right to work here",
    questionNormalized: normalizeQuestion("Tell us about your right to work here"),
    intentBefore: "cover_letter", intentConfirmed: "work_authorization_detail", humanAnswer: "US citizen",
  });
  const wording = learnFromFeedback(wordingEv, emptySnap());
  check("a confirmed wording becomes a mapping scoped to the ATS it was seen on",
    wording.mapping?.provider === "GREENHOUSE" && wording.mapping?.confirmations === 1
    && wording.mapping?.status === "ACTIVE", JSON.stringify(wording.mapping));

  const store: RecallStore = { mappings: [{
    id: "m1", normalizedQuestion: wordingEv.questionNormalized, intentKey: "work_authorization_detail",
    provider: "GREENHOUSE", confirmations: 1, status: "ACTIVE", fromEventIds: ["e1"],
  }], contextual: [] };

  check("the exact wording is recognised on the ATS it was confirmed on",
    recallIntent(wordingEv.questionNormalized, "GREENHOUSE", store)?.intentKey === "work_authorization_detail", "");
  check("a similar but different wording is not",
    recallIntent(normalizeQuestion("Tell us about your right to work in Canada"), "GREENHOUSE", store) === null, "");
  check("one word of difference is a different question",
    normalizeQuestion("commute to our Chicago office") !== normalizeQuestion("commute to our New York office"), "");
  check("and a mapping confirmed on one ATS does not apply to another",
    recallIntent(wordingEv.questionNormalized, "LEVER", store) === null, "");

  // Broadening takes evidence from somewhere else.
  const secondProvider = learnFromFeedback({ ...wordingEv, provider: "LEVER" }, emptySnap({ mappings: store.mappings }));
  check("confirmed again on a second ATS, the mapping stops being provider specific",
    secondProvider.mapping?.provider === null && BROADENING_CONFIRMATIONS === 2,
    JSON.stringify(secondProvider.mapping));
}

// ---- 6. A contradicted mapping stops answering -----------------------
{
  const existing: SemanticMapping = {
    id: "m2", normalizedQuestion: "which office", intentKey: "desired_work_location",
    provider: "GREENHOUSE", confirmations: 3, status: "ACTIVE", fromEventIds: [],
  };
  const out = learnFromFeedback(event({
    questionRaw: "Which office", questionNormalized: "which office",
    intentBefore: "desired_work_location", intentConfirmed: "current_location_text", humanAnswer: "Cleveland, OH",
  }), emptySnap({ mappings: [existing] }));
  check("a later human answer that disagrees marks the mapping contradicted",
    out.mapping?.status === "CONTRADICTED" && out.conflicts.length === 1, JSON.stringify(out.mapping));
  check("and it is not silently switched to the new intent",
    out.mapping?.intentKey === "desired_work_location", JSON.stringify(out.mapping));
  check("a contradicted mapping answers nothing",
    recallIntent("which office", "GREENHOUSE",
      { mappings: [{ ...existing, status: "CONTRADICTED" }], contextual: [] }) === null, "");
}

// ---- 7. Form knowledge never becomes a personal answer ---------------
{
  const out = learnFromFeedback(event({
    questionRaw: "Phone", questionNormalized: "phone", providerFieldKey: null,
    humanAnswer: "This field is the react-select helper input, not a real phone control",
  }), emptySnap());
  check("a correction about a control teaches the adapter",
    out.classification.classification === "ADAPTER_CORRECTION" && out.adapter?.provider === "GREENHOUSE",
    JSON.stringify(out.classification));
  check("and produces no profile fact and no answer",
    !out.profileFact && !out.contextual, JSON.stringify(out));
  check("the adapter rule is scoped to the ATS it describes",
    out.classification.scope === "PROVIDER", JSON.stringify(out.classification));
}

// ---- 8. Insufficient evidence still blocks ---------------------------
{
  const ctx: ResolveContext = {
    profileRowId: "row-1", profile: {}, bank: new Map(),
    learned: { mappings: [], contextual: [] },
    application: { provider: "GREENHOUSE", employer: "Some Co", jobId: "job-9", conditions: NEW_YORK },
  };
  const r = resolveField(
    { key: "q1", label: "Are you able to commute to our New York office?", type: "select", required: true, options: ["Yes", "No"] },
    ctx);
  check("with nothing confirmed, the field still blocks",
    r.confidence === "BLOCKED" && r.answer === null, JSON.stringify(r).slice(0, 140));

  // And with the Chicago answer on file, it still blocks, for a reason
  // that names the mismatch.
  const withChicago: ResolveContext = { ...ctx, learned: { mappings: [], contextual: [{
    id: "c1", normalizedQuestion: null, intentKey: "can_commute", answer: "Yes", scope: "LOCATION", conditions: CHICAGO,
    employer: "SpotHero", provider: "GREENHOUSE", jobId: "job-1", expiresAt: null,
    confirmations: 1, fromEventIds: ["e1"],
  }] } };
  const r2 = resolveField(
    { key: "q1", label: "Are you able to commute to our New York office?", type: "select", required: true, options: ["Yes", "No"] },
    withChicago);
  check("a Chicago commute confirmation does not answer a New York commute question",
    r2.confidence === "BLOCKED" && r2.answer === null, JSON.stringify(r2).slice(0, 200));
}

// ---- 9. Feedback adds answers; it never changes one ------------------
{
  const base: ResolveContext = {
    profileRowId: "row-1",
    profile: { city: "Cleveland", state: "OH", willing_to_relocate: true },
    bank: new Map(),
  };
  const field = { key: "q2", label: "Are you willing to relocate?", type: "select" as const, required: true, options: ["Yes", "No"] };
  const before = resolveField(field, base);

  const withFeedback: ResolveContext = { ...base,
    learned: { mappings: [], contextual: [{
      id: "c2", normalizedQuestion: null, intentKey: "willing_to_relocate", answer: "No", scope: "LOCATION", conditions: CHICAGO,
      employer: "X", provider: "GREENHOUSE", jobId: "j", expiresAt: null, confirmations: 9, fromEventIds: [],
    }] },
    application: { provider: "GREENHOUSE", employer: "X", jobId: "j", conditions: CHICAGO },
  };
  const after = resolveField(field, withFeedback);
  check("an answer the truth path already produced is never overridden by feedback",
    before.answer === after.answer && after.answer === "Yes" && after.confidence === "DERIVED",
    `${before.answer} then ${after.answer}`);
}

// ---- 10. Thresholds are not what changes -----------------------------
{
  // Twenty confirmations of an unrelated intent do not make an unknown
  // field answerable.
  const many: ContextualAnswer[] = Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`, normalizedQuestion: null, intentKey: "can_commute", answer: "Yes", scope: "LOCATION", conditions: CHICAGO,
    employer: "X", provider: "GREENHOUSE", jobId: "j", expiresAt: null, confirmations: 20, fromEventIds: [],
  }));
  const r = recallAnswer({
    intentKey: "salary_expectation", questionNormalized: "what is your salary expectation",
    provider: "GREENHOUSE", employer: "X", jobId: "j", conditions: CHICAGO,
  }, { mappings: [], contextual: many });
  check("accumulated confirmations of one question do not answer another",
    "blocked" in r, JSON.stringify(r));

  // Two equally scoped confirmed answers that disagree do not average.
  const disagreeing: ContextualAnswer[] = [
    { id: "a", normalizedQuestion: null, intentKey: "onsite_schedule", answer: "Yes", scope: "LOCATION", conditions: CHICAGO,
      employer: "X", provider: "GREENHOUSE", jobId: "j", expiresAt: null, confirmations: 3, fromEventIds: [] },
    { id: "b", normalizedQuestion: null, intentKey: "onsite_schedule", answer: "No", scope: "LOCATION", conditions: CHICAGO,
      employer: "Y", provider: "LEVER", jobId: "k", expiresAt: null, confirmations: 3, fromEventIds: [] },
  ];
  const conflict = recallAnswer({
    intentKey: "onsite_schedule", questionNormalized: "hybrid schedule",
    provider: "GREENHOUSE", employer: "Z", jobId: "m", conditions: CHICAGO,
  }, { mappings: [], contextual: disagreeing });
  check("two confirmed answers that disagree block rather than pick one",
    "blocked" in conflict && /reconciliation/.test(conflict.blocked), JSON.stringify(conflict));

  // An expired answer is not evidence.
  const expired = recallAnswer({
    intentKey: "start_date", questionNormalized: "when can you start",
    provider: "GREENHOUSE", employer: "X", jobId: "j", conditions: CHICAGO, now: new Date("2026-08-31"),
  }, { mappings: [], contextual: [{
    id: "e", normalizedQuestion: null, intentKey: "start_date", answer: "Immediately", scope: "TIME_SENSITIVE", conditions: CHICAGO,
    employer: "X", provider: "GREENHOUSE", jobId: "j", expiresAt: "2026-01-01", confirmations: 1, fromEventIds: [],
  }] });
  check("a time limited answer stops being evidence when it expires", "blocked" in expired, JSON.stringify(expired));
}

// ---- 11. The record of what was known stays as it was ----------------
{
  // The event carries the pre-intervention state, and learning never
  // edits it. Checked structurally: the outcome contains no path back
  // into the event it was derived from.
  const ev = event({ intentConfirmed: "relocation_assistance", humanAnswer: "No" });
  const snapshot = JSON.stringify(ev);
  const out = learnFromFeedback(ev, emptySnap());
  check("learning does not mutate the event it learned from", JSON.stringify(ev) === snapshot, "");
  check("the event still records that the system was blocked at the time",
    ev.confidenceBefore === "BLOCKED" && ev.intentBefore === null && ev.proposedAnswer === null, "");
  check("and the outcome carries its own audit trail instead",
    out.audit.length >= 1 && out.audit.every((a) => typeof a === "string" && a.length > 10), JSON.stringify(out.audit));
}

// ---- live: the same rules, against the real schema -------------------
//
// Run with --live. Read-only: it loads what the database actually holds
// and checks that the store loads for real rather than falling back to
// an empty one, which is the failure that would look like "nothing has
// ever been learned" while actually meaning "the query errored".
if (process.argv.includes("--live")) {
  const { createClient } = await import("@supabase/supabase-js");
  const { required } = await import("../lib/env.ts");
  const { loadRecallStore, loadBeliefs } = await import("../lib/feedback/store.ts");
  const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

  // Loaded directly, not through the catch that hides an error.
  const [{ data: mappings, error: mErr }, { data: contextual, error: cErr }] = await Promise.all([
    db.from("semantic_mappings").select("*").eq("status", "ACTIVE"),
    db.from("contextual_answers").select("*"),
  ]);
  check("the learned tables load without error, so an empty store means empty and not broken",
    !mErr && !cErr, `${mErr?.message ?? ""} ${cErr?.message ?? ""}`);

  const store = await loadRecallStore(db);
  check("the live store matches what the tables hold",
    store.mappings.length === (mappings ?? []).length && store.contextual.length === (contextual ?? []).length,
    `${store.mappings.length}/${(mappings ?? []).length} mappings, ${store.contextual.length}/${(contextual ?? []).length} answers`);

  const { data: profile } = await db.from("profile").select("*").eq("singleton", true).single();
  const beliefs = await loadBeliefs(db, (profile ?? {}) as Record<string, unknown>);
  check("beliefs load with the profile's established fields marked",
    beliefs.verifiedFields.has("city") && beliefs.verifiedFields.has("relocation_destination_city"),
    `${beliefs.verifiedFields.size} fields hold a value`);

  // With nothing learned yet, a question the profile cannot answer must
  // still block. This is the property that must survive any amount of
  // accumulated feedback.
  const live = resolveField(
    { key: "q1", label: "Are you able to commute to our New York office three days a week?",
      type: "select", required: true, options: ["Yes", "No"] },
    { profileRowId: "live", profile: (profile ?? {}) as Record<string, any>, bank: new Map(),
      learned: store,
      application: { provider: "GREENHOUSE", employer: "Some Co", jobId: null, conditions: NEW_YORK } });
  check("against the live database, an unanswerable field still blocks",
    live.confidence === "BLOCKED" && live.answer === null, JSON.stringify(live).slice(0, 160));

  const { data: events } = await db.from("answer_feedback_events").select("id");
  check("no feedback event has been fabricated by any test run",
    (events ?? []).length === 0, `${(events ?? []).length} events`);
}

console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
