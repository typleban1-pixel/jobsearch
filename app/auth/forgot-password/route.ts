import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../lib/portal/supabase.ts";

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();

  const store = await cookies();
  const client = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });

  // redirectTo names the server route explicitly, so the link arrives as
  // a query string this app can read rather than as a fragment only the
  // browser can see.
  const redirectTo = new URL("/auth/confirm", request.url);
  redirectTo.searchParams.set("next", "/update-password");
  await client.auth.resetPasswordForEmail(email, { redirectTo: redirectTo.toString() });

  // Always the same answer. Whether an address has an account here is not
  // something a stranger gets to learn by asking.
  return NextResponse.redirect(new URL("/forgot-password?sent=1", request.url), { status: 303 });
}
