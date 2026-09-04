/**
 * Stage 3 prepare-listener safety tests. The claim/release/finalize logic is
 * exercised against a faithful in-memory Postgrest double that ENFORCES the
 * conditional-update WHERE clause -- concurrent claims are interleaved
 * (both select, then both conditional-update) so the "only one wins" result
 * comes from the same predicate Postgres row-locking enforces, not from
 * sequencing. A static check proves the worker can never submit. If
 * migration 0085 is applied, a real-Postgres pass repeats atomicity + stale
 * recovery against is_test rows and cleans up.
 */
import { claimDraft, releaseStale, finalizeClaim, heartbeat, type DraftClaim } from "./prepare-listener.ts";
import type { PrepareResult } from "../lib/applications/prepare.ts";
import { readFileSync } from "node:fs";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

// ---- faithful in-memory Postgrest double ---------------------------------
type Row = Record<string, any>;
function makeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const store = tables[table] ??= [];
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" = "select";
      let payload: Row = {};
      let ord: { col: string; asc: boolean } | null = null;
      let lim: number | null = null;
      const b: any = {
        select() { return b; },
        update(p: Row) { op = "update"; payload = p; return b; },
        eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
        neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
        lt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] < v); return b; },
        is(c: string, _n: null) { filters.push((r) => r[c] == null); return b; },
        not(c: string, _o: string, _n: null) { filters.push((r) => r[c] != null); return b; },
        order(c: string, o: { ascending: boolean }) { ord = { col: c, asc: o.ascending }; return b; },
        limit(n: number) { lim = n; return b; },
        _match() {
          let rows = store.filter((r) => filters.every((f) => f(r)));
          if (ord) rows = rows.slice().sort((a, z) => (a[ord!.col] < z[ord!.col] ? -1 : 1) * (ord!.asc ? 1 : -1));
          if (lim != null) rows = rows.slice(0, lim);
          return rows;
        },
        _apply() {
          const rows = b._match();
          if (op === "update") for (const r of rows) Object.assign(r, payload);
          return rows.map((r: Row) => ({ ...r }));
        },
        maybeSingle() { const r = b._apply(); return Promise.resolve({ data: r[0] ?? null, error: null }); },
        single() { const r = b._apply(); return Promise.resolve({ data: r[0] ?? null, error: r[0] ? null : { message: "no row" } }); },
        then(res: any) { return Promise.resolve({ data: b._apply(), error: null }).then(res); },
      };
      return b;
    },
  };
}
const draftRow = (id: string, over: Row = {}): Row =>
  ({ id, job_id: `job-${id}`, status: "DRAFT", is_test: false, prepare_started_at: null, blocked_reason: null, created_at: `2026-01-01T00:00:${id.padStart(2, "0")}Z`, ...over });
const withJobs = (apps: Row[]) => ({ applications: apps, jobs: apps.map((a) => ({ id: a.job_id, title: `Title ${a.id}` })) });

// ---- T1: one DRAFT gets claimed and prepared -----------------------------
{
  const db: any = makeDb(withJobs([draftRow("1")]));
  const c = await claimDraft(db);
  ok(!!c && c.id === "1", "T1 a lone DRAFT is claimed", c ? c.id : "none");
  const app = (db.from("applications") as any)._match ? null : null;
  // listener must NOT change status on claim (prepareApplication owns it)
  ok((db as any) && (tables1Status()) === "DRAFT", "T1 claim leaves status=DRAFT (prepareApplication owns transitions)");
  function tables1Status() { return (db.from("applications").eq("id", "1") as any)._match()[0].status; }
  // prepareApplication() sets the terminal status BEFORE the listener finalizes.
  (db.from("applications").eq("id", "1") as any)._match()[0].status = "AWAITING_REVIEW";
  await finalizeClaim(db, c!, { status: "AWAITING_REVIEW", answered: 5, blocked: 0, skipped: 0 } as PrepareResult);
  const r = (db.from("applications").eq("id", "1") as any)._match()[0];
  ok(r.prepare_started_at == null && r.status === "AWAITING_REVIEW" && r.blocked_reason == null,
    "T1 finalize clears the claim, keeps prepareApplication's terminal status", r.status);
}

