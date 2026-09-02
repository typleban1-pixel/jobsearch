import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../lib/portal/supabase.ts";

/**
 * Turns tokens from a recovery link into httpOnly session cookies.
 *
 * Called only by RecoveryHandoff, with values the browser read from a URL
 * fragment Supabase put there. The tokens are validated by setSession,
 * which rejects anything forged or expired, so accepting them here is no
 * weaker than the link itself.
 */
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const access_token = String(form.get("access_token") ?? "");
  const refresh_token = String(form.get("refresh_token") ?? "");
  if (!access_token || !refresh_token) {
    return NextResponse.json({ error: "missing tokens" }, { status: 400 });
  }

  const store = await cookies();
  const client = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });

  const { error } = await client.auth.setSession({ access_token, refresh_token });
  if (error) return NextResponse.json({ error: "invalid or expired link" }, { status: 401 });
  return NextResponse.json({ ok: true });
}
