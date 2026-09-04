import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../../lib/portal/supabase.ts";

/**
 * Regenerate: a NEW generation from the same pasted posting.
 *
 * Never touches the prior one. Its resume and PDF are immutable, so a
 * regenerate is always a fresh row, a fresh composition and a fresh
 * artifact -- the old download keeps working exactly as it did.
 */
export async function POST(_request: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await props.params;
  const store = await cookies();
  const db = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { data: prior } = await db.from("resume_generations")
    .select("pasted_text,pasted_html,detected_title,detected_company,corrected_title,corrected_company")
    .eq("id", id).maybeSingle();
  if (!prior) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data, error } = await db.from("resume_generations").insert({
    pasted_text: prior.pasted_text,
    pasted_html: prior.pasted_html,
    detected_title: prior.detected_title,
    detected_company: prior.detected_company,
    corrected_title: prior.corrected_title,
    corrected_company: prior.corrected_company,
  }).select("id").single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "could not queue" }, { status: 500 });

  return NextResponse.json({ id: data.id });
}
