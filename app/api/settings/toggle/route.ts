import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";

/**
 * The pause switches.
 *
 * Two things only: the per-provider pause in ats_policy, and the global
 * auto-submit switch in operating_policy. Nothing here changes what
 * auto_submit_enabled MEANS; it flips a flag that currently authorizes
 * nothing, because no worker reads it yet.
 */
export async function POST(request: Request): Promise<Response> {
  const store = await cookies();
  const db = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (n, v, o) => store.set(n, v, o as any),
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const form = await request.formData();
  const what = String(form.get("what") ?? "");
  const value = String(form.get("value") ?? "") === "1";
  const returnTo = "/settings";

  if (what === "global-auto-submit") {
    // Turning this ON is deliberately a separate decision from building
    // the policy that would use it, so the write is allowed but nothing
    // acts on it yet.
    const { data: policy } = await db.from("operating_policy").select("id").limit(1).single();
    if (!policy) return NextResponse.json({ error: "no operating policy row" }, { status: 500 });
    const { error } = await db.from("operating_policy")
      .update({ auto_submit_enabled: value }).eq("id", policy.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else if (what.startsWith("pause:")) {
    const provider = what.slice("pause:".length).toUpperCase();
    if (!/^[A-Z_]{2,32}$/.test(provider)) {
      return NextResponse.json({ error: "bad provider" }, { status: 400 });
    }
    const { error } = await db.from("ats_policy")
      .update({ paused: value, updated_at: new Date().toISOString() }).eq("provider", provider);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    return NextResponse.json({ error: "unknown switch" }, { status: 400 });
  }

  return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
}
