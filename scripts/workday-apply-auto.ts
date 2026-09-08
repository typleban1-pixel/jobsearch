/**
 * Autonomous sign-in + form discovery for one approved Workday application.
 *
 *   node scripts/workday-apply-auto.ts <application_id>
 *
 * SUPERVISED FIRST RUN. This drives a real browser against a real Workday
 * tenant; run it yourself and watch it before trusting it unattended. It is
 * the piece that was missing: the sign-in used to wait for you.
 *
 * WHAT IT DOES
 *   1. Syncs the portal-stored login for this employer into the keychain
 *      (decrypting on this Mac). No credential -> stops and tells you to
 *      approve the job and save the login (the two-tab flow).
 *   2. Signs in autonomously with that credential (authenticateTenant, with
 *      account CREATION OFF -- you create the account, per Path B; if the
 *      tenant has no account it hands off rather than making one).
 *   3. Hands the signed-in browser to the existing run-application (--attach),
 *      which walks the form, fills every answer it can from your profile, and
 *      records the ones it cannot as BLOCKED on /apply/questions. It STOPS at
 *      Review -- it never submits.
 *
 * WHY DISCOVERY, NOT SUBMIT: Workday hides the questions until you are signed
 * in. Running this soon after you save the login surfaces the whole form now,
 * so you can answer any blanks on the questions page BEFORE the scheduled run.
 * The scheduled run then submits only once nothing is BLOCKED (the submit gate,
 * built next). Nothing here submits.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { tenantFromToken, candidateHomeUrl } from "../lib/workday/tenant.ts";
import { observe, waitForWorkdayReady } from "../lib/workday/probe.ts";
import { authenticateTenant } from "../lib/workday/authenticate.ts";
import { unattendedDeps } from "../lib/workday/unattended.ts";
import { syncCredentialToKeychain } from "../lib/worker/resolveCredential.ts";

const applicationId = process.argv[2];
if (!applicationId) { console.error("usage: workday-apply-auto.ts <application_id>"); process.exit(2); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app } = await db.from("applications")
  .select("id,job_id,status,submitted_at,human_approved").eq("id", applicationId).single();
if (!app) { console.error("no such application"); process.exit(1); }
if (app.submitted_at) { console.error(`already submitted at ${app.submitted_at}`); process.exit(0); }

const { data: job } = await db.from("jobs").select("id,title,company_id,source").eq("id", app.job_id).single();
if (job!.source !== "WORKDAY") { console.error(`not a Workday job (${job!.source}); this script is Workday-only`); process.exit(1); }
const { data: company } = await db.from("companies").select("id,name,ats_token").eq("id", job!.company_id).single();
const tenant = tenantFromToken(company!.ats_token);
const { data: profile } = await db.from("profile").select("email_job_search").single();
const email = profile!.email_job_search as string;

console.log(`${company!.name} — ${job!.title}`);
console.log(`  application ${app.id.slice(0, 8)}  ${app.status}  approved=${app.human_approved}`);
console.log(`  tenant ${tenant.host}`);

// 1. Portal credential -> keychain (decrypt on this Mac).
const haveCred = await syncCredentialToKeychain(db, company!.id, tenant.host).catch((e) => {
  console.error(`  credential: ${String(e).slice(0, 160)}`); return false;
});
if (!haveCred) {
  console.error(`\nNo login stored for ${company!.name}. Approve the job in the portal and save the login`);
  console.error(`(the two-tab flow: create the account on the employer site, then /credentials). Stopping.`);
  process.exit(1);
}
console.log(`  credential: synced portal login into the keychain for ${tenant.host}`);

// 2. Autonomous sign-in. Creation stays off: this signs into an account you
//    already made; it never creates one.
const ctx = await launchApplicationContext({ debugPort: 9222 });
const page = await ctx.newPage();
page.setDefaultTimeout(60_000);
await page.goto(candidateHomeUrl(tenant), { waitUntil: "domcontentloaded" });
await waitForWorkdayReady(page).catch(() => undefined);

const deps = unattendedDeps({
  db, page, tenant, companyId: company!.id, companyName: company!.name, applicationId, email,
});
const result = await authenticateTenant(tenant, deps, { creationEnabled: false });
console.log(`\nsign-in outcome: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`);

if (result.outcome !== "AUTHENTICATED") {
  console.error(
    result.outcome === "ACCOUNT_REQUIRED"
      ? `\nNo account exists on ${tenant.host}. Create it on the employer site (the two-tab flow), then re-run. Stopping.`
      : `\nCould not sign in unattended (${result.outcome}). This one needs you: ${result.reason ?? "see above"}. Stopping.`,
  );
  await ctx.close().catch(() => undefined);
  process.exit(1);
}

// Confirm the session is really live before handing off.
const o = await observe(page, tenant).catch(() => null);
if (o?.state !== "SIGNED_IN") {
  console.error(`\nsigned-in check failed (observed ${o?.state ?? "unreadable"}); not proceeding to discovery.`);
  await ctx.close().catch(() => undefined);
  process.exit(1);
}
console.log(`signed in. Discovering the application form (fills what it can, records blanks, does NOT submit)…\n`);

// 3. Reuse the existing fill: attach to THIS signed-in browser and walk the
//    form to Review. Same process family keeps the session cookie alive.
const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, "workday-run-application.ts"), applicationId, "--attach"], { stdio: "inherit" });
const code: number = await new Promise((r) => child.on("close", (c) => r(c ?? 0)));

await ctx.close().catch(() => undefined);
console.log(
  code === 0
    ? `\nDiscovery run finished. Answer any BLOCKED questions on /apply/questions, then the scheduled run can submit.`
    : `\nDiscovery run exited ${code}; check the output above.`,
);
process.exit(code);
