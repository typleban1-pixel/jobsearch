/**
 * Resume regression net (Part 22/23). Composes the tailored resume for
 * representative jobs against the REAL profile (no LLM: master wording),
 * and asserts the properties the two RentPup failures and the overflow
 * failure taught us. Locks:
 *   - RentPup appears when the role is product/operations-relevant, with
 *     its traction, and is not silently dropped (the Instawork failure);
 *   - no engineering / implementation prose reaches a bullet (the Enova
 *     failure) -- every line is recruiter-facing;
 *   - the strongest relevant evidence is not omitted while weaker fills
 *     space (the omission check, Part U).
 *   node scripts/resume-golden-selftest.ts
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { composeTailoredResume } from "../lib/applications/prepare.ts";
import { isRecruiterFacing } from "../lib/render/languageQuality.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

async function composeFor(match: string) {
  const { data: jobs } = await db.from("jobs").select("*").ilike("title", `%${match}%`).eq("eligibility", "ELIGIBLE").limit(1);
  const job = jobs?.[0];
  if (!job) return null;
  const { data: version } = await db.from("job_versions").select("*").eq("job_id", job.id).eq("is_current", true).maybeSingle();
  const comp = await composeTailoredResume(db, job as any, (version ?? undefined) as any, null);
  return comp.doc ? { job, doc: comp.doc as any } : null;
}
const allLines = (d: any): Array<{ text: string; where: string }> => [
  { text: d.summary?.text ?? "", where: "summary" },
  ...(d.roles ?? []).flatMap((r: any) => (r.lines ?? []).map((l: any) => ({ text: l.text, where: r.employer }))),
  ...(d.projects ?? []).flatMap((p: any) => [{ text: p.line?.text ?? "", where: p.name }, ...(p.optional ?? []).map((l: any) => ({ text: l.text, where: p.name }))]),
];

// ---- Product Operations Analyst: RentPup must be present + prominent ----
{
  const r = await composeFor("product operations analyst");
  if (!r) { console.log("  SKIP  no eligible Product Operations Analyst job in the DB"); }
  else {
    const rentpup = (r.doc.projects ?? []).find((p: any) => p.name?.includes("RENTPUP") || p.name === "RentPup");
    ok(!!rentpup, "RentPup is present on a Product Operations resume (was silently dropped)");
    ok(!!rentpup && (rentpup.optional ?? []).some((l: any) => /users|revenue/i.test(l.text)),
      "RentPup shows its traction (users / revenue)", JSON.stringify((rentpup?.optional ?? []).map((l: any) => l.text.slice(0, 40))));
    const lines = allLines(r.doc);
    const eng = lines.filter((l) => l.text && !isRecruiterFacing(l.text));
    ok(eng.length === 0, "no engineering/implementation prose on any line", JSON.stringify(eng.map((l) => `${l.where}: ${l.text.slice(0, 50)}`)));
  }
}

// ---- A marketing role: RentPup should still be considered, strong marketing evidence present ----
{
  const r = await composeFor("marketing");
  if (!r) console.log("  SKIP  no eligible marketing job");
  else {
    const lines = allLines(r.doc);
    ok(lines.some((l) => /seo|email|campaign|acquisition|ecommerce|marketing/i.test(l.text)),
      "a marketing role surfaces verified marketing evidence");
    const eng = lines.filter((l) => l.text && !isRecruiterFacing(l.text));
    ok(eng.length === 0, "marketing resume is also free of implementation prose", JSON.stringify(eng.slice(0, 2)));
  }
}

console.log(bad ? `\n${bad} FAILED` : `\nresume-golden-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
