/**
 * Which Workday tenant a job belongs to.
 *
 * Tenant isolation is the safety property of this whole subsystem, and
 * it starts here: everything downstream -- the keychain item, the
 * session probe, the state row -- is keyed by what this returns. If two
 * employers ever produced the same key, tenant A's credential would
 * authenticate tenant B.
 *
 * The key is the HOST, not the tenant word. Workday cookies are scoped
 * to the origin `{tenant}.wdN.myworkdayjobs.com`, so the host is exactly
 * the boundary the browser itself enforces, and keying on anything
 * coarser would claim an isolation the browser does not provide. The
 * site path is recorded but is NOT part of the key: one tenant may
 * publish several sites and they share one account.
 */
import { split } from "../ingest/providers/workday.ts";

export interface WorkdayTenant {
  /** ntrs.wd1.myworkdayjobs.com -- the cookie origin, and the key. */
  host: string;
  /** ntrs -- the tenant word, for display only. */
  tenant: string;
  /** northerntrust -- the careers site. Not part of identity. */
  site: string;
}

/** Parses an ats_token of the form "host/site". Throws on anything else. */
export function tenantFromToken(token: string): WorkdayTenant {
  const { host, tenant, site } = split(token);
  if (!host || !tenant || !site) throw new Error(`not a Workday token: ${JSON.stringify(token)}`);
  if (!/^[a-z0-9-]+\.wd\d{1,2}\.myworkdayjobs\.com$/i.test(host)) {
    throw new Error(`not a Workday host: ${JSON.stringify(host)}`);
  }
  return { host: host.toLowerCase(), tenant: tenant.toLowerCase(), site };
}

/** The same identity, read from a live URL rather than a stored token. */
export function tenantFromUrl(url: string): WorkdayTenant | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/^[a-z0-9-]+\.wd\d{1,2}\.myworkdayjobs\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  // An optional locale segment precedes the site: /en-US/northerntrust.
  const site = parts[0] && /^[a-z]{2}-[A-Z]{2}$/.test(parts[0]) ? parts[1] : parts[0];
  return {
    host: u.hostname.toLowerCase(),
    tenant: u.hostname.split(".")[0]!.toLowerCase(),
    site: site ?? "",
  };
}

/** The key every credential, session and state row is filed under. */
export const tenantKey = (t: WorkdayTenant): string => t.host;

/** Whether a URL belongs to this tenant. The isolation check. */
export function urlBelongsToTenant(url: string, t: WorkdayTenant): boolean {
  const other = tenantFromUrl(url);
  return other !== null && other.host === t.host;
}

/** The candidate home for a tenant site, where a session proves itself. */
export const candidateHomeUrl = (t: WorkdayTenant): string =>
  `https://${t.host}/${t.site}`;
