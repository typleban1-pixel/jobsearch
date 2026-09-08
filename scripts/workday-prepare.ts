/**
 * Prepares one Workday application end to end, unattended, in one browser.
 *
 *   node --env-file=.env.local scripts/workday-prepare.ts <application_id> [--keep-open] [--auto-signin]
 *
 * The sequence a person ran by hand for Northern Trust, in order, in the
 * one browser process that holds the tenant's session. By default the
 * PERSON creates the account or signs in in the opened window -- typing a
 * password to authenticate and creating an account are theirs to do -- and
 * this waits for a signed-in session before doing anything. Then: tailor
 * and bind the
 * résumé, open the application and fill its single controls, fill the
 * repeated Work Experience and Education blocks, upload the exact
 * artifact, add the evidenced skills, and run on to the Review page,
 * where the answer table is reconciled and the application becomes
 * AWAITING_REVIEW for the person's approval. Nothing here submits.
 *
 * Each step is the existing script, spawned attached to this browser
 * over the debugging port. A step that fails parks the application with
 * the step's name and last lines as the reason, and the browser is left
 * open when --keep-open is given so a person can look.
 */
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { required } from "../lib/env.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { tenantFromToken, candidateHomeUrl } from "../lib/workday/tenant.ts";
import { waitForWorkdayReady, observe } from "../lib/workday/probe.ts";
import { authenticateTenant } from "../lib/workday/authenticate.ts";
import { unattendedDeps, acceptLegalIfAuthorised } from "../lib/workday/unattended.ts";
import { loadTenants, ensureTenant, recordObservation } from "../lib/workday/store.ts";

const ID = process.argv[2];
const KEEP_OPEN = process.argv.includes("--keep-open");
if (!ID) { console.error("usage: workday-prepare.ts <application_id> [--keep-open] [--auto-signin]"); process.exit(2); }
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);

const { data: app } = await db.from("applications").select("id,job_id,status,resume_id,submitted_at,human_approved").eq("id", ID).single();
if (!app) { console.error("no such application"); process.exit(1); }
if (app.submitted_at) { console.error("already submitted"); process.exit(1); }
const { data: job } = await db.from("jobs").select("id,title,source,company_id,url").eq("id", app.job_id).single();
if (job!.source !== "WORKDAY") { console.error(`not a Workday job (${job!.source})`); process.exit(1); }
const { data: company } = await db.from("companies").select("id,name,ats_token").eq("id", job!.company_id).single();
const tenant = tenantFromToken(company!.ats_token);
const { data: profile } = await db.from("profile").select("email_job_search").single();
const email = profile!.email_job_search as string;
log(`${company!.name} — ${job!.title}  [${ID.slice(0, 8)} ${app.status}]  tenant ${tenant.host}`);

/** Parks the application with the reason; keeps its status. */
async function park(step: string, tail: string): Promise<void> {
  const reason = `WORKDAY_PREPARE stopped at ${step}: ${tail.replace(/\s+/g, " ").trim().slice(0, 400)}`;
  await db.from("applications").update({ blocked_reason: reason }).eq("id", ID);
  await db.from("application_events").insert({ application_id: ID, event: "WORKDAY_PREPARE_STOPPED", actor: "worker", detail: reason })
    .then(() => undefined, () => undefined);
  log(`PARKED: ${reason}`);
}

// ---- one browser, holding the port every step attaches to ----------
let ctx: any;
try {
  ctx = await launchApplicationContext({ debugPort: 9222 });
} catch (e) {
  // A browser from an earlier run may still hold the port; join it.
  const cdp = await chromium.connectOverCDP("http://127.0.0.1:9222").catch(() => null);
  if (!cdp) { await park("launch", (e as Error).message); process.exit(1); }
  ctx = cdp.contexts()[0];
  log("attached to a browser already holding the debugging port");
}
const page = ctx.pages().find((p: any) => !p.url().startsWith("about:")) ?? await ctx.newPage();
page.setDefaultTimeout(40_000);

// ---- authenticate -----------------------------------------------------
//
// Two ways in. --manual-signin (the default, and the only one the safety
// rules allow) opens the window and waits for the PERSON to create the
// account or sign in: creating an account and typing a password to
// authenticate are the person's to do, not this system's, whatever
// authorisation is on file. The old auto path (typing a stored
// credential, ticking consent, creating the account) is kept behind
// --auto-signin only, and is not used.
await page.goto(candidateHomeUrl(tenant), { waitUntil: "domcontentloaded" });
await waitForWorkdayReady(page, 30_000).catch(() => undefined);
const prior = (await loadTenants(db).catch(() => new Map())).get(tenant.host);
const AUTO = process.argv.includes("--auto-signin");