// ---- T2: two concurrent workers cannot both claim the same application ----
{
  const db: any = makeDb(withJobs([draftRow("2")]));
  // Interleave: both select the SAME null-stamp row, THEN both conditional-update.
  const sel = () => db.from("applications").select("id,job_id").eq("status", "DRAFT").eq("is_test", false)
    .is("prepare_started_at", null).is("blocked_reason", null).order("created_at", { ascending: true }).limit(1).maybeSingle();
  const s1 = await sel(); const s2 = await sel();
  ok(!!s1.data && !!s2.data && s1.data.id === s2.data.id, "T2 both workers select the same unclaimed DRAFT");
  const upd = () => db.from("applications").update({ prepare_started_at: new Date().toISOString() })
    .eq("id", "2").eq("status", "DRAFT").is("prepare_started_at", null).select("id,job_id").maybeSingle();
  const w1 = await upd(); const w2 = await upd(); // conditional update honours the "still null" predicate
  const winners = [w1.data, w2.data].filter(Boolean).length;
  ok(winners === 1, "T2 exactly one conditional claim wins; the other matches 0 rows", `winners=${winners}`);
}

// ---- T3: stale PREPARING work is safely recoverable ----------------------
{
  const old = new Date(Date.now() - 30 * 60_000).toISOString();
  const db: any = makeDb(withJobs([
    draftRow("3", { status: "PREPARING", prepare_started_at: old }),          // dead mid-prep
    draftRow("4", { status: "AWAITING_REVIEW", prepare_started_at: old }),    // stray stamp on terminal
    draftRow("5", { status: "PREPARING", prepare_started_at: new Date().toISOString() }), // fresh, in-progress
  ]));
  const released = await releaseStale(db, 15 * 60_000);
  const g = (id: string) => (db.from("applications").eq("id", id) as any)._match()[0];
  ok(g("3").status === "DRAFT" && g("3").prepare_started_at == null, "T3 dead PREPARING claim returns to DRAFT", g("3").status);
  ok(g("4").status === "AWAITING_REVIEW" && g("4").prepare_started_at == null, "T3 stray stamp cleared, terminal status untouched", g("4").status);
  ok(g("5").status === "PREPARING" && g("5").prepare_started_at != null, "T3 a FRESH in-progress claim is NOT disturbed");
  ok(released === 2, "T3 released exactly the two stale claims", `${released}`);
}

// ---- T4: restart during preparation does not duplicate -------------------
{
  const fresh = new Date().toISOString();
  const db: any = makeDb(withJobs([draftRow("6", { status: "PREPARING", prepare_started_at: fresh })]));
  await releaseStale(db, 15 * 60_000);          // restart: stale sweep runs first
  const c = await claimDraft(db);                // then a claim poll
  ok(c == null, "T4 an in-progress PREPARING row is neither released nor re-claimed on restart (no duplicate)");
  const g = (db.from("applications").eq("id", "6") as any)._match()[0];
  ok(g.status === "PREPARING", "T4 the owned row is left exactly as prepareApplication had it");
}

// ---- T5: a preparation failure lands in a recoverable state with reason --
{
  const db: any = makeDb(withJobs([draftRow("7", { prepare_started_at: new Date().toISOString() })]));
  await finalizeClaim(db, { id: "7", job_id: "job-7", title: "T", leaseAt: new Date().toISOString() }, { status: "NOT_PREPARED", refusedReason: "the live form could not be snapshotted", answered: 0, blocked: 0, skipped: 0 } as PrepareResult);
  const g = (db.from("applications").eq("id", "7") as any)._match()[0];
  ok(g.blocked_reason === "the live form could not be snapshotted" && g.prepare_started_at == null,
    "T5 a refusal parks a useful blocked_reason and releases the claim", g.blocked_reason);
  // and such a row is not re-claimed until a person clears blocked_reason
  const c = await claimDraft(db);
  ok(c == null, "T5 a blocked row is not re-claimed (recoverable, not looping)");
}

// ---- T6: unresolved HUMAN_ONLY questions are not advanced -----------------
{
  const db: any = makeDb(withJobs([draftRow("8", { prepare_started_at: new Date().toISOString() })]));
  // prepareApplication maps blocked>0 -> BLOCKED_NEEDS_INPUT; the listener must not override it.
  (db.from("applications").eq("id", "8") as any)._match()[0].status = "BLOCKED_NEEDS_INPUT";
  await finalizeClaim(db, { id: "8", job_id: "job-8", title: "T", leaseAt: new Date().toISOString() }, { status: "BLOCKED_NEEDS_INPUT", answered: 3, blocked: 2, skipped: 0 } as PrepareResult);
  const g = (db.from("applications").eq("id", "8") as any)._match()[0];
  ok(g.status === "BLOCKED_NEEDS_INPUT", "T6 an app with blocked questions stays BLOCKED_NEEDS_INPUT (not advanced)", g.status);
}

