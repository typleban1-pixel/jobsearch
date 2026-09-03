/**
 * Uploads the exact artifact bound to this application.
 *
 * The bytes come from the resume row, not from a re-render: a resume
 * regenerated now could differ from the one that was reviewed, and the
 * sha256 is checked against the stored one before the file is offered to
 * the employer.
 */
import { writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const ID = process.argv[2] ?? "35eaed21-599e-4480-bc7b-192677c80f18";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app } = await db.from("applications").select("resume_id").eq("id", ID).single();
const { data: r } = await db.from("resumes")
  .select("artifact_pdf,artifact_sha256,artifact_bytes,label").eq("id", app!.resume_id).single();

const bytes = Buffer.from(String((r as any).artifact_pdf), "base64");
const sha = createHash("sha256").update(bytes).digest("hex");
console.log(`resume  ${(r as any).label}`);
console.log(`  stored sha256 ${(r as any).artifact_sha256}`);
console.log(`  decoded sha256 ${sha}`);
console.log(`  stored bytes ${(r as any).artifact_bytes}, decoded ${bytes.length}`);
if (sha !== (r as any).artifact_sha256) {
  console.error("refusing to upload: the decoded bytes are not the stored artifact");
  process.exit(1);
}
if (!bytes.subarray(0, 5).toString().startsWith("%PDF")) {
  console.error("refusing to upload: the decoded bytes are not a PDF");
  process.exit(1);
}

const dir = process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : "/tmp";
const path = join(dir, "Ty Pleban - Resume.pdf");
writeFileSync(path, bytes);
console.log(`  wrote ${path} (${statSync(path).size} bytes)`);

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = b.contexts()[0]!.pages().filter((p: any) => !p.url().startsWith("about:"))[0]!;
const input = page.locator('input[type="file"]').first();
if (!(await input.count().catch(() => 0))) { console.error("no file input on this page"); process.exit(1); }
await input.setInputFiles(path);
console.log("  uploaded; waiting for the page to accept it");

let shown = "";
for (let i = 0; i < 25; i++) {
  await page.waitForTimeout(800);
  shown = await page.evaluate(() => {
    const sec = [...document.querySelectorAll("h4,h3")].find((h) => /resume|cv/i.test((h as HTMLElement).innerText));
    const box = sec?.parentElement ?? document.body;
    return (box as HTMLElement).innerText.replace(/\s+/g, " ").trim().slice(0, 300);
  });
  if (/\.pdf/i.test(shown)) break;
}
console.log(`  page shows: ${shown}`);
console.log(/Ty Pleban - Resume\.pdf/i.test(shown)
  ? "  ok   the filename on the page is the bound artifact"
  : "  FAIL the page does not show the expected filename");
await b.close();
process.exit(/Ty Pleban - Resume\.pdf/i.test(shown) ? 0 : 1);
