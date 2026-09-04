/**
 * Stage 5 consolidated-questions safety tests. resolveOneAnswer runs for
 * real against a faithful in-memory Postgrest double; the bulk route's
 * orchestration (apply each independently, dedupe touched applications,
 * reevaluate each exactly once) is mirrored with an idempotent
 * evaluateReadiness double that enqueues at most once per application --
 * the same contract the real one enforces with a conditional UPDATE.
 * Grouping/reuse permissions come from the real groupBlockedQuestions.
 */
import { resolveOneAnswer, type AnswerResolution } from "../lib/applications/resolveAnswers.ts";
import { groupBlockedQuestions, type BlockedField } from "../lib/portal/questionGroups.ts";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

// ---- faithful in-memory Postgrest double -------------------------------
type Row = Record<string, any>;
function makeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const store = tables[table] ??= [];
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" = "select"; let payload: Row = {}; let lim: number | null = null;
      const b: any = {
        select() { return b; },
        update(p: Row) { op = "update"; payload = p; return b; },
        eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
        limit(n: number) { lim = n; return b; },
        _match() { let rows = store.filter((r) => filters.every((f) => f(r))); if (lim != null) rows = rows.slice(0, lim); return rows; },
        _apply() { const rows = b._match(); if (op === "update") for (const r of rows) Object.assign(r, payload); return rows.map((r: Row) => ({ ...r })); },
        single() { const r = b._apply(); return Promise.resolve({ data: r[0] ?? null, error: r[0] ? null : { message: "no row" } }); },
        maybeSingle() { const r = b._apply(); return Promise.resolve({ data: r[0] ?? null, error: null }); },
        then(res: any) { return Promise.resolve({ data: b._apply(), error: null }).then(res); },
      };
      return b;
    },
  };
}

// ---- idempotent evaluateReadiness double -------------------------------
function makeEval(apps: Row[]) {
  const evalCount: Record<string, number> = {};
  const enqueueCount: Record<string, number> = {};
  async function evaluate(appId: string) {
    evalCount[appId] = (evalCount[appId] ?? 0) + 1;
    const app = apps.find((a) => a.id === appId)!;
    if (app.submitted_at) return { ready: false, code: "SUBMITTED", enqueued: false };
    if (app.submit_requested_at) return { ready: true, enqueued: false };
    const blockedLeft = (tablesRef.application_answers ?? []).some((r) => r.application_id === appId && r.confidence_state === "BLOCKED");
    if (blockedLeft) return { ready: false, code: "STILL_BLOCKED", enqueued: false };
    // Ready to SEND only when a human already approved (answering clears
    // blocks -> AWAITING_REVIEW, which still needs approval). Enqueue once.
    if (app.human_approved) { app.submit_requested_at = "now"; enqueueCount[appId] = (enqueueCount[appId] ?? 0) + 1; return { ready: true, enqueued: true }; }
    return { ready: false, code: "NEEDS_APPROVAL", enqueued: false };
  }
  return { evaluate, evalCount, enqueueCount };
}

// mirrors app/api/applications/answers/route.ts orchestration exactly
let tablesRef: Record<string, Row[]>;
async function bulkProcess(db: any, ev: any, resolutions: AnswerResolution[]) {
  const results = []; const touched = new Set<string>();
  for (const r of resolutions) { const res = await resolveOneAnswer(db, r); results.push(res); for (const id of res.touched) touched.add(id); }
  for (const appId of touched) await ev.evaluate(appId);
  return { results, touched };
}

