/**
 * Submits a Workday application, once, after a person approved it.
 *
 * The click is irreversible, so the marker that records it is written
 * BEFORE it happens: a run that dies mid-click must leave evidence that
 * the employer may already hold this. Nothing is marked SUBMITTED until
 * the employer's own confirmation is read from the page.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const ID = process.argv[2] ?? "35eaed21-599e-4480-bc7b-192677c80f18";
if (!process.argv.includes("--approved-by-person")) {
  console.error("refusing: this submits to a real employer and needs --approved-by-person");
  process.exit(2);
}
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app } = await db.from("applications")
  .select("id,job_id,status,resume_id,submitted_at,submit_click_attempted_at").eq("id", ID).single();
if (!app) { console.error("no such application"); process.exit(1); }
if (app.submitted_at) { console.error(`already submitted at ${app.submitted_at}`); process.exit(1); }
const { data: job } = await db.from("jobs").select("title,url,external_id,company_id").eq("id", app.job_id).single();
const { data: co } = await db.from("companies").select("name").eq("id", job!.company_id).single();
const { data: resume } = await db.from("resumes").select("label,artifact_sha256,artifact_bytes").eq("id", app.resume_id).single();

console.log(`${co!.name} — ${job!.title}`);
console.log(`  application ${ID}`);
console.log(`  requisition ${job!.external_id}`);
console.log(`  resume ${(resume as any).label}`);
console.log(`  artifact sha256 ${(resume as any).artifact_sha256} (${(resume as any).artifact_bytes} bytes)`);

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = b.contexts()[0]!.pages().filter((p: any) => !p.url().startsWith("about:"))[0]!;
page.setDefaultTimeout(60_000);

const read = async () => await page.evaluate(() => {
  const vis = (e: Element) => e.getClientRects().length > 0;
  const marker = [...document.querySelectorAll("*")].map((e) => (e as HTMLElement).innerText ?? "")
    .find((x) => /current step \d+ of \d+/i.test(x) && x.length < 120) ?? "";
  return { step: marker.replace(/\s+/g, " ").slice(0, 44),
    text: (document.body.innerText || "").replace(/\s+/g, " "),
    buttons: [...document.querySelectorAll('button,[role="button"]')].filter(vis)
      .map((e) => ((e as HTMLElement).innerText || "").trim()).filter(Boolean) };
});

// ---- revalidation: is this still the application that was approved? --
const before = await read();
const MUST_CONTAIN = ["Cleveland, OH", "Highland Heights, OH", "Bowling Green, KY", "Elyria, OH",
  "Genius One, Inc.", "Anytime Picture LLC", "Holley Performance", "Lorain County Community College",
  "Western Governors University, Leavitt School of Health", "Ty Pleban - Resume.pdf",
  "Digital Marketing, Product & Operations Specialist", "Videographer & Editor",
  "Video Production Lab Instructor"];
const missing = MUST_CONTAIN.filter((w) => !before.text.includes(w));
const onReview = /step 7 of 7 Review/i.test(before.step);
console.log(`\n  on Review: ${onReview}`);
console.log(`  approved values still present: ${MUST_CONTAIN.length - missing.length}/${MUST_CONTAIN.length}`);
if (!onReview || missing.length) {
  console.error(`\nSTOPPING: the page is not the application that was approved.`);
  for (const m of missing) console.error(`   missing: ${m}`);
  await b.close(); process.exit(1);
}

const submit = page.getByRole("button", { name: /^submit$/i });
const count = await submit.count();
if (count !== 1) { console.error(`STOPPING: Submit resolved to ${count} controls, not exactly one`); await b.close(); process.exit(1); }

const runDir = join(process.cwd(), ".workday-auth", `submit-${ID.slice(0, 8)}`);
mkdirSync(runDir, { recursive: true });
await page.screenshot({ path: join(runDir, "before-submit.png") }).catch(() => undefined);

// ---- the point of no return, recorded before it is crossed ----------
const clickedAt = new Date().toISOString();
await db.from("applications").update({ submit_click_attempted_at: clickedAt }).eq("id", ID);
console.log(`\n  submit_click_attempted_at ${clickedAt} recorded`);
console.log("  clicking Submit once");
await submit.first().click({ timeout: 30_000 });

// ---- the employer's own confirmation --------------------------------
let confirmed = "", after: any = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  after = await read();
  const m = /(thank you[^.]{0,200}\.|your application[^.]{0,200}\.|submitted[^.]{0,160}\.)/i.exec(after.text);
  if (m && !/review/i.test(after.step)) { confirmed = m[1]!.trim(); break; }
  if (/submitted|thank you for applying|application received/i.test(after.text)) { confirmed = (/(thank you[^.]{0,200}\.)/i.exec(after.text)?.[1] ?? "confirmed by the page").trim(); break; }
}
await page.screenshot({ path: join(runDir, "after-submit.png") }).catch(() => undefined);
writeFileSync(join(runDir, "confirmation.json"), JSON.stringify({
  application: ID, requisition: job!.external_id, url: job!.url,
  clickedAt, confirmedAt: confirmed ? new Date().toISOString() : null,
  confirmation: confirmed || null, step: after?.step ?? null,
  artifactSha256: (resume as any).artifact_sha256, pageText: (after?.text ?? "").slice(0, 1200),
}, null, 2));

if (!confirmed) {
  console.error(`\nAMBIGUOUS: Submit was clicked and no confirmation appeared.`);
  console.error(`  step now: ${after?.step}`);
  console.error(`  NOT marking submitted. Evidence in ${runDir}`);
  await b.close(); process.exit(1);
}

const submittedAt = new Date().toISOString();
await db.from("applications").update({ status: "SUBMITTED", submitted_at: submittedAt }).eq("id", ID);
await db.from("application_events").insert({
  application_id: ID, event: "SUBMIT_CONFIRMED", actor: "worker",
  detail: `Confirmed by the live page. requisition ${job!.external_id}, artifact `
    + `${(resume as any).artifact_sha256}, clicked ${clickedAt}. Confirmation: "${confirmed.slice(0, 400)}". Evidence in ${runDir}`,
});
console.log(`\n  SUBMITTED and recorded at ${submittedAt}`);
console.log(`  confirmation: ${confirmed.slice(0, 300)}`);
console.log(`  evidence ${runDir}`);
await b.close();
process.exit(0);
