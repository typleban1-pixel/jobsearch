import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../lib/portal/supabase.ts";

/**
 * Saving and dismissing, as an ordinary form post.
 *
 * A route handler rather than a server action, deliberately: the forms
 * work without JavaScript, the endpoint can be exercised with curl, and a
 * failure surfaces as a status code rather than as "Connection closed".
 *
 * Recorded against the canonical opening, so dismissing one city variant
 * of a five-city requisition dismisses the requisition rather than
 * leaving four copies behind.
 */
export async function POST(request: Request): Promise<Response> {
  // Authorization is enforced twice and by two mechanisms: no session
  // means no write here, and RLS means no write even with one unless
  // is_app_owner() holds.
  const store = await cookies();
  const db = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const form = await request.formData();
  const openingId = String(form.get("openingId") ?? "");
  const jobId = String(form.get("jobId") ?? "");
  const state = String(form.get("state") ?? "");
  const returnTo = String(form.get("returnTo") ?? "/");

  if (!openingId) return NextResponse.json({ error: "no opening" }, { status: 400 });

  // CLEAR is an UPDATE to UNDECIDED, not a DELETE. The portal is granted
  // no DELETE on any table, and the withdrawn decision is worth keeping.
  const next = state === "CLEAR" ? "UNDECIDED" : state;
  if (next === "SAVED" || next === "NOT_INTERESTED" || next === "UNDECIDED") {
    const { error } = await db.from("job_interest").upsert(
      {
        canonical_opening_id: openingId,
        decided_from_job_id: jobId || null,
        state: next,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "canonical_opening_id" },
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    return NextResponse.json({ error: `unknown state ${state}` }, { status: 400 });
  }

  // Same-origin only. A returnTo from elsewhere would make this an open
  // redirect, which is not something a save button needs to be.
  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  return NextResponse.redirect(new URL(safe, request.url), { status: 303 });
}
