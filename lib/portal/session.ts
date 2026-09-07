import "server-only";
import { cookies } from "next/headers";
import { userClient } from "./supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Session { userId: string; email: string | null; client: SupabaseClient }

/**
 * The signed-in owner, or null.
 *
 * Verifies the token (see verified()) rather than trusting getSession(),
 * which returns whatever the cookie says. A cookie is something the client
 * sends.
 *
 * Being signed in is not the same as being the owner: is_app_owner()
 * decides what any session can actually see, so a valid session for a
 * different Supabase user reaches this point and then reads nothing.
 */
export async function currentSession(): Promise<Session | null> {
  const client = await cookieClient();
  return verified(client, await client.auth.getClaims());
}

/**
 * The session a verified token describes, or null.
 *
 * getClaims() checks the token's signature against the project's JWKS
 * locally (cached per process) instead of asking Supabase Auth on every
 * request; it still refreshes an expired session. This is the same check
 * PostgREST applies to every query, so what a session can read is decided
 * exactly as before -- by RLS, against a signature-verified token.
 */
function verified(client: SupabaseClient, res: Awaited<ReturnType<SupabaseClient["auth"]["getClaims"]>>): Session | null {
  const claims = res.data?.claims;
  if (res.error || !claims?.sub) return null;
  return { userId: claims.sub, email: (claims.email as string | undefined) ?? null, client };
}

/**
 * The session check and the page's own reads, issued together.
 *
 * The session check used to be a network round trip to Supabase Auth that
 * every page paid before its first data request left. The reads run under the same cookie
 * token and RLS decides what they return, so issuing them alongside the
 * check changes nothing about what a session can see: an invalid or missing
 * token reads nothing, and the caller redirects before touching the result.
 * A read that fails is rethrown only for a verified session, so an anonymous
 * request always ends in the redirect and never in a 500.
 */
export async function withSession<T>(load: (db: SupabaseClient) => Promise<T>): Promise<{ session: Session; result: T } | null> {
  const client = await cookieClient();
  const [auth, settled] = await Promise.all([
    client.auth.getClaims(),
    load(client).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })),
  ]);
  const session = verified(client, auth);
  if (!session) return null;
  if (!settled.ok) throw settled.e;
  return { session, result: settled.v };
}

async function cookieClient(): Promise<SupabaseClient> {
  const store = await cookies();
  return userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });
}

/** True when the session belongs to the account this system exists for. */
export async function isOwner(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client.rpc("is_app_owner");
  return !error && data === true;
}
