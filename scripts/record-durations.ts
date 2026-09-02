/**
 * Records the capability durations the user has stated. Run after 0064.
 *
 *   node scripts/record-durations.ts            report what it would do
 *   node scripts/record-durations.ts --write    record them
 *
 * Supersedes record-seo-duration.ts, which covered only the first of
 * these. Idempotent: a capability already recorded is updated in place
 * rather than duplicated, and the unique constraint on capability means
 * a second run cannot accumulate figures.
 *
 * Pure DML. It writes capability_durations rows and a truth_change_log
 * entry naming the user as the source. It does not date any evidence
 * row, create any skill, or produce any resume claim.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const write = process.argv.includes("--write");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const STATED_ON = "2026-09-01";

/**
 * Each figure covers its own capability and nothing adjacent.
 *
 * SEO excludes AEO and GEO, and AEO and GEO exclude SEO, on purpose. Six
 * years of search engine optimization is not six years of answer engine
 * optimization, and one year of answer engine optimization is not one
 * year of everything else the user has done. They are recorded as
 * separate facts because that is what they are.
 */
const DURATIONS = [
  {
    capability: "SEO", skillName: "SEO", years: 6,
    scope: "Six years creating and executing search engine optimization work. Covers SEO as an "
      + "occupational discipline and nothing adjacent to it.",
    excludes: ["AEO", "answer engine optimization", "GEO", "generative engine optimization",
      "SEM", "paid search", "paid advertising", "general marketing"],
  },
  // Held back, deliberately.
  //
  // The user has stated one year of each, and that is enough to record a
  // duration. It is not enough to make the capability visible: there is
  // no skill row and not one of the 161 evidence rows mentions either,
  // so a duration alone would satisfy a requirement in the database
  // while the resume a screener reads says nothing about it. Recording
  // that gap as if it were closed is worse than leaving it open.
  //
  // These stay held until the underlying work is recorded as evidence.
  // Pass --include-held to write them anyway.
  {
    capability: "answer engine optimization", skillName: null, years: 1, hold: true,
    scope: "One year of answer engine optimization work, practised alongside generative engine "
      + "optimization. Distinct from the longer search engine optimization history.",
    excludes: ["SEO", "search engine optimization", "SEM", "paid search", "general marketing"],
  },
  {
    capability: "generative engine optimization", skillName: null, years: 1, hold: true,
    scope: "One year of generative engine optimization work, practised alongside answer engine "
      + "optimization. Distinct from the longer search engine optimization history.",
    excludes: ["SEO", "search engine optimization", "SEM", "paid search", "general marketing"],
  },
];

const includeHeld = process.argv.includes("--include-held");

let failed = 0;
for (const d of DURATIONS) {
  if ((d as any).hold && !includeHeld) {
    console.log(`\n${d.capability}: ${d.years} year${d.years === 1 ? "" : "s"}  HELD`);
    console.log(`  not recorded: no skill row and no evidence mentions this capability, so the figure`);
    console.log(`  would satisfy a requirement that the resume cannot show. Record the work first.`);
    continue;
  }
  const skill = d.skillName
    ? (await db.from("skills").select("id,name,status,level").ilike("name", d.skillName).maybeSingle()).data
    : null;

  const { data: existing, error: readErr } = await db.from("capability_durations")
    .select("id,years,stated_on").eq("capability", d.capability).maybeSingle();
  if (readErr) {
    console.error(`capability_durations is not readable (${readErr.message}). Is 0064 applied?`);
    process.exit(1);
  }

  console.log(`\n${d.capability}: ${d.years} year${d.years === 1 ? "" : "s"}`
    + `  HUMAN_CONFIRMED / USER_RESPONSE, stated ${STATED_ON}`);
  console.log(`  skill row: ${skill ? `${skill.name} (${skill.status}, ${skill.level})` : "none — this capability is not in the skills table"}`);
  console.log(`  existing:  ${existing ? `${existing.years} years stated ${existing.stated_on}` : "none"}`);
  console.log(`  excludes:  ${d.excludes.join(", ")}`);

  if (!write) continue;

  const row = {
    capability: d.capability, skill_id: skill?.id ?? null, years: d.years,
    confidence: "HUMAN_CONFIRMED", provenance: "USER_RESPONSE",
    scope_note: d.scope, excludes: d.excludes, stated_on: STATED_ON,
  };
  const { error } = existing
    ? await db.from("capability_durations").update(row).eq("id", existing.id)
    : await db.from("capability_durations").insert(row);
  if (error) { console.error(`  FAILED: ${error.message}`); failed++; continue; }

  const { error: logErr } = await db.from("truth_change_log").insert({
    source_table: "capability_durations",
    operation: existing ? "UPDATE" : "INSERT",
    changed_fields: ["capability", "years", "scope_note", "excludes"],
    new_data: {
      capability: d.capability, years: d.years,
      basis: `HUMAN_CONFIRMED: the user stated this directly on 1 Sep 2026 while resolving the Stripe `
        + `AEO and GEO Marketing Manager requirements.`,
      scope: d.scope, excludes: d.excludes,
      not_established: "No evidence row was dated or altered to support this, no skill was created, "
        + "and no resume claim was produced. The figure is what the user said, recorded as such.",
    } as any,
    actor: "user:plebantyler@gmail.com",
  });
  if (logErr) console.error(`  recorded, but the change log failed: ${logErr.message}`);
  else console.log(`  recorded`);
}

if (!write) console.log(`\nnothing written; pass --write`);
process.exit(failed === 0 ? 0 : 1);
