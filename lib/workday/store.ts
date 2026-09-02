/**
 * Reading and writing tenant state. No secrets pass through here.
 *
 * The only credential-shaped thing this touches is credential_ref, which
 * is a keychain ITEM NAME. The check constraints in migration 0081
 * enforce that at the database level, so a future mistake in this file
 * is refused by the schema rather than silently stored.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkdayTenant } from "./tenant.ts";
import type { AccountState, SessionState } from "./authPlan.ts";
import type { WorkdayPageState } from "./pageState.ts";
import { refToString, keychainRef } from "./keychain.ts";

export interface TenantRow {
  id: string;
  host: string;
  tenant: string;
  site: string | null;
  company_id: string | null;
  account_state: AccountState;
  session_state: SessionState;
  credential_ref: string | null;
  account_created_at: string | null;
  last_authenticated_at: string | null;
  last_checked_at: string | null;
  handoff_reason: string | null;
  last_page_state: string | null;
}

export async function loadTenants(db: SupabaseClient): Promise<Map<string, TenantRow>> {
  const { data, error } = await db.from("workday_tenants").select("*");
  if (error) throw new Error(`workday_tenants: ${error.message}`);
  return new Map((data ?? []).map((r: any) => [r.host, r as TenantRow]));
}

/** Creates the row for a tenant if it does not exist yet. */
export async function ensureTenant(
  db: SupabaseClient, t: WorkdayTenant, companyId: string | null,
): Promise<void> {
  const { error } = await db.from("workday_tenants")
    .upsert({ host: t.host, tenant: t.tenant, site: t.site, company_id: companyId,
              updated_at: new Date().toISOString() }, { onConflict: "host" });
  if (error) throw new Error(`ensureTenant(${t.host}): ${error.message}`);
}

/**
 * Records what a check observed.
 *
 * session_state is only ever written from what was actually seen. A
 * check that proved nothing writes UNKNOWN rather than leaving a stale
 * VALID in place, because a stale VALID is the one value that would make
 * the next run skip a login it needed.
 */
export async function recordObservation(db: SupabaseClient, input: {
  host: string;
  pageState: WorkdayPageState;
  sessionState: SessionState;
  accountState: AccountState;
  handoffReason: string | null;
  authenticated: boolean;
}): Promise<void> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    session_state: input.sessionState,
    account_state: input.accountState,
    last_page_state: input.pageState,
    handoff_reason: input.handoffReason,
    last_checked_at: now,
    updated_at: now,
  };
  if (input.authenticated) patch["last_authenticated_at"] = now;
  const { error } = await db.from("workday_tenants").update(patch).eq("host", input.host);
  if (error) throw new Error(`recordObservation(${input.host}): ${error.message}`);
}

/** Records that a credential now exists for this tenant. The NAME only. */
export async function recordCredential(db: SupabaseClient, host: string, created: boolean): Promise<void> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    credential_ref: refToString(keychainRef(host)),
    account_state: "EXISTS",
    updated_at: now,
  };
  if (created) patch["account_created_at"] = now;
  const { error } = await db.from("workday_tenants").update(patch).eq("host", host);
  if (error) throw new Error(`recordCredential(${host}): ${error.message}`);
}