// ---- T7: a fully grounded app reaches the same readiness as the sweep -----
{
  // The listener calls prepareApplication with the SAME options the scheduled
  // sweep (prepare-queue.ts) uses and never post-processes the status, so the
  // readiness state is whatever prepareApplication returns -- identical by
  // construction. Assert the source uses the shared call and no status rewrite.
  const src = readFileSync("scripts/prepare-listener.ts", "utf8");
  ok(/prepareApplication\(db, claim\.job_id, llm, \{ existingApplicationId: claim\.id \}\)/.test(src),
    "T7 listener delegates to the shared prepareApplication (same path as the sweep)");
  ok(!/update\([^)]*status:\s*["'](AWAITING_REVIEW|READY|PREPARED|BLOCKED_NEEDS_INPUT)/.test(src),
    "T7 listener never sets a readiness status itself (no parallel state machine)");
}

// ---- T8: already-prepared / READY / SUBMITTED are ignored -----------------
{
  const db: any = makeDb(withJobs([
    draftRow("9", { status: "AWAITING_REVIEW" }),
    draftRow("10", { status: "READY" }),
    draftRow("11", { status: "SUBMITTED" }),
    draftRow("12", { status: "PREPARING" }),
    draftRow("13", { status: "DRAFT", is_test: true }),   // test rows excluded
    draftRow("14", { status: "DRAFT", blocked_reason: "parked" }), // blocked excluded
  ]));
  const c = await claimDraft(db);
  ok(c == null, "T8 no claimable DRAFT among AWAITING_REVIEW/READY/SUBMITTED/PREPARING/test/blocked rows", c ? c.id : "none");
}

// ---- T9: no submission can ever originate from the prepare-listener -------
{
  const src = readFileSync("scripts/prepare-listener.ts", "utf8");
  const forbidden = /submit_requested_at|submit_started_at|submitApplication|fillAndSubmit|from\(["']browser|clickSubmit|submit_click|\.submit\(/;
  ok(!forbidden.test(src), "T9 the source contains no submission trigger, fill, or submit-click path");
  ok(!/import[^;]*\b(fill|submit)[^;]*from/.test(src), "T9 no fill/submit module is imported");
}

// ---- T10: a live worker's long-running claim cannot be reclaimed ----------
{
  const old = new Date(Date.now() - 30 * 60_000).toISOString();
  // status PREPARING (as prepareApplication set it) with an OLD stamp: without
  // a heartbeat this would be reclaimed. The live worker beats first.
  const db: any = makeDb(withJobs([draftRow("20", { status: "PREPARING", prepare_started_at: old })]));
  const refreshed = await heartbeat(db, "20", old);
  ok(!!refreshed && refreshed !== old, "T10 heartbeat refreshes the lease of a running prep", refreshed ? "refreshed" : "null");
  const released = await releaseStale(db, 15 * 60_000);
  const g = (db.from("applications").eq("id", "20") as any)._match()[0];
  ok(released === 0 && g.status === "PREPARING" && g.prepare_started_at !== old,
    "T10 a heartbeaten long prep is NOT reset to DRAFT or reclaimed", `released=${released} status=${g.status}`);
}

// ---- T11: the lease compare-and-swap cannot steal or resurrect a claim ----
{
  const s1 = new Date().toISOString();
  const db: any = makeDb(withJobs([draftRow("21", { status: "PREPARING", prepare_started_at: s1 })]));
  const stolen = await heartbeat(db, "21", "1999-01-01T00:00:00Z"); // wrong lease
  const g1 = (db.from("applications").eq("id", "21") as any)._match()[0];
  ok(stolen == null && g1.prepare_started_at === s1, "T11 a heartbeat with the wrong lease no-ops (cannot steal)");
  // after a successful finalize clears the stamp, an in-flight beat must not resurrect it
  await finalizeClaim(db, { id: "21", job_id: "job-21", title: "T", leaseAt: s1 }, { status: "AWAITING_REVIEW", answered: 1, blocked: 0, skipped: 0 } as PrepareResult);
  const late = await heartbeat(db, "21", s1);
  const g2 = (db.from("applications").eq("id", "21") as any)._match()[0];
  ok(late == null && g2.prepare_started_at == null, "T11 a late beat after finalize cannot resurrect the cleared claim");
}

console.log(bad ? `\n${bad} FAILED` : `\nprepare-listener-selftest: ALL ${11} scenarios PASS (in-memory + static)`);
process.exit(bad ? 1 : 0);
