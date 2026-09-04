import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";
import { sanitizeClipboardHtml } from "../../../../lib/resume/sanitizeHtml.ts";

/**
 * Create one resume generation request.
 *
 * The portal has no Anthropic or service-role key: it can only write a
 * QUEUED row, exactly like "apply" writes a DRAFT. The Mac listener does
 * the work. Raw clipboard HTML is sanitized here, before insert, and the
 * plain text is what everything downstream reads.
 *
 * Exactly once: a second identical request that is still QUEUED or
 * PREPARING returns the first one's id instead of creating a duplicate,
 * so a double-click cannot produce two generations of the same paste.
 */
function db() {
  return cookies().then((store) => userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  }));
}

export async function POST(request: Request): Promise<Response> {
  const client = await db();
  const { data: auth } = await client.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const pastedText = String(body.pastedText ?? "").trim();
  const pastedHtml = sanitizeClipboardHtml(body.pastedHtml);
  const detectedTitle = body.detectedTitle ? String(body.detectedTitle).slice(0, 200) : null;
  const detectedCompany = body.detectedCompany ? String(body.detectedCompany).slice(0, 200) : null;
  const correctedTitle = body.correctedTitle ? String(body.correctedTitle).slice(0, 200) : null;
  const correctedCompany = body.correctedCompany ? String(body.correctedCompany).slice(0, 200) : null;

  if (pastedText.length < 40) {
    return NextResponse.json({ error: "the pasted posting is too short to work from" }, { status: 400 });
  }

  // Double-submit guard: an identical paste still in flight is the same request.
  const { data: inflight } = await client.from("resume_generations")
    .select("id").eq("pasted_text", pastedText).in("status", ["QUEUED", "PREPARING"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (inflight) return NextResponse.json({ id: inflight.id, deduplicated: true });

  const { data, error } = await client.from("resume_generations").insert({
    pasted_text: pastedText,
    pasted_html: pastedHtml,
    detected_title: detectedTitle,
    detected_company: detectedCompany,
    corrected_title: correctedTitle,
    corrected_company: correctedCompany,
  }).select("id").single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "could not queue" }, { status: 500 });

  return NextResponse.json({ id: data.id });
}