let authenticated = false;
if (AUTO) {
  const legal = await acceptLegalIfAuthorised(page);
  if (legal !== "ABSENT") log(`legal notice: ${legal}`);
  const auth = await authenticateTenant(tenant, unattendedDeps({
    db, page, tenant, companyId: company!.id, companyName: company!.name, applicationId: ID, email, log: (l) => log(`  ${l}`),
  }), { creationEnabled: true, maxSteps: 8, everAuthenticated: Boolean(prior?.last_authenticated_at), priorAccountState: (prior?.account_state ?? "UNKNOWN") as any });
  await ensureTenant(db, tenant, company!.id);
  await recordObservation(db, { host: tenant.host, pageState: auth.finalState, sessionState: auth.sessionState,
    accountState: auth.accountState, handoffReason: auth.reason, authenticated: auth.outcome === "AUTHENTICATED" });
  log(`authentication: ${auth.outcome}  path ${auth.path.join(" -> ")}${auth.reason ? `  (${auth.reason})` : ""}`);
  authenticated = auth.outcome === "AUTHENTICATED";
} else {
  // Wait for the person to reach a signed-in candidate session in THIS
  // window. Nothing is typed for them and no account is created.
  console.log(`\n  This window is the automated profile. In it, CREATE YOUR ACCOUNT or SIGN IN`);
  console.log(`  for ${company!.name} (${tenant.host}). Nothing is typed for you.`);
  console.log(`  Waiting up to 20 minutes for a signed-in session...\n`);
  for (let i = 0; i < 400; i++) {
    const o = await observe(page, tenant).catch(() => null);
    if (o?.state === "SIGNED_IN") { authenticated = true; log(`signed in (${page.url()})`); break; }
    if (i % 10 === 0) log(`  still ${o?.state ?? "unreadable"}; sign in in the open window`);
    await new Promise((r) => setTimeout(r, 3_000));
  }
  await ensureTenant(db, tenant, company!.id).catch(() => undefined);
  await recordObservation(db, { host: tenant.host, pageState: authenticated ? "SIGNED_IN" : "SIGNED_OUT",
    sessionState: authenticated ? "VALID" : "UNKNOWN", accountState: authenticated ? "EXISTS" : (prior?.account_state ?? "UNKNOWN") as any,
    handoffReason: authenticated ? null : "no signed-in session appeared in the manual window", authenticated }).catch(() => undefined);
}
if (!authenticated) {
  await park("authenticate", AUTO ? "auto sign-in did not reach a session" : "no signed-in session appeared in the manual window");
  if (!KEEP_OPEN) await ctx.close().catch(() => undefined);
  process.exit(3);
}

// ---- the steps, each attached to this browser --------------------------
function run(step: string, args: string[], timeoutMs = 20 * 60_000): { ok: boolean; out: string } {
  log(`--- ${step}: ${args.join(" ")}`);
  const r = spawnSync(process.execPath, args, { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(out.trim().split("\n").map((l) => `      ${l}`).join("\n"));
  return { ok: r.status === 0, out };
}
const statusNow = async () => (await db.from("applications").select("status,resume_id").eq("id", ID).single()).data!;

const steps: Array<{ name: string; args: string[]; skip?: () => Promise<boolean>; until?: (out: string) => boolean }> = [
  { name: "tailor", args: ["scripts/workday-tailor-resume.ts", ID, "--commit"], skip: async () => Boolean((await statusNow()).resume_id) },
  { name: "open and fill", args: ["scripts/workday-run-application.ts", ID, "--attach"] },
  { name: "work experience", args: ["scripts/workday-experience-fill.ts", ID, "--commit"] },
  { name: "education", args: ["scripts/workday-experience-fill.ts", ID, "--education", "--commit"] },
  { name: "upload résumé", args: ["scripts/workday-upload-resume.ts", ID] },
  { name: "skills", args: ["scripts/workday-add-skills.ts", ID] },
  { name: "run to review", args: ["scripts/workday-run-application.ts", ID, "--attach"], until: (out) => /REVIEW reached/.test(out) },
];
let stoppedAt: string | null = null;
for (const s of steps) {
  if (s.skip && await s.skip()) { log(`--- ${s.name}: already done`); continue; }
  const r = run(s.name, s.args);
  if (!r.ok || (s.until && !s.until(r.out))) {
    stoppedAt = s.name;
    await park(s.name, r.out.trim().split("\n").slice(-4).join(" | "));
    break;
  }
}

const final = await statusNow();
log(`done: status ${final.status}${stoppedAt ? ` (stopped at ${stoppedAt})` : ""}`);
if (!stoppedAt && final.status === "AWAITING_REVIEW") {
  await db.from("applications").update({ blocked_reason: null }).eq("id", ID);
  log("ready for review in the portal");
}
if (!KEEP_OPEN) await ctx.close().catch(() => undefined);
process.exit(stoppedAt ? 4 : 0);
