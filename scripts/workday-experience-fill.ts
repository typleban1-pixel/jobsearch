/**
 * My Experience: repeating Work Experience and Education, from frozen truth.
 *
 * This page cannot be modelled as one flat set of fields. Each entry is
 * a block created by "Add Another", and the same automation ids repeat
 * once per block, so every control is addressed by block index.
 *
 * Nothing here is composed. Titles and role descriptions come from the
 * approved resume bound to this application -- the same employer-facing
 * representation the PDF was rendered from -- and dates come from the
 * frozen employment records. Where the resume has no approved text for a
 * record, the entry stops rather than acquiring one.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { toMMYYYY, dateKeystrokes, dateMatches } from "../lib/workday/dateControl.ts";

const ID = process.argv[2] ?? "35eaed21-599e-4480-bc7b-192677c80f18";
const COMMIT = process.argv.includes("--commit");
/** Repair dates on blocks that already exist, adding nothing. */
const DATES_ONLY = process.argv.includes("--dates-only");
/** Fill blocks that already exist; never create more. */
const NO_ADD = process.argv.includes("--no-add");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: app } = await db.from("applications").select("resume_id,job_id").eq("id", ID).single();
const { data: resume } = await db.from("resumes")
  .select("content,artifact_pdf,artifact_sha256,artifact_bytes,label").eq("id", app!.resume_id).single();
const content: any = (resume as any).content;

const { data: master } = await db.from("resumes").select("label").eq("is_master", true).single();
const version = Number(String(master?.label ?? "").match(/profile version (\d+)/)?.[1] ?? 0);
const frozen = async (table: string) => (await db.from("profile_version_rows")
  .select("row_data").eq("profile_version", version).eq("source_table", table)).data?.map((r: any) => r.row_data) ?? [];
const employment = await frozen("employment_records");

/** The approved employer-facing role for a record, matched by employer. */
const approvedFor = (employer: string) =>
  (content.roles ?? []).find((r: any) =>
    String(r.employer ?? "").trim().toLowerCase() === String(employer ?? "").trim().toLowerCase());

const MONTH = (iso: string | null) => iso ? String(Number(iso.slice(5, 7))) : "";
const YEAR = (iso: string | null) => iso ? iso.slice(0, 4) : "";

type Entry = { employer: string; title: string; location: string; start: string; end: string | null;
               isCurrent: boolean; description: string };
const entries: Entry[] = [];
const refusals: string[] = [];
for (const r of employment) {
  const a = approvedFor(r.employer);
  if (!a?.title) { refusals.push(`${r.employer} ${r.start_month}: the resume has no approved title for this employer`); continue; }
  const lines = (a.lines ?? []).map((l: any) => String(l.text)).filter(Boolean);
  if (!lines.length) { refusals.push(`${r.employer} ${r.start_month}: the resume has no approved description`); continue; }
  entries.push({ employer: r.employer, title: a.title, location: a.location ?? r.location ?? "",
    start: r.start_month, end: r.end_month, isCurrent: Boolean(r.is_current),
    description: lines.join("\n") });
}
entries.sort((x, y) => (y.start ?? "").localeCompare(x.start ?? ""));

console.log(`resume ${resume!.label}`);
console.log(`  artifact ${(resume as any).artifact_sha256?.slice(0, 12)} (${(resume as any).artifact_bytes} bytes)`);
console.log(`\n${entries.length} work experience entries from frozen records + approved resume text:`);
for (const e of entries) {
  console.log(`  ${e.employer} | ${e.title}`);
  console.log(`     ${e.start} -> ${e.isCurrent ? "present (current)" : e.end}   ${e.location}`);
  console.log(`     description ${e.description.split("\n").length} approved line(s)`);
}
for (const r of refusals) console.log(`  REFUSED ${r}`);
console.log(`\neducation (approved):`);
for (const e of content.education ?? []) console.log(`  ${e.institution} | ${e.credential} | ${e.field ?? "(no field)"}`);
console.log(`\nskills (approved): ${(content.skillGroups ?? []).flatMap((g: any) => g.skills).join(", ")}`);

if (!COMMIT) { console.log(`\ndry run; pass --commit to write these into the live form.`); process.exit(0); }
if (refusals.length) { console.log(`\nrefusing to fill: ${refusals.length} record(s) have no approved representation.`); process.exit(1); }

// ---- the live form ---------------------------------------------------
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts()[0]!.pages().filter((p: any) => !p.url().startsWith("about:"))[0]!;
page.setDefaultTimeout(30_000);

/**
 * A field INSIDE its own block.
 *
 * Addressing controls by the nth occurrence on the page looked fine and
 * was quietly wrong: the current role has no "To" date, so there are six
 * start dates and five end dates, and every entry after the first wrote
 * its end date into the previous entry's control. Each block is found by
 * its own heading and the field is looked up within it, so a block that
 * is missing a control is missing it rather than borrowing the next
 * one's.
 */
const blockOf = (section: string, n: number) =>
  page.getByRole("heading", { name: `${section} ${n + 1}`, exact: true })
    .locator(`xpath=ancestor::div[.//*[starts-with(@data-automation-id,"formField-")]][1]`);