// ---- fixtures ----------------------------------------------------------
const snap = (fields: any[]) => ({ fields });
function fresh() {
  const applications: Row[] = [
    { id: "A", status: "BLOCKED_NEEDS_INPUT", human_approved: false, form_snapshot: snap([{ key: "color", options: ["Red", "Blue"] }, { key: "why", options: [] }]) },
    { id: "B", status: "BLOCKED_NEEDS_INPUT", human_approved: false, form_snapshot: snap([{ key: "color", options: ["Red", "Blue"] }, { key: "consent", options: ["Acknowledge"] }]) },
    { id: "C", status: "BLOCKED_NEEDS_INPUT", human_approved: false, form_snapshot: snap([{ key: "color", options: ["Red"] }]) }, // no Blue
    { id: "E", status: "BLOCKED_NEEDS_INPUT", human_approved: true, form_snapshot: snap([{ key: "start", options: [] }]) }, // approved, waiting on one answer
    { id: "S", status: "SUBMITTED", human_approved: true, submitted_at: "yes", form_snapshot: snap([]) },
  ];
  const application_answers: Row[] = [
    { id: "aA_color", application_id: "A", field_key: "color", confidence_state: "BLOCKED", is_required: true, label: "Favorite color", question_text: "Favorite color?", category: null, block_kind: null, blocked_reason: null, type: "select", options: ["Red", "Blue"] },
    { id: "aA_why", application_id: "A", field_key: "why", confidence_state: "BLOCKED", is_required: true, label: "Why apply", question_text: "Why do you want this role?", category: null, block_kind: null, blocked_reason: null, type: "text", options: [] },
    { id: "aB_color", application_id: "B", field_key: "color", confidence_state: "BLOCKED", is_required: true, label: "Favorite color", question_text: "Favorite color?", category: null, block_kind: null, blocked_reason: null, type: "select", options: ["Red", "Blue"] },
    { id: "aB_consent", application_id: "B", field_key: "consent", confidence_state: "BLOCKED", is_required: true, label: "Consent to texts", question_text: "I agree to receive texts", category: "D_SENSITIVE", block_kind: null, blocked_reason: null, type: "select", options: ["Acknowledge"] },
    { id: "aC_color", application_id: "C", field_key: "color", confidence_state: "BLOCKED", is_required: true, label: "Favorite color", question_text: "Favorite color?", category: null, block_kind: null, blocked_reason: null, type: "select", options: ["Red"] },
    { id: "aE_start", application_id: "E", field_key: "start", confidence_state: "BLOCKED", is_required: true, label: "Start date", question_text: "When can you start?", category: null, block_kind: null, blocked_reason: null, type: "text", options: [] },
  ];
  return { applications, application_answers };
}
const bf = (r: Row, appLabel: string): BlockedField => ({
  applicationId: r.application_id, applicationLabel: appLabel, fieldKey: r.field_key, label: r.label,
  questionText: r.question_text, options: r.options, type: r.type, required: r.is_required, category: r.category, blockKind: r.block_kind, blockedReason: r.blocked_reason,
});

// ---- 5 + 6 + 7: grouping marks the duplicate reusable, consent NOT -----
{
  const t = fresh();
  const groups = groupBlockedQuestions([
    bf(t.application_answers[0]!, "A"), bf(t.application_answers[2]!, "B"), bf(t.application_answers[4]!, "C"),
    bf(t.application_answers[3]!, "B"),
  ]);
  const color = groups.find((g) => g.fields[0]!.fieldKey === "color")!;
  ok(!!color && color.fields.length === 3, "duplicate 'color' question across 3 applications is grouped once", `${color?.fields.length}`);
  ok(color.reusable === true, "the plain duplicate question is reusable (semantic reuse permitted)");
  const consent = groups.find((g) => g.fields[0]!.fieldKey === "consent")!;
  ok(!!consent && consent.reusable === false, "the consent question is NOT reusable (HUMAN_ONLY never inferred across employers)", String(consent?.reusable));
}

// ---- 1-3 + 8 + 9: multi-app, mixed types, all valid, reeval once, enqueue once
{
  const t = fresh(); tablesRef = t; const db = makeDb(t as any); const ev = makeEval(t.applications);
  const { results, touched } = await bulkProcess(db, ev, [
    { answerId: "aA_color", answer: "Red", leaveBlank: false, promote: false, reuseAnswerIds: ["aB_color"] }, // reuse to B (permitted)
    { answerId: "aA_why", answer: "Because I am a strong fit", leaveBlank: false, promote: false, reuseAnswerIds: [] }, // free text
    { answerId: "aE_start", answer: "Immediately", leaveBlank: false, promote: false, reuseAnswerIds: [] },
  ]);
  ok(results.every((r) => r.ok), "every valid answer saved (mixed select + text)");
  const get = (id: string) => t.application_answers.find((r) => r.id === id)!;
  ok(get("aA_color").confidence_state === "HUMAN_CONFIRMED" && get("aA_color").provenance === "USER_RESPONSE", "answer written as HUMAN_CONFIRMED / USER_RESPONSE (never inferred)");
  ok(get("aB_color").confidence_state === "HUMAN_CONFIRMED", "the reusable duplicate resolved application B too");
  ok(get("aB_color").considered_evidence?.[0]?.kind === "DELIBERATE_REUSE", "reuse is recorded as deliberate, with provenance");
  ok(t.applications.find((a) => a.id === "A")!.status === "AWAITING_REVIEW", "A unblocked to AWAITING_REVIEW (readiness logic reused)");
  ok(ev.evalCount["A"] === 1 && ev.evalCount["B"] === 1 && ev.evalCount["E"] === 1, "each affected application reevaluated exactly once", JSON.stringify(ev.evalCount));
  ok(ev.enqueueCount["E"] === 1, "the already-approved app E, newly unblocked, enqueued exactly once", String(ev.enqueueCount["E"]));
  ok(!ev.enqueueCount["A"], "A (unblocked but not yet approved) is NOT enqueued", String(ev.enqueueCount["A"]));
}

