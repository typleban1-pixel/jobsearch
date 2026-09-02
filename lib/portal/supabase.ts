/**
 * The portal's Supabase clients.
 *
 * Every one of them uses the PUBLISHABLE key and runs as the signed-in
 * user, so RLS is the authorization boundary rather than the UI. The
 * service-role key is not read in this file, is not read by anything this
 * file imports, and must never appear anywhere under app/.
 *
 * No browser client
 * -----------------
 * The portal is server-rendered end to end and no client component talks
 * to Supabase, so there is no reason for JavaScript in the page to read
 * the session. That lets the auth cookies be httpOnly, which is the
 * stricter setting and is only unavailable to apps that need a browser
 * client. It also means no NEXT_PUBLIC_ variable is required at all.
 */
import "server-only";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { optional, required } from "../env.ts";

/** Accepts either name, so the value can live under whichever the deployment used. */
export function publishableKey(): string {
  const k = optional("SUPABASE_PUBLISHABLE_KEY")
    ?? optional("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
    ?? optional("SUPABASE_ANON_KEY")
    ?? optional("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!k) {
    throw new Error(
      "Missing the Supabase publishable key. Add SUPABASE_PUBLISHABLE_KEY to .env.local. " +
      "It does not need a NEXT_PUBLIC_ prefix: no browser code in this app talks to Supabase.",
    );
  }
  return k;
}

export function supabaseUrl(): string {
  return optional("SUPABASE_URL") ?? required("NEXT_PUBLIC_SUPABASE_URL");
}

/**
 * httpOnly, because nothing in the browser needs to read these. sameSite
 * lax so a normal top-level navigation back from a link still carries the
 * session. secure everywhere except plain-http localhost, where the
 * browser would otherwise refuse the cookie.
 */
export const AUTH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env["NODE_ENV"] === "production",
  path: "/",
};

export interface CookieStore {
  getAll(): Array<{ name: string; value: string }>;
  set(name: string, value: string, options: CookieOptions): void;
}

/** A client bound to one request's cookies. Runs as whoever is signed in. */
export function userClient(store: CookieStore): SupabaseClient {
  return createServerClient(supabaseUrl(), publishableKey(), {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll: () => store.getAll(),
      setAll: (cookies) => {
        for (const { name, value, options } of cookies) {
          // A server component cannot set cookies during render. Refresh
          // happens in proxy.ts, which can, so swallowing here is correct
          // rather than a shrug.
          try { store.set(name, value, { ...AUTH_COOKIE_OPTIONS, ...options }); } catch { /* read-only context */ }
        }
      },
    },
  });
}
