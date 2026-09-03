/**
 * An independent audit of every free-text value on the page.
 *
 * Read from the DOM and compared against the intended values, because a
 * value that lost its first character reads back as a plausible string
 * and the write that produced it reported success.
 */
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { firstCharacterLost, describeMismatch } from "../lib/workday/textFill.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const { data: resume } = await db.from("resumes").select("content").eq("id", "d1b70403-0afb-44f5-8fee-a2f16c789a71").single();
const content: any = (resume as any).content;

const expected = new Map<string, string>();
for (const r of content.roles ?? []) {
  expected.set(`jobTitle:${r.title}`, r.title);
  expected.set(`companyName:${r.employer}`, r.employer);
  if (r.location) expected.set(`location:${r.location}`, r.location);
}
for (const e of content.education ?? []) expected.set(`schoolName:${e.institution}`, e.institution);

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = b.contexts()[0]!.pages().filter((p: any) => !p.url().startsWith("about:"))[0]!;
const live = await page.evaluate(() =>
  [...document.querySelectorAll('[data-automation-id^="formField-"]')]
    .filter((f) => f.getClientRects().length > 0)
    .map((f) => {
      const el = f.querySelector("input,textarea") as HTMLInputElement | null;
      if (!el || el.type === "checkbox") return null;
      return { field: String(f.getAttribute("data-automation-id")).replace("formField-", ""),
               value: String(el.value ?? "") };
    }).filter(Boolean) as { field: string; value: string }[]);

let problems = 0, checked = 0;
for (const row of live) {
  if (!["jobTitle", "companyName", "location", "schoolName", "roleDescription"].includes(row.field)) continue;
  if (!row.value) { console.log(`EMPTY  ${row.field}`); problems++; continue; }
  checked++;
  // Does this value match ANY intended value for its kind exactly?
  const candidates = [...expected.entries()].filter(([k]) => k.startsWith(`${row.field}:`)).map(([, v]) => v);
  const roleLines = (content.roles ?? []).flatMap((r: any) => (r.lines ?? []).map((l: any) => String(l.text)));
  const pool = row.field === "roleDescription" ? [] : candidates;
  if (row.field === "roleDescription") {
    const okDesc = roleLines.some((t: string) => row.value.includes(t.slice(0, 40)));
    if (!okDesc) { console.log(`SUSPECT roleDescription: ${JSON.stringify(row.value.slice(0, 60))}`); problems++; }
    continue;
  }
  if (pool.includes(row.value)) continue;
  const damaged = pool.find((v) => firstCharacterLost(v, row.value) || v.startsWith(row.value));
  console.log(`BAD    ${row.field.padEnd(14)} ${damaged ? describeMismatch(damaged, row.value) : `unexpected value ${JSON.stringify(row.value)}`}`);
  problems++;
}
console.log(`\nchecked ${checked} free-text value(s); ${problems} problem(s)`);
await b.close();
process.exit(problems ? 1 : 0);
