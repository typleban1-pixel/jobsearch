import "server-only";
import { cookies } from "next/headers";
import { userClient } from "./supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Session { userId: string; email: string | null; client: SupabaseClient }

/**
 * The signed-in owner, or null.
 *
 * Uses getUser(), which revalidates the token against Supabase, rather
 * than getSession(), which trusts whatever the cookie says. A cookie is
 * something the client sends.
 *
 * Being signed in is not the same as being the owner: is_app_owner()
 * decides what any session can actually see, so a valid session for a
 * different Supabase user reaches this point and then reads nothing.
 */
export async function currentSession(): Promise<Session | null> {
  const client = await cookieClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return { userId: data.user.id, email: data.user.email ?? null, client };
}

/**
 * The session check and the page's own reads, issued together.
 *
 * getUser() is a network round trip to Supabase Auth; every page paid it
 * before its first data request left. The reads run under the same cookie
 * token and RLS decides what they return, so issuing them alongside the
 * check changes nothing about what a session can see: an invalid or missing
 * token reads nothing, and the caller redirects before touching the result.
 * A read that fails is rethrown only for a verified session, so an anonymous
 * request always ends in the redirect and never in a 500.
 */
export async function withSession<T>(load: (db: SupabaseClient) => Promise<T>): Promise<{ session: Session; result: T } | null> {
  const client = await cookieClient();
  const [auth, settled] = await Promise.all([
    client.auth.getUser(),
    load(client).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })),
  ]);
  if (auth.error || !auth.data.user) return null;
  if (!settled.ok) throw settled.e;
  return { session: { userId: auth.data.user.id, email: auth.data.user.email ?? null, client }, result: settled.v };
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