let SECTION = "Work Experience";
const field = (auto: string, n: number) => blockOf(SECTION, n).locator(`[data-automation-id="${auto}"]`).first();
const addButtonFor = async (section: RegExp) => {
  const idx = await page.evaluate((src: string) => {
    const re = new RegExp(src, "i");
    const vis = (e: Element) => e.getClientRects().length > 0;
    const t = (e: Element) => ((e as HTMLElement).innerText ?? "").trim();
    const adds = [...document.querySelectorAll('[data-automation-id="add-button"]')].filter(vis);
    for (let i = 0; i < adds.length; i++) {
      let h = ""; let n: Element | null = adds[i]!;
      while (n && !h) {
        let p: Element | null = n.previousElementSibling;
        while (p && !h) { const x = p.matches?.("h2,h3,h4,h5") ? p : p.querySelector?.("h2,h3,h4,h5"); if (x) h = t(x); p = p.previousElementSibling; }
        n = n.parentElement;
      }
      if (re.test(h)) return i;
    }
    return -1;
  }, section.source);
  return idx;
};

const writeAndRead = async (auto: string, n: number, value: string, what: string): Promise<boolean> => {
  const box = field(auto, n).locator("input, textarea").first();
  if (!(await box.count().catch(() => 0))) { console.log(`   MISSING ${what}`); return false; }
  await box.fill(value).catch(() => undefined);
  await page.waitForTimeout(200);
  const back = String(await box.inputValue().catch(() => ""));
  const ok = back.trim() === value.trim();
  console.log(`   ${ok ? "ok  " : "FAIL"} ${what.padEnd(20)} ${JSON.stringify(back.slice(0, 46))}`);
  return ok;
};

/**
 * One date, typed as one value.
 *
 * The month and year look like two boxes and behave like a single masked
 * field: filling the month with "3" left the control holding "12/" and a
 * red Invalid Date. So the month section is focused and the six digits
 * are typed in sequence, letting the widget advance itself the way it
 * does for a person, then blurred so Workday validates.
 */
const writeDate = async (auto: string, n: number, iso: string, what: string): Promise<boolean> => {
  const blk = field(auto, n);
  const m = blk.locator('[data-automation-id="dateSectionMonth-input"]').first();
  const y = blk.locator('[data-automation-id="dateSectionYear-input"]').first();
  if (!(await m.count().catch(() => 0))) { console.log(`   MISSING ${what}`); return false; }
  const keys = dateKeystrokes(iso);
  if (!keys) { console.log(`   FAIL ${what.padEnd(20)} no usable date in ${JSON.stringify(iso)}`); return false; }

  await m.click({ timeout: 8000 }).catch(() => undefined);
  await page.keyboard.press("Control+A").catch(() => undefined);
  await page.keyboard.press("Delete").catch(() => undefined);
  await y.fill("").catch(() => undefined);
  await m.click({ timeout: 8000 }).catch(() => undefined);
  await page.keyboard.type(keys, { delay: 90 });
  await page.keyboard.press("Tab").catch(() => undefined);   // blur, so Workday validates
  await page.waitForTimeout(500);

  const mb = String(await m.inputValue().catch(() => ""));
  const yb = String(await y.inputValue().catch(() => ""));
  // A red "Invalid Date" beside this control means the value was refused
  // even when the boxes look right.
  const invalid = await blk.evaluate((el: Element) =>
    /invalid date/i.test((el.closest("div")?.parentElement as HTMLElement | null)?.innerText ?? "")).catch(() => false);
  const ok = dateMatches(mb, yb, iso) && !invalid;
  console.log(`   ${ok ? "ok  " : "FAIL"} ${what.padEnd(20)} ${mb}/${yb}${invalid ? "  [Invalid Date]" : ""} (wanted ${toMMYYYY(iso)})`);
  return ok;
};

let failures = 0;
console.log(`\n--- work experience ---`);
for (let i = 0; i < entries.length; i++) {
  const e = entries[i]!;
  if (i > 0 && !DATES_ONLY && !NO_ADD) {
    const idx = await addButtonFor(/Work Experience/);
    if (idx < 0) { console.log(`  cannot find Add Another for Work Experience`); failures++; break; }
    await page.locator('[data-automation-id="add-button"]').nth(idx).click({ timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  console.log(`\n  Work Experience ${i + 1}: ${e.employer}`);
  if (!DATES_ONLY) {
    if (!(await writeAndRead("formField-jobTitle", i, e.title, "Job Title"))) failures++;
    if (!(await writeAndRead("formField-companyName", i, e.employer, "Company"))) failures++;
    if (e.location) await writeAndRead("formField-location", i, e.location, "Location");
  }
  if (!(await writeDate("formField-startDate", i, e.start, "From"))) failures++;
  if (e.isCurrent) {
    const cb = field("formField-currentlyWorkHere", i).locator('input[type="checkbox"]').first();
    await cb.check({ timeout: 8000 }).catch(() => undefined);
    const on = await cb.isChecked().catch(() => false);
    console.log(`   ${on ? "ok  " : "FAIL"} ${"I currently work here".padEnd(20)} ${on}`);
    if (!on) failures++;
  } else if (e.end) {
    if (!(await writeDate("formField-endDate", i, e.end, "To"))) failures++;
  }
  if (!DATES_ONLY) await writeAndRead("formField-roleDescription", i, e.description, "Role Description");
}

console.log(`\nwork experience: ${entries.length} entries, ${failures} failure(s)`);
await browser.close();
process.exit(failures ? 1 : 0);
