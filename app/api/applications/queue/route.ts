import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";
import { classifyQueueJob } from "../../../../lib/applications/queueDecision.ts";

/**
 * Queue several jobs at once: create a DRAFT application for each.
 *
 * "Queue" means "prepare this application", nothing more. It creates
 * DRAFTs only -- the local worker does the tailoring and the listener
 * does the submitting, unchanged. No candidacy, Model 4, Formula 3,
 * Match Score or submission policy is touched here.
 *
 * Per-job results, so a partial failure is safe and legible: one
 * ineligible or already-applied job never stops the rest, and an
 * already-submitted opening is never re-queued. Deduplication is by the
 * canonical opening (one live application per requisition), enforced by
 * the database index as well as checked here, so a double-click cannot
 * create two.
 */
type Outcome = { jobId: string; ok: boolean; state: string; applicationId?: string; message: string };

const LIVE = "(REJECTED,WITHDRAWN,ABANDONED)";

export async function POST(request: Request): Promise<Response> {
  const store = await cookies();
  const db = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const jobIds: string[] = Array.isArray(body.jobIds)
    ? [...new Set((body.jobIds as unknown[]).map((x) => String(x)))].slice(0, 100) : [];
  if (!jobIds.length) return NextResponse.json({ error: "no jobs selected" }, { status: 400 });

  const [{ data: jobs }, { data: versions }, { data: cand }] = await Promise.all([
    db.from("jobs").select("id,canonical_opening_id,status,eligibility").in("id", jobIds),
    db.from("job_versions").select("id,job_id,is_current").in("job_id", jobIds).eq("is_current", true),
    db.from("job_candidacy").select("job_id,verdict,created_at").in("job_id", jobIds),
  ]);
  const jobById = new Map((jobs ?? []).map((j: any) => [j.id, j]));
  const versionByJob = new Map((versions ?? []).map((v: any) => [v.job_id, v.id]));
  const verdictByJob = new Map<string, string>();
  for (const c of (cand ?? []).sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))) {
    if (!verdictByJob.has(c.job_id)) verdictByJob.set(c.job_id, c.verdict);
  }

  // Live applications already on any of these openings.
  const openingIds = [...new Set((jobs ?? []).map((j: any) => j.canonical_opening_id).filter(Boolean))];
  const liveByOpening = new Map<string, string>();
  if (openingIds.length) {
    const { data: live } = await db.from("applications")
      .select("id,status,canonical_opening_id").in("canonical_opening_id", openingIds)
      .not("status", "in", LIVE);
    for (const a of live ?? []) if (!liveByOpening.has(a.canonical_opening_id)) liveByOpening.set(a.canonical_opening_id, a.status);
  }

  const results: Outcome[] = [];
  for (const jobId of jobIds) {
    const j = jobById.get(jobId);
    const versionId = versionByJob.get(jobId);
    const d = classifyQueueJob({
      job: j, verdict: verdictByJob.get(jobId), versionId,
      hasLiveApplication: !!j?.canonical_opening_id && liveByOpening.has(j.canonical_opening_id),
    });
    if (d.state !== "queue") {
      results.push({ jobId, ok: d.state === "already", state: d.state, message: d.message });
      continue;
    }

    const { data: created, error } = await db.from("applications").insert({
      job_id: jobId, job_version_id: versionId, canonical_opening_id: j.canonical_opening_id,
      status: "DRAFT", submission_mode: "ASSISTED",
    }).select("id").maybeSingle();
    if (error) {
      // A unique-violation means a concurrent request (or a double-click) already
      // created the one live application. That is success, not a failure.
      const dup = /duplicate|unique|already/i.test(error.message);
      results.push({ jobId, ok: dup, state: dup ? "already" : "error", message: dup ? "already queued" : error.message.slice(0, 120) });
      continue;
    }
    if (j.canonical_opening_id) liveByOpening.set(j.canonical_opening_id, "DRAFT"); // guard the rest of this batch
    results.push({ jobId, ok: true, state: "queued", applicationId: created!.id, message: "queued" });
  }

  const queued = results.filter((r) => r.state === "queued").length;
  return NextResponse.json({ queued, results });
}
