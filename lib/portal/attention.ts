/**
 * How many applications need the person right now: the number on the
 * Applications navigation item.
 *
 * Not the total. Twenty applications with three waiting on a person is
 * "3". Computed the same way the Applications page sorts its rows -- the
 * same presentation rules over the same columns -- so the badge and the
 * page never disagree about what "needs you" means. The guard's refusals
 * are not consulted here (they need the full board), so a state only the
 * guard would change is counted as its row says.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { present, factsFromRow } from "./presentationState.ts";

export async function loadAttentionCount(db: SupabaseClient): Promise<number> {
  const [appsRes, policyRes] = await Promise.all([
    db.from("applications")
      .select("id,job_id,status,human_approved,all_fields_confident,submitted_at,submit_requested_at,submit_started_at,submit_outcome,blocked_reason,prepare_started_at")
      .is("submitted_at", null)
      .not("status", "in", "(ABANDONED,WITHDRAWN,REJECTED)")
      .or("is_test.is.null,is_test.eq.false"),
    db.from("ats_policy").select("provider,paused,capability"),
  ]);
  const apps = (appsRes.data ?? []) as any[];
  if (!apps.length) return 0;
  const policy = new Map(((policyRes.data ?? []) as any[]).map((p) => [p.provider, p]));
  const jobIds = [...new Set(apps.map((a) => a.job_id))];
  const [jobsRes, blockedRes] = await Promise.all([
    db.from("jobs").select("id,source").in("id", jobIds),
    db.from("application_answers").select("application_id").eq("confidence_state", "BLOCKED").in("application_id", apps.map((a) => a.id)),
  ]);
  const sourceOf = new Map(((jobsRes.data ?? []) as any[]).map((j) => [j.id, j.source]));
  const blocked = new Map<string, number>();
  for (const r of (blockedRes.data ?? []) as any[]) blocked.set(r.application_id, (blocked.get(r.application_id) ?? 0) + 1);
  let n = 0;
  for (const a of apps) {
    const provider = sourceOf.get(a.job_id) ?? "";
    const p = present(factsFromRow(a, provider, policy.get(provider), { blockedAnswers: blocked.get(a.id) ?? 0 }), a.id);
    if (p.state === "NEEDS_YOU") n++;
  }
  return n;
}
