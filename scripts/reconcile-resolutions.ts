/**
 * Companies whose board was verified but whose activation never landed.
 *
 * The resolver verifies a board, records the confirmed candidate, then
 * activates the company in a second write. When that second write dies
 * -- it did, mid network-storm -- the evidence says "this company has a
 * working board" while the company stays DISCOVERED, and the attempt
 * marker keeps it from being retried for a month. This closes that gap
 * from the evidence that already exists; it probes nothing.
 *
 *   node scripts/reconcile-resolutions.ts            report
 *   node scripts/reconcile-resolutions.ts --commit   activate
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
const COMMIT = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const confirmed: any[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("company_token_candidates")
    .select("company_id,company_name,ats_provider,candidate_token,source,source_url,job_count,tested_at")
    .eq("confirmed", true).order("id").range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  confirmed.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
}
let repaired = 0, checked = 0, failed = 0, duplicates = 0;
for (const c of confirmed) {
  const { data: co } = await db.from("companies").select("id,lifecycle,ats_token").eq("id", c.company_id).maybeSingle();
  if (!co) continue;
  checked++;
  if (co.lifecycle === "ACTIVE" && co.ats_token) continue;
  console.log(`stranded: ${c.company_name}  ${c.ats_provider}:${c.candidate_token}  (${c.job_count} jobs, verified ${String(c.tested_at).slice(0, 16)})`);
  if (!COMMIT) continue;
  const { error } = await db.from("companies").update({
    ats_provider: c.ats_provider, ats_token: c.candidate_token,
    ats_detection_method: c.source === "CAREERS_PAGE" ? `careers page: ${c.source_url}` : "token guess, activation reconciled",
    lifecycle: "ACTIVE", verified_at: c.tested_at,
    open_job_count: c.job_count, open_job_count_at: c.tested_at,
  }).eq("id", c.company_id);
  if (error && /companies_ats_provider_ats_token_key/.test(error.message)) {
    // Another company row already owns this exact board: the universe
    // holds the same employer twice (two discovery sources, one
    // Zendesk). The board is not stranded -- its owner is ACTIVE -- and
    // activating the twin would double-ingest every posting. The twin
    // is a duplicate row, reported as such.
    const { data: owner } = await db.from("companies").select("name,lifecycle")
      .eq("ats_provider", c.ats_provider).eq("ats_token", c.candidate_token).maybeSingle();
    console.log(`  duplicate of ${owner?.name ?? "another company"} (${owner?.lifecycle}); left DISCOVERED`);
    duplicates++;
  }
  else if (error) { console.log(`  ! ${error.message}`); failed++; }
  else { console.log(`  activated`); repaired++; }
}
console.log(`\n${checked} confirmed candidates checked; ${repaired} activated${COMMIT ? "" : " (dry run)"}; ${duplicates} duplicate company rows; ${failed} failed`);
if (failed) process.exit(1);
