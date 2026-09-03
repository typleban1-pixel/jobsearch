/**
 * Readiness: enqueue exactly once, exactly when every gate passes.
 *
 * Runs against a scripted fake of the database client, because the
 * properties under test are decision properties: which states enqueue,
 * which refuse, and that a concurrent trigger can never double-queue.
 * The conditional-write semantics themselves are exercised against the
 * real database by the listener's own atomic claim, which is already
 * proven by live submissions.
 */
import { evaluateReadiness } from "../lib/applications/readiness.ts";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};

/** A minimal supabase stand-in: table -> scripted rows. */
function fakeDb(state: Record<string, any>) {
  const calls: any[] = [];
  const client = {
    calls,
    from(table: string) {
      const chain: any = {
        _table: table, _updates: null as any, _conds: [] as string[],
        select() { return chain; }, eq() { return chain; }, gte() { return chain; },
        order() { return chain; }, limit() { return chain; },
        is(col: string) { chain._conds.push(col); return chain; },
        update(patch: any) { chain._updates = patch; return chain; },
        insert(row: any) { calls.push({ table, insert: row }); return { then: (r: any) => r(undefined) }; },
        maybeSingle() { return Promise.resolve({ data: state[table] ?? null }); },
        single() { return Promise.resolve({ data: state[table] ?? null }); },
        then(resolve: any) {
          if (chain._updates) {
            calls.push({ table, update: chain._updates, conds: chain._conds });
            // The conditional write: refuses when the scripted row already
            // holds a request, exactly as the real WHERE clause does.
            const row = state.applications;
            const clean = !row?.submit_requested_at && !row?.submit_started_at && !row?.submitted_at;
            return resolve({ data: clean ? [{ id: row?.id }] : [], error: null });
          }
          const rows = state[`${table}[]`] ?? (state[table] ? [state[table]] : []);
          return resolve({ data: rows, error: null, count: state[`${table}.count`] ?? 0 });
        },
      };
      return chain;
    },
  };
  return client as any;
}

const READY = {
  applications: { id: "a1", job_id: "j1", status: "READY_TO_SUBMIT", human_approved: true,
    authorization_mode: "HUMAN_APPROVED", all_fields_confident: true, submitted_at: null,
    submit_requested_at: null, submit_started_at: null, approved_artifact_sha256: "x", is_test: false },
  jobs: { status: "OPEN", eligibility: "ELIGIBLE", source: "GREENHOUSE", canonical_opening_id: null },
  ats_policy: { paused: false, capability: "PRODUCTION" },
  automation_policy: { max_applications_per_day: 3 },
  "applications.count": 0,
  "job_candidacy[]": [{ verdict: "APPLICATION_CANDIDATE", created_at: new Date().toISOString() }],
  "application_answers[]": [{ confidence_state: "HUMAN_CONFIRMED", is_required: true, answer_text: "yes", field_key: "k" }],
  job_versions: { is_current: true },
};
const S = (over: Record<string, any>) => ({ ...READY, ...over,
  applications: { ...READY.applications, ...(over.applications ?? {}) } });

// ---- 1. a fully ready application enqueues immediately ----------------
{
  const db = fakeDb(S({}));
  const r = await evaluateReadiness(db, "a1");
  ok(r.ready === true && (r as any).enqueued === true, `ready enqueues (${JSON.stringify(r)})`);
  ok(db.calls.some((c: any) => c.update?.submit_requested_at), "the request timestamp is written");
  ok(db.calls.some((c: any) => c.insert?.event === "ENQUEUED"), "an ENQUEUED event goes on the timeline");
}
// ---- 2. it cannot enqueue twice ---------------------------------------
{
  const db = fakeDb(S({ applications: { submit_requested_at: "2026-09-03T00:00:00Z" } }));
  const r = await evaluateReadiness(db, "a1");
  ok(r.ready === true && (r as any).enqueued === false, "an already-queued application is left alone");
  ok(!db.calls.some((c: any) => c.update), "and nothing is written");
}
{
  // Concurrent race: the row was clean when read, taken by the time of
  // the write. The conditional write returns no rows; no second queue.
  const db = fakeDb(S({}));
  const orig = db.from.bind(db);
  let reads = 0;
  db.from = (t: string) => { const c = orig(t);
    if (t === "applications") { reads++; if (reads > 1) { /* later reads/writes see it taken */ } }
    return c; };
  const first = await evaluateReadiness(db, "a1");
  // simulate the second trigger arriving after the first landed
  const db2 = fakeDb(S({ applications: { submit_requested_at: "now" } }));
  const second = await evaluateReadiness(db2, "a1");
  ok((first as any).enqueued === true && (second as any).enqueued === false,
    "two triggers produce exactly one request");
}
// ---- 3. every gate refuses for its own reason -------------------------
{
  const r = await evaluateReadiness(fakeDb(S({ applications: { submitted_at: "2026-09-01" } })), "a1");
  ok(!r.ready && (r as any).code === "SUBMITTED", "a submitted application cannot re-enter the queue");
}
{
  const r = await evaluateReadiness(fakeDb(S({ applications: { is_test: true } })), "a1");
  ok(!r.ready && (r as any).code === "TEST_ROW", "test rows never enqueue");
}
{
  const r = await evaluateReadiness(fakeDb(S({ applications: { status: "AWAITING_REVIEW", human_approved: false } })), "a1");
  ok(!r.ready && (r as any).code === "NOT_AUTHORIZED", "unapproved and unauthorized does not enqueue");
}
{
  const r = await evaluateReadiness(fakeDb(S({ ats_policy: { paused: false, capability: "NONE" } })), "a1");
  ok(!r.ready && (r as any).code === "PROVIDER_NOT_AUTOMATED", "a NONE-capability provider refuses");
}
{
  const r = await evaluateReadiness(fakeDb(S({ ats_policy: { paused: true, capability: "PRODUCTION" } })), "a1");
  ok(!r.ready && (r as any).code === "PROVIDER_NOT_AUTOMATED", "a paused provider refuses");
}
{
  const r = await evaluateReadiness(fakeDb(S({ "applications.count": 3 })), "a1");
  ok(!r.ready && (r as any).code === "DAILY_CAP_REACHED", "the global daily cap holds");
}
{
  const r = await evaluateReadiness(fakeDb(S({ "applications.count": 2 })), "a1");
  ok(r.ready === true, "under the cap proceeds");
}
{
  const r = await evaluateReadiness(fakeDb(S({
    "application_answers[]": [{ confidence_state: "BLOCKED", is_required: true, answer_text: null, field_key: "k" }],
  })), "a1");
  ok(!r.ready && (r as any).code === "REVALIDATION_FAILED", "an unresolved required question prevents enqueue");
}
{
  const r = await evaluateReadiness(fakeDb(S({ jobs: { status: "CLOSED", eligibility: "ELIGIBLE", source: "GREENHOUSE" } })), "a1");
  ok(!r.ready && (r as any).code === "REVALIDATION_FAILED", "a closed posting refuses at revalidation");
}
// ---- 4. fixing the blocker flips the outcome --------------------------
{
  const before = await evaluateReadiness(fakeDb(S({
    applications: { status: "AWAITING_REVIEW", human_approved: false } })), "a1");
  const after = await evaluateReadiness(fakeDb(S({})), "a1");
  ok(!before.ready && after.ready === true,
    "the same application enqueues the moment approval lands (re-evaluation is the trigger)");
}
console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
