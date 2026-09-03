import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { tenantFromToken, candidateHomeUrl } from "../lib/workday/tenant.ts";
import { observe, waitForWorkdayReady, clickWorkdayButton } from "../lib/workday/probe.ts";
import { snapshotLive } from "../lib/browser/liveSnapshot.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const ID = "35eaed21-599e-4480-bc7b-192677c80f18";
const { data: app } = await db.from("applications").select("id,job_id,status").eq("id", ID).single();
const { data: job } = await db.from("jobs").select("id,title,company_id,url,application_form_url,external_id").eq("id", app!.job_id).single();
const { data: co } = await db.from("companies").select("name,ats_token").eq("id", job!.company_id).single();
const tenant = tenantFromToken(co!.ats_token);
const url = job!.application_form_url ?? job!.url;
console.log(`${co!.name} — ${job!.title}\n  ${url}`);

const ctx = await launchApplicationContext();
const p = await ctx.newPage();
p.setDefaultTimeout(40000);
// 1. confirm the session
await p.goto(candidateHomeUrl(tenant), { waitUntil: "domcontentloaded" });
await waitForWorkdayReady(p);
const home = await observe(p, tenant);
console.log(`  candidate home: ${home.state}`);
if (home.state !== "SIGNED_IN") { console.log("  not authenticated; stopping"); await ctx.close(); process.exit(1); }

// 2. open the posting and look for the apply surface
await p.goto(url!, { waitUntil: "domcontentloaded" });
await waitForWorkdayReady(p);
const posting = await observe(p, tenant);
console.log(`  posting page: ${posting.state}  url=${p.url()}`);
const ids = posting.signals.automationIds.filter((i) => /apply|autofill|resume|manual/i.test(i));
console.log(`  apply-related controls: ${JSON.stringify(ids)}`);
// 3. snapshot whatever form is reachable WITHOUT clicking anything that submits
const snap = await snapshotLive(p.mainFrame() as any).catch((e: any) => ({ error: String(e).slice(0,120) } as any));
console.log(`  live snapshot: ${snap.fields ? `${snap.fields.length} field(s)` : JSON.stringify(snap)}`);
if (snap.fields?.length) for (const f of snap.fields.slice(0, 12)) console.log(`     ${f.required ? "*" : " "} ${String(f.label).slice(0,50).padEnd(52)} ${f.htmlType}`);
console.log(`  loginWall=${snap.loginWall} captcha=${snap.captcha} forms=${snap.formCount}`);
await ctx.close();
