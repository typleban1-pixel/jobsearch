import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../lib/portal/supabase.ts";

export async function POST(request: Request): Promise<Response> {
  const store = await cookies();
  const client = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });
  await client.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
