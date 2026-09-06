#!/usr/bin/env -S node --env-file=.env.local
/**
 * Application-lifecycle selection semantics. The regression that matters:
 * a CLOSED application (incl. a dry-run/preflight that abandoned itself) must
 * NOT be reused and must NOT mark its opening as worked -- so the next real
 * worker can still prepare the job fresh. SUBMITTED and ACTIVE still occupy
 * the opening (exactly-once / no-duplicate).
 *   node scripts/application-lifecycle-selftest.ts
 */
import { isClosedApplication, activeApplicationByJob, openingsWorked, CLOSED_APP_STATUSES } from "../lib/applications/applicationLifecycle.ts";
let bad = 0;
const ok = (c: boolean, w: string) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}`); if (!c) bad++; };

for (const s of ["ABANDONED", "WITHDRAWN", "REJECTED"]) ok(isClosedApplication(s), `${s} is closed`);
for (const s of ["DRAFT", "PREPARING", "AWAITING_REVIEW", "READY_TO_SUBMIT", "BLOCKED_NEEDS_INPUT", "SUBMITTED"]) ok(!isClosedApplication(s), `${s} is NOT closed`);

// activeApplicationByJob
const abandoned = { job_id: "J1", status: "ABANDONED", submitted_at: null };
const active = { job_id: "J2", status: "AWAITING_REVIEW", submitted_at: null };
const both = [{ job_id: "J3", status: "ABANDONED", submitted_at: null }, { job_id: "J3", status: "AWAITING_REVIEW", submitted_at: null }];
const m = activeApplicationByJob([abandoned, active, ...both]);
ok(!m.has("J1"), "a job with ONLY a closed app has no active app -> prepares fresh");
ok(m.get("J2")?.status === "AWAITING_REVIEW", "an active app is the job's active app");
ok(m.get("J3")?.status === "AWAITING_REVIEW", "closed+active -> the active one wins (closed ignored)");

// openingsWorked -- the core regression
const jobOpening = (id: string) => ({ J1: "O1", J2: "O2", J4: "O4", J5: "O4" }[id] ?? null);
const worked = openingsWorked([
  { job_id: "J1", status: "ABANDONED", submitted_at: null },   // closed -> must NOT mark O1
  { job_id: "J2", status: "SUBMITTED", submitted_at: "x" },    // submitted -> marks O2
  { job_id: "J4", status: "AWAITING_REVIEW", submitted_at: null }, // active -> marks O4
], jobOpening);
ok(!worked.has("O1"), "a CLOSED app does NOT mark its opening worked (dry-run pollution cannot block the job)");
ok(worked.has("O2"), "a SUBMITTED app marks its opening worked (exactly-once / no re-apply)");
ok(worked.has("O4"), "an ACTIVE app marks its opening worked (no duplicate attempt)");
// A repost J5 of opening O4 is blocked only because of the ACTIVE J4, not a closed row.
ok(worked.has(jobOpening("J5") as string), "a repost sharing an opening with active work is deduped");

// Preflight-pollution regression, end to end: a dry-run abandoned app for the
// job must leave the job fully preparable (no active app, opening not worked).
const dryPollution = [{ job_id: "JX", status: "ABANDONED", submitted_at: null }];
ok(!activeApplicationByJob(dryPollution).has("JX") && !openingsWorked(dryPollution, () => "OX").has("OX"),
  "dry-run/preflight abandoned app leaves the job selectable for a fresh real attempt");

console.log(bad ? `\n${bad} FAILED` : `\napplication-lifecycle-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
