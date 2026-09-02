/**
 * Authenticates one Workday application's tenant, and stops there.
 *
 *   node scripts/workday-authenticate.ts <application_id> [--write]
 *
 * Resolves the tenant from the job's ats_token, loads the authoritative
 * workday_tenants row, inspects the real persistent browser session,
 * reuses it if valid, signs in with the tenant's keychain credential if
 * one exists, and otherwise reports what a person has to do.
 *
 * It does not create accounts, click consent controls, fill an
 * application, or submit anything. It writes to workday_tenants and to
 * nothing else: no application status, no approval, no authorization
 * mode, no hashes. An application that authenticates is exactly as
 * unapproved as it was before.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { tenantFromToken, candidateHomeUrl } from "../lib/workday/tenant.ts";
import { observe, waitForWorkdayReady, SEL, signIn as doSignIn } from "../lib/workday/probe.ts";
import { authenticateTenant } from "../lib/workday/authenticate.ts";
import { keychainRef, readPassword } from "../lib/workday/keychain.ts";
import { ensureTenant, loadTenants, recordObservation } from "../lib/workday/store.ts";

const applicationId = process.argv[2];
const WRITE = process.argv.includes("--write");
if (!applicationId) { console.error("usage: workday-authenticate.ts <application_id> [--write]"); process.exit(2); }
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app } = await db.from("applications")
  .select("id,job_id,status,submitted_at,human_approved,authorization_mode,is_test").eq("id", applicationId).single();
if (!app) { console.error("no such application"); process.exit(1); }
if (app.submitted_at) { console.error(`already submitted at ${app.submitted_at}; nothing to do`); process.exit(1); }

const { data: job } = await db.from("jobs").select("id,title,company_id,source").eq("id", app.job_id).single();
if (job!.source !== "WORKDAY") { console.error(`not a Workday job (${job!.source})`); process.exit(1); }
const { data: company } = await db.from("companies").select("id,name,ats_token").eq("id", job!.company_id).single();
const tenant = tenantFromToken(company!.ats_token);
const { data: profile } = await db.from("profile").select("email_job_search").single();
const email = profile!.email_job_search as string;

console.log(`${company!.name} — ${job!.title}`);
console.log(`  application ${app.id.slice(0, 8)}  ${app.status}  approved=${app.human_approved}  authMode=${app.authorization_mode ?? "none"}`);
console.log(`  tenant ${tenant.host} / ${tenant.site}`);

const prior = (await loadTenants(db).catch(() => new Map())).get(tenant.host);
const ref = keychainRef(tenant.host);
console.log(`  stored state: session=${prior?.session_state ?? "(no row)"} account=${prior?.account_state ?? "-"} credential=${prior?.credential_ref ?? "none"}`);

const ctx = await launchApplicationContext();
const page = await ctx.newPage();
page.setDefaultTimeout(30_000);
await page.goto(candidateHomeUrl(tenant), { waitUntil: "domcontentloaded" });
await waitForWorkdayReady(page);

const result = await authenticateTenant(tenant, {
  observe: async () => {
    await waitForWorkdayReady(page, 15_000);
    const o = await observe(page, tenant);
    console.log(`    observed: ${o.state}`);
    return { state: o.state, url: o.signals.url };
  },
  openSignIn: async () => {
    console.log("    opening the sign-in form");
    const b = await page.$('[data-automation-id="utilityButtonSignIn"]');
    if (b) { await b.click(); await page.waitForSelector(SEL.email, { timeout: 20_000 }).catch(() => { /* classified next pass */ }); }
  },
  // The password is read here and passed straight to the field. It is
  // never logged, never returned, and never put in a message.
  signIn: async (e, p) => { console.log("    signing in with the stored credential"); await doSignIn(page, e, p); },
  readCredential: () => readPassword(ref),
  email,
}, {
  creationEnabled: false,          // a separate, explicit authorisation
  everAuthenticated: Boolean(prior?.last_authenticated_at),
  priorAccountState: (prior?.account_state ?? "UNKNOWN") as any,
});

await ctx.close();

console.log(`\n  outcome: ${result.outcome}`);
console.log(`  path:    ${result.path.join(" -> ")}`);
if (result.reason) console.log(`  reason:  ${result.reason}`);

if (WRITE) {
  await ensureTenant(db, tenant, company!.id);
  await recordObservation(db, {
    host: tenant.host, pageState: result.finalState, sessionState: result.sessionState,
    accountState: result.accountState, handoffReason: result.reason,
    authenticated: result.outcome === "AUTHENTICATED",
  });
  console.log("  tenant state recorded");
}

// Proof, at the end of the run, that nothing about the application moved.
const { data: after } = await db.from("applications")
  .select("status,human_approved,authorization_mode,submitted_at").eq("id", applicationId).single();
const unchanged = after!.status === app.status && after!.human_approved === app.human_approved
  && after!.authorization_mode === app.authorization_mode && after!.submitted_at === app.submitted_at;
console.log(`  application unchanged by authentication: ${unchanged ? "yes" : "NO — DEFECT"}`);
