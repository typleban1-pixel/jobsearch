import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../lib/portal/supabase.ts";

const MIN_LENGTH = 12;

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  const back = (message: string) => {
    const url = new URL("/update-password", request.url);
    url.searchParams.set("error", message);
    return NextResponse.redirect(url, { status: 303 });
  };

  if (password !== confirm) return back("Those two passwords do not match.");
  if (password.length < MIN_LENGTH) return back(`Use at least ${MIN_LENGTH} characters.`);

  const store = await cookies();
  const client = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });

  // A session is required, and updateUser enforces it too. Checked here so
  // an expired recovery session produces a sentence rather than a 500.
  const { data: auth } = await client.auth.getUser();
  if (!auth.user) {
    const login = new URL("/login", request.url);
    login.searchParams.set("error", "Your recovery session expired before the password was set. Request a new link.");
    return NextResponse.redirect(login, { status: 303 });
  }

  const { error } = await client.auth.updateUser({ password });
  if (error) return back(error.message);

  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
