import { NextResponse } from "next/server";
import { currentSession } from "../../../lib/portal/session.ts";

/**
 * Store or remove an employer login. The password arrives ALREADY ENCRYPTED
 * by the browser to the worker's public key (see CredentialsForm), so this
 * route -- and everything downstream of it -- only ever handles ciphertext.
 * The DB CHECK in migration 0099 refuses anything that is not ciphertext.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const company_id = String(b?.company_id ?? "");
  const username = String(b?.username ?? "").trim();
  const secret_ciphertext = String(b?.secret_ciphertext ?? "");
  const encrypted_to = String(b?.encrypted_to ?? "");
  const ats = b?.ats ? String(b.ats) : null;
  const login_host = b?.login_host ? String(b.login_host) : null;
  if (!company_id || !username || !secret_ciphertext || !encrypted_to) {
    return NextResponse.json({ error: "company, username, encrypted password and key id are all required" }, { status: 400 });
  }

  const { error } = await session.client.from("portal_credentials").upsert(
    { company_id, username, secret_ciphertext, encrypted_to, ats, login_host, updated_at: new Date().toISOString() },
    { onConflict: "company_id" },
  );
  // A plaintext password would trip the secret_is_ciphertext CHECK here.
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const companyId = new URL(request.url).searchParams.get("company_id");
  if (!companyId) return NextResponse.json({ error: "no company" }, { status: 400 });
  const { error } = await session.client.from("portal_credentials").delete().eq("company_id", companyId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
