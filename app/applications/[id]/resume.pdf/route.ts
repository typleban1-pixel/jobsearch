import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";

/**
 * Serves the exact PDF that will be uploaded.
 *
 * The review screen embeds this, so what a person reads is the artifact
 * itself rather than a description of it. RLS still decides: the bytes
 * are read through the signed-in user's client, so a session that is not
 * the owner reads nothing.
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await props.params;
  const store = await cookies();
  const db = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { data: app } = await db.from("applications").select("resume_id").eq("id", id).maybeSingle();
  if (!app?.resume_id) return NextResponse.json({ error: "no resume" }, { status: 404 });

  const { data: resume } = await db.from("resumes")
    .select("artifact_pdf,artifact_sha256").eq("id", app.resume_id).maybeSingle();
  if (!resume?.artifact_pdf) return NextResponse.json({ error: "no rendered artifact" }, { status: 404 });

  const pdf = Buffer.from(resume.artifact_pdf, "base64");
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": "inline; filename=\"resume.pdf\"",
      // The fingerprint travels with the bytes, so what is on screen can
      // be checked against what approval recorded.
      "x-artifact-sha256": resume.artifact_sha256 ?? "",
      "cache-control": "no-store",
    },
  });
}
