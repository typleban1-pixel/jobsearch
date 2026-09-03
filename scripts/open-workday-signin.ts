/**
 * Opens the automated profile at a tenant's careers site, and waits.
 *
 *   node scripts/open-workday-signin.ts <host>
 *
 * The sessions this system reuses live in .browser-profile, which is a
 * real Chrome profile and not the one a person browses with. A sign-in
 * performed in an ordinary window is invisible to the automation, which
 * is why an earlier consent click landed in the wrong place.
 *
 * So this opens THAT profile, navigates to the tenant, and holds the
 * window open until told to stop. It types nothing, clicks nothing and
 * touches no consent control: the whole point is that the person does
 * the signing in.
 */
import { existsSync, unlinkSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { tenantFromToken, candidateHomeUrl } from "../lib/workday/tenant.ts";
import { observe, waitForWorkdayReady } from "../lib/workday/probe.ts";

const host = process.argv[2] ?? "ntrs.wd1.myworkdayjobs.com";
const DONE = ".workday-signin-done";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: cos } = await db.from("companies").select("id,name,ats_token").eq("ats_provider", "WORKDAY");
const company = (cos ?? []).find((c: any) => { try { return tenantFromToken(c.ats_token).host === host; } catch { return false; } });
if (!company) { console.error(`no company for ${host}`); process.exit(1); }
const tenant = tenantFromToken(company.ats_token);

const ctx = await launchApplicationContext();
const page = await ctx.newPage();
page.setDefaultTimeout(60_000);
await page.goto(candidateHomeUrl(tenant), { waitUntil: "domcontentloaded" });
await waitForWorkdayReady(page, 30_000);

console.log(`${company.name} — ${tenant.host}/${tenant.site}`);
console.log(`profile: .browser-profile  (the one the automation reuses)`);
console.log(`\nThis window is the automated profile. Sign in HERE.`);
console.log(`Nothing is typed or clicked by this script.`);
console.log(`\nWatching the session; touch ${DONE} to close the window.\n`);

let last: string | null = null;
for (;;) {
  if (existsSync(DONE)) { unlinkSync(DONE); break; }
  let state = "UNREADABLE";
  try { state = (await observe(page, tenant)).state; } catch { /* mid-navigation */ }
  if (state !== last) {
    console.log(`  [${new Date().toISOString().slice(11, 19)}] ${state}`);
    last = state;
    if (state === "SIGNED_IN") console.log(`  a session now exists for ${tenant.host}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
await ctx.close();
console.log("closed. The session persists in the profile.");
