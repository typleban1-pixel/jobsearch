import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";

/**
 * The status of one generation, for the page to poll while the Mac worker
 * runs. RLS scopes it to the owner. Nothing here is a secret; the pasted
 * text and the artifact bytes are fetched by their own routes.
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

  const { data, error } = await db.from("resume_generations")
    .select("id,status,resume_id,detected_title,detected_company,corrected_title,corrected_company,"
      + "artifact_sha256,tailoring_summary,error_category,error_detail,created_at,finished_at")
    .eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(data);
}
