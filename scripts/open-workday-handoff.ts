/**
 * Opens a Workday application and stops where a person is required.
 *
 *   node scripts/open-workday-handoff.ts <application_id> [--headed]
 *
 * Workday publishes no form to read ahead of time and puts its
 * application behind an account sign-in, so preparation legitimately
 * could not map any questions. This goes as far as a machine honestly
 * can: it opens the real posting, looks at what is actually on the page,
 * and stops at the first thing only a person may do.
 *
 * There is no code path here that signs in, creates an account, types a
 * credential, or submits anything. It reads the page and records what it
 * saw.
 *
 * The run is recorded through the same mechanism as every other fill, so
 * an attempt that filled nothing is still visible rather than being a
 * gap in the history.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { snapshotLive } from "../lib/browser/liveSnapshot.ts";
import { startFillRun, recordFillRun } from "../lib/applications/fillRun.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const applicationId = process.argv[2];
/**
 * A profile to observe from.
 *
 * The signed-in profile is the right one when it is free, because if the
 * user already has a Workday session the form may be reachable without
 * anyone signing in now. When their own Chrome holds the lock, taking it
 * would mean killing their browser, so a throwaway profile is used and
 * the run honestly reflects a signed-out visitor. Which one was used is
 * recorded with the run.
 */
const profileDir = process.argv.includes("--profile")
  ? process.argv[process.argv.indexOf("--profile") + 1]!
  : ".browser-profile";
if (!applicationId) { console.error("usage: open-workday-handoff.ts <application_id>"); process.exit(2); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const { data: app } = await db.from("applications")
  .select("id,job_id,status,submitted_at,resume_id,blocked_reason,is_test").eq("id", applicationId).single();
if (!app) { console.error("no such application"); process.exit(1); }
if (app.submitted_at) { console.error(`already submitted at ${app.submitted_at}`); process.exit(1); }

const { data: job } = await db.from("jobs")
  .select("id,title,source,url,application_form_url,company_id,status,eligibility").eq("id", app.job_id).single();
const { data: company } = await db.from("companies").select("name").eq("id", job!.company_id).single();
const applyUrl = job!.application_form_url ?? job!.url;
if (!applyUrl) { console.error("this job has no apply URL"); process.exit(1); }

console.log(`${company!.name} — ${job!.title}`);
console.log(`  provider ${job!.source}  job ${job!.status}/${job!.eligibility}`);
console.log(`  apply at ${applyUrl}`);
console.log(`  profile  ${profileDir}${profileDir === ".browser-profile" ? " (signed-in profile)" : " (throwaway, signed out)"}\n`);

const runDir = join(".fill-runs", `workday-${applicationId}-${Date.now()}`);
await mkdir(runDir, { recursive: true });

const run = startFillRun({
  applicationId, provider: job!.source, runDir,
  // The worker drove the browser. Nothing was filled, but a person did
  // not drive this either, and the record should say what happened.
  fillMode: "AUTOMATED",
  formSnapshotHash: null,
});

let outcome: "HANDOFF" | "LOGIN_WALL" | "SSO_PROMPT" | "CAPTCHA" | "NO_FORM_FOUND" | "BROWSER_ERROR" = "BROWSER_ERROR";
let detail = "";
const observed: string[] = [];
let context;

try {
  context = await launchApplicationContext({ profileDir });
  const page = await context.newPage();
  await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_500);
  await page.screenshot({ path: join(runDir, "01-posting.png"), fullPage: false });

  const url = page.url();
  const title = await page.title();
  observed.push(`landed on ${url}`);
  observed.push(`page title: ${title}`);
  console.log(`landed on: ${url}`);
  console.log(`title:     ${title}`);

  const live = await snapshotLive(page.mainFrame());
  console.log(`\nwhat is on the page:`);
  console.log(`  fields visible:   ${live.fields?.length ?? 0}`);
  console.log(`  login wall:       ${live.loginWall}`);
  console.log(`  SSO prompt:       ${live.ssoPrompt}`);
  console.log(`  captcha:          ${(live as any).captcha ?? "not reported"}`);

  // What a person would click to begin. Located, never clicked: pressing
  // Apply is the start of an account flow, and that is the user's to do.
  const applyControl = page.getByRole("button", { name: /^apply/i })
    .or(page.getByRole("link", { name: /^apply/i }));
  const applyCount = await applyControl.count().catch(() => 0);
  const applyLabel = applyCount > 0
    ? (await applyControl.first().innerText().catch(() => "")).replace(/\s+/g, " ").trim()
    : null;
  if (applyLabel) { observed.push(`an apply control is present, labelled ${JSON.stringify(applyLabel)}`); }
  console.log(`  apply control:    ${applyCount > 0 ? JSON.stringify(applyLabel) : "none found"}`);

  const bodyText = (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\s+/g, " ");
  const wantsAccount = /create account|sign in|signin|log ?in|already have an account/i.test(bodyText);
  if (wantsAccount) observed.push("the page asks the visitor to sign in or create an account");

  if (live.loginWall) {
    outcome = "LOGIN_WALL";
    detail = "Workday presented a sign-in form with a password field. Signing in is yours to do: "
      + "this system never enters a credential and never creates an account."
      + (profileDir === ".browser-profile" ? "" : " Observed from a throwaway profile, so any existing session of yours was not used.");
  } else if (live.ssoPrompt) {
    outcome = "SSO_PROMPT";
    detail = "Workday offered a single sign-on prompt. Granting access is your decision, not this system's.";
  } else if (wantsAccount || applyCount > 0) {
    outcome = "LOGIN_WALL";
    detail = "The posting is readable, but applying begins an account flow: Workday requires an account "
      + "before it will show the application form. Nothing beyond the public posting can be reached without you.";
  } else if ((live.fields?.length ?? 0) === 0) {
    outcome = "NO_FORM_FOUND";
    detail = "No application form and no apply control were visible on the page.";
  } else {
    outcome = "HANDOFF";
    detail = `A form with ${live.fields!.length} field(s) was reachable without signing in. `
      + "Nothing was filled: this script only looks.";
  }

  await page.screenshot({ path: join(runDir, `99-stop-${outcome}.png`), fullPage: false });
  console.log(`\n${outcome}: ${detail}`);
} catch (err) {
  detail = (err as Error).message ?? String(err);
  console.error(`\nBROWSER_ERROR: ${detail}`);
} finally {
  await context?.close().catch(() => undefined);
}

const { warnings } = await recordFillRun(db, run, {
  outcome,
  detail,
  // Nothing was typed and nothing was uploaded. Recording zeroes is the
  // point: the attempt happened and left a record even though it filled
  // nothing.
  filled: [],
  leftBlank: [],
  artifact: null,
  submitClickAttempted: false,
  extra: { applyUrl, observed, profileDir, signedInProfile: profileDir === ".browser-profile" },
});
for (const w of warnings) console.log(`  (${w})`);

console.log(`\nevidence in ${runDir}`);
process.exit(0);
