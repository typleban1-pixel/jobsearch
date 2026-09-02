import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../lib/portal/supabase.ts";
import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * The server-side half of an email link.
 *
 * Handles both shapes Supabase can send, because which one arrives
 * depends on the email template and the client flow, and a recovery route
 * that only understands one of them is a recovery route that fails at the
 * moment it is needed:
 *
 *   token_hash + type   verified here, no browser involvement at all
 *   code                PKCE, exchanged for a session
 *
 * The fragment shape cannot be handled here by definition; RecoveryHandoff
 * covers that one.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const code = url.searchParams.get("code");
  const requested = url.searchParams.get("next") ?? "/update-password";
  const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  const store = await cookies();
  const client = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });

  const fail = (message: string) => {
    const back = new URL("/login", request.url);
    back.searchParams.set("error", message);
    return NextResponse.redirect(back, { status: 303 });
  };

  if (tokenHash && type) {
    const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) return fail("That link has expired or has already been used. Request a new one.");
    return NextResponse.redirect(new URL(next, request.url), { status: 303 });
  }

  if (code) {
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (error) return fail("That link could not be verified. Request a new one.");
    return NextResponse.redirect(new URL(next, request.url), { status: 303 });
  }

  return fail("That link is missing its verification token.");
}
