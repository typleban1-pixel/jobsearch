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
  const store = await cookies();
  const client = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return { userId: data.user.id, email: data.user.email ?? null, client };
}

/** True when the session belongs to the account this system exists for. */
export async function isOwner(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client.rpc("is_app_owner");
  return !error && data === true;
}
