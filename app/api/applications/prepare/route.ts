import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";

/**
 * Deciding to apply.
 *
 * This creates a DRAFT and freezes the posting version. It does no
 * preparation: snapshotting the form and tailoring the resume need the
 * model key, and the deployed portal holds a publishable Supabase key
 * and nothing else. The local worker completes DRAFTs.
 *
 * That split is a credential boundary. Moving preparation here would
 * mean putting an Anthropic key on Vercel.
 */
export async function POST(request: Request): Promise<Response> {
  const store = await cookies();
  const db = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const form = await request.formData();
  const jobId = String(form.get("jobId") ?? "");
  const returnTo = String(form.get("returnTo") ?? "/applications");
  if (!jobId) return NextResponse.json({ error: "no job" }, { status: 400 });

  const { data: job, error: jobErr } = await db.from("jobs")
    .select("id,canonical_opening_id").eq("id", jobId).single();
  if (jobErr || !job) return NextResponse.json({ error: "no such job" }, { status: 404 });

  const { data: version } = await db.from("job_versions")
    .select("id").eq("job_id", jobId).eq("is_current", true).maybeSingle();
  if (!version) return NextResponse.json({ error: "this posting has no current version to freeze" }, { status: 409 });

  // One live application per requisition. The database enforces this
  // across every published variant of the opening; checking first only
  // buys a readable message.
  if (job.canonical_opening_id) {
    const { data: live } = await db.from("applications")
      .select("id,status").eq("canonical_opening_id", job.canonical_opening_id)
      .not("status", "in", "(REJECTED,WITHDRAWN,ABANDONED)").limit(1);
    if (live?.length) {
      const safe = `/applications/${live[0]!.id}`;
      return NextResponse.redirect(new URL(safe, request.url), { status: 303 });
    }
  }

  const { data: created, error } = await db.from("applications").insert({
    job_id: job.id,
    job_version_id: version.id,
    canonical_opening_id: job.canonical_opening_id,
    status: "DRAFT",
    submission_mode: "ASSISTED",
  }).select("id").single();
  if (error || !created) return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });

  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/applications";
  return NextResponse.redirect(new URL(`${safe}`, request.url), { status: 303 });
}
