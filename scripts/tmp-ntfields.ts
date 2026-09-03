import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { tenantFromToken, candidateHomeUrl } from "../lib/workday/tenant.ts";
import { observe, waitForWorkdayReady, readSignals } from "../lib/workday/probe.ts";
import { snapshotLive } from "../lib/browser/liveSnapshot.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const ID = "35eaed21-599e-4480-bc7b-192677c80f18";
const { data: app } = await db.from("applications").select("id,job_id,status").eq("id", ID).single();
const { data: job } = await db.from("jobs").select("id,title,company_id,url,application_form_url").eq("id", app!.job_id).single();
const { data: co } = await db.from("companies").select("name,ats_token").eq("id", job!.company_id).single();
const tenant = tenantFromToken(co!.ats_token);
const ctx = await launchApplicationContext();
const p = await ctx.newPage();
p.setDefaultTimeout(45000);
// Settle properly: the auth state resolves AFTER the spinner clears.
// The utility bar resolves its auth state AFTER the spinner clears, and
// shows Sign In in the interim. Waiting for "either marker" therefore
// returns on the signed-out one every time. Wait for the AUTHENTICATED
// markers specifically; only a timeout means genuinely signed out.
const settle = async () => {
  await waitForWorkdayReady(p, 30000);
  await p.waitForFunction(() => {
    const q = (id: string) => document.querySelector(`[data-automation-id="${id}"]`);
    return Boolean(q("utilityButtonSignOut") || q("utilityButtonAccountTasksMenu")
      || q("candidateHomePage") || q("candidate-home-app"));
  }, null, { timeout: 20000 }).catch(() => {});
};
await p.goto(candidateHomeUrl(tenant), { waitUntil: "domcontentloaded" });
await settle();
const home = await observe(p, tenant);
console.log(`session: ${home.state}`);
if (home.state !== "SIGNED_IN") { console.log("not authenticated; stopping without any login attempt"); await ctx.close(); process.exit(1); }

const url = job!.application_form_url ?? job!.url;
console.log(`posting: ${url}`);
await p.goto(url!, { waitUntil: "domcontentloaded" });
await settle();
const post = await observe(p, tenant);
console.log(`posting page: ${post.state}`);
const s = await readSignals(p);
const applyish = s.automationIds.filter((i) => /apply|autofill|resume|manual|useMyLast/i.test(i));
console.log(`apply controls visible: ${JSON.stringify(applyish)}`);
const snap = await snapshotLive(p.mainFrame() as any).catch((e: any) => ({ error: String(e).slice(0,120) } as any));
console.log(`\nfields on the posting page: ${snap.fields?.length ?? JSON.stringify(snap)}`);
console.log(`loginWall=${snap.loginWall} captcha=${snap.captcha} forms=${snap.formCount}`);
if (snap.fields?.length) for (const f of snap.fields.slice(0, 20)) console.log(`   ${f.required ? "*" : " "} ${String(f.label).slice(0,52).padEnd(54)} ${f.htmlType}`);
await ctx.close();
