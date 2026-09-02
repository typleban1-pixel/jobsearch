import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../lib/portal/supabase.ts";

/**
 * Password sign-in, server side.
 *
 * The credentials never reach a browser Supabase client: the form posts
 * here, this exchanges them for a session, and the session lands in
 * httpOnly cookies the page JavaScript cannot read.
 *
 * A failure says "those credentials are not valid" without saying which
 * half was wrong or whether the address exists.
 */
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const nextPath = String(form.get("next") ?? "/");
  const target = nextPath.startsWith("/") && !nextPath.startsWith("//") ? nextPath : "/";

  const store = await cookies();
  const client = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });

  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    const back = new URL("/login", request.url);
    back.searchParams.set("error", "Those credentials are not valid.");
    if (target !== "/") back.searchParams.set("next", target);
    return NextResponse.redirect(back, { status: 303 });
  }
  return NextResponse.redirect(new URL(target, request.url), { status: 303 });
}
