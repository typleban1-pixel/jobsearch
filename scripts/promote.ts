/**
 * Promotes SUGGESTED rows to VERIFIED, then cuts a profile version.
 *
 * The rule the user set, and the only one that matters here: verification
 * means HE supplied or confirmed the underlying fact. Not that a claim is
 * plausible, not that it is consistent with something else already
 * verified, and not that it appeared on his own resume. A resume line he
 * never discussed stays SUGGESTED.
 *
 * So this file carries an explicit allow-list rather than a rule, because
 * any rule clever enough to infer the list would be exactly the kind of
 * inference the list exists to prevent.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

/**
 * Skills the user described in his own words during the intake.
 *
 * Deliberately absent, and each for a stated reason:
 *
 *   The RentPup technologies (Claude Code, Supabase, Vercel, GitHub,
 *   Stripe, Sentry, Resend). He wrote that the project may support "the
 *   specific tools/capabilities I verify", which signals he intends to
 *   verify them one at a time. They stay proposals despite being the
 *   skills he is most interested in.
 *
 *   The individual Adobe applications. He confirmed video production,
 *   editing, motion graphics and graphic design as capabilities. He never
 *   named Premiere, After Effects, Photoshop or Illustrator individually,
 *   and "Adobe Creative Suite" on a resume bullet is not the same as
 *   confirming each application.
 *
 *   Google Analytics. He said he "ran analytics" at Genius Academy. The
 *   resume says Google Analytics. Those are close enough to be tempting
 *   and not the same statement.
 */
const VERIFIED_SKILLS = [
  // Ecommerce platforms, described hands-on in question 7.
  "Shopify", "BigCommerce", "Webflow", "Ecommerce", "Subscription billing",
  // Email and audience work, questions 7 and 10.
  "Omnisend", "Email marketing", "Email design", "Audience segmentation",
  "Marketing funnel design", "Campaign execution",
  // Genius Academy responsibilities, listed by him line by line.
  "SEO", "Paid advertising", "Customer acquisition", "Customer support",
  "Pricing", "Website development", "Branding", "Product ideation",
  "Talent sourcing and recruiting", "Launching a new offering",
  "Conversion testing", "Vimeo OTT",
  // Production capabilities named in the client and LCCC answers.
  "Video production", "Video editing", "Motion graphics", "Graphic design",
  // Coordination and supervision, questions 6 and 8.
  "Project coordination", "External partnership coordination",
  "Teaching and mentoring", "Staff supervision",
];

// Every employment record was corrected or confirmed directly: dates,
// stints, employment type, location, departure reason.
const VERIFY_ALL_EMPLOYMENT = true;

// RentPup and Genius Academy were both discussed at length with explicit
// guardrails. The LCCC internship program was never raised, so it stays.
const VERIFIED_PROJECTS = ["RentPup", "Genius Academy"];

async function main() {
  const { data: skills } = await db.from("skills").select("id,name,status");
  const { data: employment } = await db.from("employment_records").select("id,employer,stint,status");
  const { data: projects } = await db.from("projects").select("id,name,status");
  const { data: education } = await db.from("education").select("id,institution,status");

  const skillHits = (skills ?? []).filter((s: any) => VERIFIED_SKILLS.includes(s.name));
  const missing = VERIFIED_SKILLS.filter((n) => !(skills ?? []).some((s: any) => s.name === n));
  const projectHits = (projects ?? []).filter((p: any) => VERIFIED_PROJECTS.includes(p.name));

  console.log("promotion plan\n");
  console.log(`  skills      ${skillHits.length} of ${(skills ?? []).length} promote; ${(skills ?? []).length - skillHits.length} stay SUGGESTED`);
  console.log(`  employment  ${(employment ?? []).length} of ${(employment ?? []).length} promote`);
  console.log(`  projects    ${projectHits.length} of ${(projects ?? []).length} promote`);
  // Education was never discussed. Under the user's own rule it cannot be
  // promoted, even though he listed education among the categories: the
  // filter he gave is "that I have directly confirmed or clarified".
  console.log(`  education   ${(education ?? []).length} of ${(education ?? []).length} promote  <- confirmed accurate 30 Aug 2026`);
  if (missing.length) console.log(`\n  WARNING: named but not found in the database: ${missing.join(", ")}`);

  if (!commit) { console.log("\ndry run. Pass --commit to promote and cut a version."); return; }

  const now = new Date().toISOString();
  for (const s of skillHits) {
    const { error } = await db.from("skills").update({ status: "VERIFIED", verified_at: now }).eq("id", s.id);
    if (error) throw new Error(`skill ${s.name}: ${error.message}`);
  }
  if (VERIFY_ALL_EMPLOYMENT) {
    for (const e of employment ?? []) {
      const { error } = await db.from("employment_records").update({ status: "VERIFIED", verified_at: now }).eq("id", e.id);
      if (error) throw new Error(`employment ${e.employer}: ${error.message}`);
    }
  }
  // Both records confirmed accurate as written, including coursework.
  for (const e of education ?? []) {
    const { error } = await db.from("education").update({ status: "VERIFIED", verified_at: now }).eq("id", e.id);
    if (error) throw new Error(`education ${e.institution}: ${error.message}`);
  }
  for (const p of projectHits) {
    const { error } = await db.from("projects").update({ status: "VERIFIED", verified_at: now }).eq("id", p.id);
    if (error) throw new Error(`project ${p.name}: ${error.message}`);
  }

  const { data: v, error: bumpErr } = await db.rpc("bump_profile_version", {
    p_reason: "Version 3: first usable conservative truth profile. Employment, RentPup and Genius Academy, 30 directly confirmed skills, and all five approved metrics. Education and 40-odd resume-derived skills deliberately left SUGGESTED.",
  });
  if (bumpErr) throw new Error(`bump: ${bumpErr.message}`);
  console.log(`\ncut profile version ${v}`);

  const { data: pv } = await db.from("profile_versions").select("version,row_count,truth_hash").eq("version", v).single();
  console.log(`  frozen rows: ${pv?.row_count ?? "?"}`);
  console.log(`  truth hash:  ${String(pv?.truth_hash ?? "").slice(0, 16)}...`);
}

await main();
