/**
 * Real-browser fill reliability, by platform. Deterministic and rerunnable.
 *
 *   node scripts/fill-reliability.ts
 *
 * Every row is a REAL browser execution recorded in application_fill_runs
 * (a Playwright run against a live employer form). Unit tests never appear
 * here. Submissions/confirmations are read from applications + application_events
 * so the picture runs job -> fill -> upload -> readback -> submit -> confirmation.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const page = async (t: string, c: string, x: (q: any) => any = (q) => q) => {
  const o: any[] = []; for (let f = 0; ; f += 1000) { const { data, error } = await x(db.from(t).select(c)).order("id").range(f, f + 999); if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break; } return o;
};

const runs = await page("application_fill_runs",
  "application_id,provider,outcome,fields_filled,fields_left_blank,resume_id,artifact_sha256,submit_click_attempted,guard_report,started_at,finished_at");
const apps = new Map((await page("applications", "id,status,is_test,submit_outcome,submitted_at,confirmation_reference")).map((a: any) => [a.id, a]));

// Real applications only (test apps are purged, but guard anyway).
const real = runs.filter((r: any) => { const a = apps.get(r.application_id); return a && !a.is_test; });

const providers = [...new Set(real.map((r: any) => r.provider))].sort();
const guardHits = (g: any) => (g?.submitAttempts?.length ?? 0) + (g?.programmatic?.length ?? 0) + (g?.blockedRequests?.length ?? 0);

console.log(`REAL-BROWSER FILL RELIABILITY  (${real.length} runs across ${new Set(real.map((r: any) => r.application_id)).size} applications)\n`);
for (const p of providers) {
  const rs = real.filter((r: any) => r.provider === p);
  const byApp = new Map<string, any[]>();
  for (const r of rs) { const a = byApp.get(r.application_id) ?? []; a.push(r); byApp.set(r.application_id, a); }
  const handoff = rs.filter((r: any) => r.outcome === "HANDOFF");
  const outcomes: Record<string, number> = {};
  for (const r of rs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const filledSum = rs.reduce((s: number, r: any) => s + (r.fields_filled ?? 0), 0);
  const blankSum = rs.reduce((s: number, r: any) => s + (r.fields_left_blank ?? 0), 0);
  const withArtifact = rs.filter((r: any) => r.artifact_sha256).length;
  const guardFirings = rs.filter((r: any) => guardHits(r.guard_report) > 0).length;
  // recovery: an application whose LATEST run is HANDOFF but had an earlier non-HANDOFF run
  let recovered = 0, retriedApps = 0;
  for (const [, list] of byApp) {
    if (list.length > 1) retriedApps += 1;
    const sorted = list.slice().sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
    if (sorted.length > 1 && sorted[sorted.length - 1]!.outcome === "HANDOFF" && sorted.slice(0, -1).some((r) => r.outcome !== "HANDOFF")) recovered += 1;
  }
  console.log(`== ${p} ==`);
  console.log(`  runs: ${rs.length}  applications: ${byApp.size}  reached HANDOFF: ${handoff.length} run(s) on ${new Set(handoff.map((r: any) => r.application_id)).size} app(s)`);
  console.log(`  fields filled (sum): ${filledSum}   left blank (sum): ${blankSum}`);
  console.log(`  runs that staged the résumé artifact: ${withArtifact}/${rs.length}  (server-side upload proof is per-run in .fill-runs/*/run.json)`);
  console.log(`  runs with a submission guard firing: ${guardFirings}`);
  console.log(`  retried applications (>1 run): ${retriedApps}   recovered after retry (later HANDOFF): ${recovered}`);
  console.log(`  outcomes: ${Object.entries(outcomes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ")}`);
}

// Submissions / confirmations (the end of the chain).
const submittedApps = [...apps.values()].filter((a: any) => !a.is_test && a.submitted_at);
const confirmed = submittedApps.filter((a: any) => a.submit_outcome === "CONFIRMED" || a.confirmation_reference);
console.log(`\n== SUBMISSIONS (chain end) ==`);
console.log(`  applications submitted (submitted_at set): ${submittedApps.length}`);
console.log(`  with employer confirmation (CONFIRMED / confirmation_reference): ${confirmed.length}`);
const subOutcomes: Record<string, number> = {};
for (const a of submittedApps) subOutcomes[a.submit_outcome ?? "(none)"] = (subOutcomes[a.submit_outcome ?? "(none)"] ?? 0) + 1;
console.log(`  submit_outcome: ${Object.entries(subOutcomes).map(([k, v]) => `${k}=${v}`).join("  ")}`);

// Failure-class glossary present in the data (for the self-healing loop).
const classes = [...new Set(real.map((r: any) => r.outcome))].filter((o) => o !== "HANDOFF").sort();
console.log(`\n== FAILURE CLASSES OBSERVED (non-HANDOFF outcomes) ==\n  ${classes.join(", ")}`);