// ---- 4 + 6: one invalid among valid; reuse where option not offered ----
{
  const t = fresh(); tablesRef = t; const db = makeDb(t as any); const ev = makeEval(t.applications);
  const { results } = await bulkProcess(db, ev, [
    { answerId: "aA_color", answer: "Green", leaveBlank: false, promote: false, reuseAnswerIds: [] }, // invalid: not offered
    { answerId: "aA_why", answer: "Valid reason", leaveBlank: false, promote: false, reuseAnswerIds: [] }, // valid
    { answerId: "aB_color", answer: "Blue", leaveBlank: false, promote: false, reuseAnswerIds: ["aC_color"] }, // valid for B, reuse to C where Blue not offered
  ]);
  const byId: Record<string, any> = Object.fromEntries(results.map((r) => [r.answerId, r]));
  ok(byId["aA_color"].status === "OPTION_NOT_OFFERED" && !byId["aA_color"].ok, "an option the employer does not offer is refused, not written");
  ok(byId["aA_why"].ok && byId["aB_color"].ok, "the other valid answers still saved (no silent loss)");
  ok(t.application_answers.find((r) => r.id === "aA_color")!.confidence_state === "BLOCKED", "the refused field stays open");
  ok(byId["aB_color"].reuseSkipped.includes("C"), "reuse into an application that does not offer the option is skipped (evidence-safe)", JSON.stringify(byId["aB_color"].reuseSkipped));
  ok(t.application_answers.find((r) => r.id === "aC_color")!.confidence_state === "BLOCKED", "the skipped reuse target C stays open, never given the nearest fit");
}

// ---- 7: HUMAN_ONLY / consent never auto-filled --------------------------
{
  const t = fresh(); tablesRef = t; const db = makeDb(t as any); const ev = makeEval(t.applications);
  // Answer only B's color; consent gets NO resolution -> must stay blocked.
  await bulkProcess(db, ev, [{ answerId: "aB_color", answer: "Red", leaveBlank: false, promote: false, reuseAnswerIds: [] }]);
  ok(t.application_answers.find((r) => r.id === "aB_consent")!.confidence_state === "BLOCKED", "consent is never auto-filled when not explicitly answered");
  ok(t.applications.find((a) => a.id === "B")!.status === "BLOCKED_NEEDS_INPUT", "B stays blocked while its consent is unanswered (not advanced)");
}

// ---- 10: already-submitted app is not re-enqueued -----------------------
{
  const t = fresh(); tablesRef = t; const db = makeDb(t as any); const ev = makeEval(t.applications);
  const r = await ev.evaluate("S");
  ok(r.enqueued === false && !ev.enqueueCount["S"], "a submitted application is never re-enqueued");
}

// ---- 11: retry after partial failure is idempotent ---------------------
{
  const t = fresh(); tablesRef = t; const db = makeDb(t as any); const ev = makeEval(t.applications);
  // First pass: A.why fails (empty), A.color + E.start succeed.
  await bulkProcess(db, ev, [
    { answerId: "aA_color", answer: "Red", leaveBlank: false, promote: false, reuseAnswerIds: [] },
    { answerId: "aA_why", answer: "", leaveBlank: false, promote: false, reuseAnswerIds: [] },   // EMPTY -> fails
    { answerId: "aE_start", answer: "Soon", leaveBlank: false, promote: false, reuseAnswerIds: [] },
  ]);
  const enqAfter1 = ev.enqueueCount["E"] ?? 0;
  ok(enqAfter1 === 1, "E enqueued once on the first pass", String(enqAfter1));
  // Retry: resubmit everything, now with a real answer for why.
  const { results } = await bulkProcess(db, ev, [
    { answerId: "aA_color", answer: "Red", leaveBlank: false, promote: false, reuseAnswerIds: [] }, // already saved
    { answerId: "aA_why", answer: "A real reason now", leaveBlank: false, promote: false, reuseAnswerIds: [] }, // now valid
    { answerId: "aE_start", answer: "Soon", leaveBlank: false, promote: false, reuseAnswerIds: [] }, // already saved
  ]);
  const byId: Record<string, any> = Object.fromEntries(results.map((r) => [r.answerId, r]));
  ok(byId["aA_color"].status === "ALREADY_RESOLVED" && byId["aA_color"].ok, "a previously-saved answer is idempotent on retry, not rewritten");
  ok(byId["aA_why"].status === "SAVED", "the previously-failed answer saves on retry");
  ok((ev.enqueueCount["E"] ?? 0) === 1, "E is still enqueued exactly once across the retry (no double-enqueue)", String(ev.enqueueCount["E"]));
  ok(t.applications.find((a) => a.id === "A")!.status === "AWAITING_REVIEW", "A becomes AWAITING_REVIEW once its last block clears on retry");
}

console.log(bad ? `\n${bad} FAILED` : `\nconsolidated-questions-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
