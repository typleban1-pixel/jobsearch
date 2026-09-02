/**
 * What state every Workday tenant is actually in.
 *
 *   node scripts/workday-survey.ts            report only
 *   node scripts/workday-survey.ts --write    also record the state
 *   node scripts/workday-survey.ts --scratch  use a throwaway profile
 *
 * SESSION STATE IS ONLY MEANINGFUL FROM THE SIGNED-IN PROFILE
 *
 * The sessions live in .browser-profile. When the user's own Chrome
 * holds that profile's lock, taking it would mean killing their browser,
 * so --scratch runs from a throwaway one instead. A throwaway profile is
 * a signed-out visitor BY CONSTRUCTION, so a SIGN_IN_FORM seen from it
 * is not evidence that the real session expired. In that mode session
 * state is recorded as UNKNOWN and never as EXPIRED: the run is
 * observing the tenant's login SHAPE, not our standing with it.
 *
 * Read-only against the employers: it loads each tenant's public careers
 * site and classifies what comes back. It never signs in, never creates
 * an account, never types a credential and never clicks Apply. The point
 * is to answer "which of these do we already have a session for" without
 * doing anything that needs authorising.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { tenantFromToken, candidateHomeUrl } from "../lib/workday/tenant.ts";
import { observe, waitForWorkdayReady } from "../lib/workday/probe.ts";
import { planNext, sessionStateFrom, accountStateFrom, type AccountState } from "../lib/workday/authPlan.ts";
import { keychainRef, hasPassword } from "../lib/workday/keychain.ts";
import { ensureTenant, recordObservation, loadTenants } from "../lib/workday/store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRITE = process.argv.includes("--write");
const SCRATCH = process.argv.includes("--scratch");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: companies, error } = await db.from("companies")
  .select("id,name,ats_provider,ats_token").eq("ats_provider", "WORKDAY").not("ats_token", "is", null);
if (error) throw new Error(error.message);

const targets = (companies ?? []).flatMap((c: any) => {
  try { return [{ company: c, tenant: tenantFromToken(c.ats_token) }]; }
  catch (e) { console.log(`  skipped ${c.name}: ${String(e).slice(0, 80)}`); return []; }
});
console.log(`${targets.length} Workday tenants\n`);

// Loaded always, not only when writing: prior authentication history is
// what separates "expired" from "never signed in", so it informs the
// report as much as the write.
let existing = new Map<string, any>();
try { existing = await loadTenants(db); }
catch (e) { console.log(`workday_tenants not readable (${String(e).slice(0, 90)}); treating every tenant as never authenticated`); }

const profileDir = SCRATCH
  ? mkdtempSync(join(tmpdir(), "wd-survey-"))
  : ".browser-profile";
if (SCRATCH) console.log("using a throwaway profile: session state will be reported as UNKNOWN, not EXPIRED\n");
const ctx = await launchApplicationContext({ profileDir });
const page = await ctx.newPage();
page.setDefaultTimeout(30_000);

const rows: Array<{ name: string; host: string; state: string; session: string; cred: boolean; action: string; note: string }> = [];
for (const { company, tenant } of targets) {
  const cred = await hasPassword(keychainRef(tenant.host));
  let state = "BROWSER_ERROR", session = "UNKNOWN", action = "HANDOFF", note = "";
  try {
    await page.goto(candidateHomeUrl(tenant), { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Workday renders client-side and stamps a "loading" id before any
    // real content exists; waiting on that alone reads the spinner.
    const ready = await waitForWorkdayReady(page);
    if (!ready) note = "the tenant's page did not finish rendering within the timeout; ";
    const o = await observe(page, tenant);
    state = o.state;
    // A throwaway profile cannot speak to whether the real session is
    // alive. Reporting EXPIRED from it would be inventing a fact, and
    // the next run would act on it.
    //
    // Even on the real profile, EXPIRED needs a prior authentication to
    // have expired FROM: a tenant we never signed into is UNKNOWN, not
    // expired. last_page_state carries the actual observation.
    const everAuth = Boolean(existing.get(tenant.host)?.last_authenticated_at);
    session = SCRATCH ? "UNKNOWN" : sessionStateFrom(o.state, everAuth);
    const plan = planNext(o.state, { hasCredential: cred, signInAttempted: false, createAttempted: false, creationEnabled: false });
    action = plan.action;
    note += plan.reason ?? "";
    if (WRITE) {
      try {
        await ensureTenant(db, tenant, company.id);
        const prior = (existing.get(tenant.host)?.account_state ?? "UNKNOWN") as AccountState;
        await recordObservation(db, { host: tenant.host, pageState: o.state, sessionState: session as any,
          accountState: accountStateFrom(o.state, prior), handoffReason: plan.reason,
          authenticated: o.state === "SIGNED_IN" });
      } catch (e) { note += ` [not recorded: ${String(e).slice(0, 60)}]`; }
    }
  } catch (e) {
    note = String(e).split("\n")[0]!.slice(0, 90);
  }
  rows.push({ name: company.name, host: tenant.host, state, session, cred, action, note });
  console.log(`  ${state.padEnd(20)} ${action.padEnd(9)} cred=${cred ? "yes" : "no "}  ${company.name}`);
  if (note) console.log(`      ${note.slice(0, 120)}`);
}
await ctx.close();
if (SCRATCH) rmSync(profileDir, { recursive: true, force: true });

const tally = (k: "state" | "action") => {
  const m: Record<string, number> = {};
  for (const r of rows) m[r[k]] = (m[r[k]] ?? 0) + 1;
  return m;
};
console.log(`\npage states: ${JSON.stringify(tally("state"))}`);
console.log(`next action: ${JSON.stringify(tally("action"))}`);
if (SCRATCH) console.log("\n(from a throwaway profile: the session counts below describe a signed-out visitor,\n not the standing of the signed-in profile. Re-run without --scratch when Chrome is closed.)");
// SIGNED_OUT is a no-session state exactly like SIGN_IN_FORM; it is just
// observed one page earlier. Leaving it out of these buckets is what made
// a corrected survey still report "need an account: 0" for all nineteen.
const NO_SESSION = ["SIGNED_OUT", "SIGN_IN_FORM", "CREATE_ACCOUNT_FORM"];
const ACTIONABLE_STATES = ["SIGNED_IN", ...NO_SESSION, "JOB_POSTING"];
console.log(`\nreusable session now:         ${rows.filter((r) => r.state === "SIGNED_IN").length}`);
console.log(`need login (credential held): ${rows.filter((r) => NO_SESSION.includes(r.state) && r.cred).length}`);
console.log(`need an account:              ${rows.filter((r) => NO_SESSION.includes(r.state) && !r.cred).length}`);
console.log(`readable but not an account flow: ${rows.filter((r) => r.state === "JOB_POSTING").length}`);
console.log(`blocked or unreadable:        ${rows.filter((r) => !ACTIONABLE_STATES.includes(r.state)).length}`);
console.log(`\nnothing was signed in to, created, or submitted.`);
