import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";

/**
 * Serves the exact stored PDF for one resume, by resume id.
 *
 * A near-copy of the application resume route, minus the application hop:
 * the Resume Builder links a resume directly. RLS still decides -- the
 * bytes are read through the signed-in user's client -- and the stored
 * artifact SHA travels in a header so what is on screen (and what is
 * downloaded) can be checked against the immutable artifact.
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

  const { data: resume } = await db.from("resumes")
    .select("artifact_pdf,artifact_sha256").eq("id", id).maybeSingle();
  if (!resume?.artifact_pdf) return NextResponse.json({ error: "no rendered artifact" }, { status: 404 });

  const pdf = Buffer.from(resume.artifact_pdf, "base64");
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": "inline; filename=\"resume.pdf\"",
      "x-artifact-sha256": resume.artifact_sha256 ?? "",
      "cache-control": "no-store",
    },
  });
}
