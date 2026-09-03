/**
 * Resolution attempts must persist, loudly.
 *
 * Two failure shapes this guards against: an upsert whose error nobody
 * read (results silently absent), and a company that produced zero
 * candidates writing no row at all (looked never-attempted, re-probed
 * every run forever).
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

let n = 0, bad = 0;
const ok = (c: boolean, w: string) => { n++; if (!c) { bad++; console.error(`FAIL ${w}`); } };
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

// ---- 1. the no-candidates marker round-trips --------------------------
const { data: co } = await db.from("companies").select("id,name").limit(1).single();
const marker = {
  company_id: (co as any).id, company_name: (co as any).name,
  ats_provider: "UNKNOWN", candidate_token: `none:${(co as any).id}`,
  source: "NO_CANDIDATES", source_url: null, tested_at: new Date().toISOString(),
  test_result: "selftest marker", job_count: 0, confirmed: false,
};
{
  const { error } = await db.from("company_token_candidates")
    .upsert([marker], { onConflict: "ats_provider,candidate_token" });
  ok(!error, `the marker row persists (${error?.message ?? "ok"})`);
  const { data } = await db.from("company_token_candidates")
    .select("tested_at,confirmed").eq("candidate_token", marker.candidate_token).single();
  ok(Boolean(data?.tested_at), "the marker carries a tested_at, so the company counts as attempted");
  ok(data?.confirmed === false, "a marker is never a confirmation");
}

// ---- 2. re-upserting the same key is an update, not a duplicate -------
{
  const { error } = await db.from("company_token_candidates")
    .upsert([{ ...marker, test_result: "selftest marker updated" }], { onConflict: "ats_provider,candidate_token" });
  ok(!error, "the same key upserts again");
  const { data, count } = await db.from("company_token_candidates")
    .select("test_result", { count: "exact" }).eq("candidate_token", marker.candidate_token);
  ok(count === 1, `one row, not ${count}`);
  ok(data?.[0]?.test_result === "selftest marker updated", "and it carries the newer result");
}

// ---- 3. a broken write is detectable, not silent ----------------------
{
  const { error } = await db.from("company_token_candidates")
    .upsert([{ ...marker, company_id: "not-a-uuid" }], { onConflict: "ats_provider,candidate_token" });
  ok(Boolean(error), "a bad row yields an error object to check, not a quiet no-op");
}

// ---- 4. the due-filter respects markers -------------------------------
// Mirrors the resolver's own selection: a company whose only row is a
// fresh marker must NOT be due.
{
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data } = await db.from("company_token_candidates")
    .select("tested_at").eq("candidate_token", marker.candidate_token).single();
  const due = !data?.tested_at || data.tested_at < cutoff;
  ok(!due, "a freshly marked company is not due for re-probing");
}

// clean up the probe rows
await db.from("company_token_candidates").delete().eq("candidate_token", marker.candidate_token);
await db.from("company_token_candidates").delete().eq("candidate_token", "__probe_token__");

console.log(`${n - bad}/${n} assertions passed`);
process.exit(bad ? 1 : 0);
