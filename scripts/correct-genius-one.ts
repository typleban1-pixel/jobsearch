/**
 * The Genius One truth correction.
 *
 *   node scripts/correct-genius-one.ts            show what would change
 *   node scripts/correct-genius-one.ts --commit   apply it
 *
 * All HUMAN_CONFIRMED by the user on 2 Sep 2026.
 *
 * WHAT WAS WRONG
 *
 * The employment rows already held two stints with a real gap during
 * Holley. What merged them into one "2019 to Present" line was a single
 * employment_relationships record, the only mechanism allowed to render
 * a span no employment record holds. Its stated basis was that the
 * relationship had been continuous, contract throughout, at variable
 * workload. The user has confirmed that is wrong: both stints were W-2
 * full-time employment with a genuine interruption between them.
 *
 * So the relationship record is retired rather than edited. Editing it
 * would mean rewriting a HUMAN_CONFIRMED basis into something the user
 * never said; retiring it lets the chronology guard do what it already
 * does correctly, which is keep separate stints separate.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not touch any submitted artifact, and it does not strengthen
 * any Genius One claim. The new evidence carries scope guards that are
 * narrower than the facts, not wider: audience size is not growth he
 * caused, and product sales are not revenue he generated.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const STINT1 = "5171d932-240e-4eb0-8ff8-6b15b99e7392";
const STINT2 = "8cbf8b72-0ea4-453d-9b76-fcdc0e6ee93b";
const RELATIONSHIP = "5b074158-d600-4654-8c71-9d619924668b";
const OLD_EMAIL_METRIC = "d1cf3999-36cf-4665-be41-e3ed8a69e2e2";
const TITLE = "Digital Marketing, Product & Operations Specialist";

const say = (what: string, detail = "") => console.log(`  ${what}${detail ? `\n      ${detail}` : ""}`);

console.log("employment:");
say("stint 1 (2019 to 2022): CONTRACT -> FULL_TIME, title loses \"(Contract)\"");
say("stint 2: CONTRACT -> FULL_TIME, title loses \"(Contract)\", starts March 2024 at MONTH precision");
say("relationship record retired, so the two stints stop rendering as one 2019 to Present span");
console.log("\nmetrics:");
say("the ~100,000 email metric is withdrawn from use and replaced by the 70,000 to 180,000 evidence");
say("new: FDM product design and development at Genius One");
say("new: $68,000+ of those products sold, as product sales and not personal revenue");

if (!commit) { console.log("\ndry run. Pass --commit to apply."); process.exit(0); }

// ---------------------------------------------------------------- 1
{
  const { error } = await db.from("employment_records").update({
    employment_type: "FULL_TIME",
    actual_title: TITLE,
    stint_note: "W-2 full-time. Ended on relocating to Bowling Green, Kentucky for Holley. "
      + "Concurrent with part-time Anytime Picture work.",
  }).eq("id", STINT1);
  console.log(`\nstint 1: ${error?.message ?? "corrected"}`);
}

// ---------------------------------------------------------------- 2
{
  const { error } = await db.from("employment_records").update({
    employment_type: "FULL_TIME",
    actual_title: TITLE,
    // March 2024, HUMAN_CONFIRMED. MONTH precision because the month is
    // now known; it was YEAR while only the year was.
    start_month: "2024-03-01",
    start_precision: "MONTH",
    notes: "Same role and employer as stint 1. W-2 full-time. HUMAN_CONFIRMED 2026-09-02: the earlier "
      + "description of this stint as part-time contract work was incorrect and is superseded.",
    stint_note: "Resumed in March 2024 after returning to Ohio, as W-2 full-time employment. "
      + "HUMAN_CONFIRMED 2026-09-02, superseding the earlier note that described this as currently "
      + "part-time contract work and stated that he did not hold a full-time position.",
  }).eq("id", STINT2);
  console.log(`stint 2: ${error?.message ?? "corrected"}`);
}

// ---------------------------------------------------------------- 3
{
  // Retired, not rewritten. Its whole basis was the continuity claim.
  const { error } = await db.from("employment_relationships").delete().eq("id", RELATIONSHIP);
  console.log(`relationship: ${error?.message ?? "retired"}`);
}

// ---------------------------------------------------------------- 4
{
  const { error } = await db.from("metrics").update({
    approved_for_use: false,
    context_note: "SUPERSEDED 2026-09-02 by HUMAN_CONFIRMED evidence that the audience was approximately "
      + "70,000 contacts at the start of the engagement and approximately 180,000 later in it. "
      + "Retained for history. Must not be used in any new document. "
      + (await db.from("metrics").select("context_note").eq("id", OLD_EMAIL_METRIC).single()).data?.context_note,
  }).eq("id", OLD_EMAIL_METRIC);
  console.log(`old email metric: ${error?.message ?? "withdrawn from use, retained for history"}`);
}

// ---------------------------------------------------------------- 5
const EMAIL_WORDING = "Designed marketing emails and built and managed segmented email marketing funnels for an "
  + "email audience that was approximately 70,000 contacts at the start of the engagement and approximately "
  + "180,000 contacts later in it";
const EMAIL_GUARD = "HUMAN_CONFIRMED 2026-09-02. SCOPE GUARDRAIL: these are the SIZES OF THE AUDIENCE WORKED WITH at "
  + "two points in time. They are NOT growth he caused and must never be phrased as growing, building, scaling or "
  + "increasing the list, nor as a percentage or multiple. He worked on the email operation, including designing "
  + "marketing emails and building and managing segmented funnels; list size is affected by many factors outside "
  + "that work, including acquisition spend, retail and wholesale channels, and other people's work. "
  + "Supersedes the approximately 100,000 figure.";
{
  const { data: ev, error: evErr } = await db.from("evidence").insert({
    polarity: "POSITIVE", summary: EMAIL_WORDING, detail: "Metric source: Genius One, Inc. " + EMAIL_GUARD,
    confidence: "SELF_REPORTED", origin: "PROFILE", classification: "NORMAL_PERSONAL",
  }).select("id").single();
  if (evErr) console.log(`email evidence: ${evErr.message}`);
  const { error } = await db.from("metrics").insert({
    employment_id: STINT1, label: "Email audience size worked with at Genius One",
    approved_wording: EMAIL_WORDING, numeric_value: 180000, unit: "contacts",
    evidence_id: ev?.id ?? null, confidence: "SELF_REPORTED",
    approved_for_use: true, approved_at: new Date().toISOString(), context_note: EMAIL_GUARD,
  });
  console.log(`new email metric: ${error?.message ?? "added"}`);
}

// ---------------------------------------------------------------- 6
const PRODUCT_WORDING = "Designed and developed physical products for Genius One using FDM 3D printing, including "
  + "products that moved beyond prototypes into repeated production and commercial sale";
const SALES_WORDING = "Products designed in this role have sold more than $68,000 over approximately two years "
  + "since Genius One began producing and selling them";
const PRODUCT_GUARD = "HUMAN_CONFIRMED 2026-09-02. SCOPE GUARDRAIL: $68,000+ is SALES OF THE RELEVANT PRODUCTS, "
  + "not revenue he personally generated, and must never be phrased as revenue he drove, produced or was "
  + "responsible for. His contribution is the design and development of the products. Pricing, channel, "
  + "marketing spend and demand are not attributed to him. MUST NEVER BE COMBINED with the Genius Academy "
  + "$70,000+ peak ARR metric: different offerings, different measures, and adding or juxtaposing them as one "
  + "figure would misstate both.";
{
  const { data: ev, error: evErr } = await db.from("evidence").insert({
    polarity: "POSITIVE", summary: PRODUCT_WORDING,
    detail: "Metric source: Genius One, Inc. " + PRODUCT_GUARD,
    confidence: "SELF_REPORTED", origin: "PROFILE", classification: "NORMAL_PERSONAL",
  }).select("id").single();
  if (evErr) console.log(`product evidence: ${evErr.message}`);
  const { error } = await db.from("metrics").insert({
    employment_id: STINT2, label: "Sales of 3D-printed products designed at Genius One",
    approved_wording: SALES_WORDING, numeric_value: 68000, unit: "USD_PRODUCT_SALES",
    evidence_id: ev?.id ?? null, confidence: "SELF_REPORTED",
    approved_for_use: true, approved_at: new Date().toISOString(), context_note: PRODUCT_GUARD,
  });
  console.log(`product sales metric: ${error?.message ?? "added"}`);

  const { error: e2 } = await db.from("evidence").insert({
    polarity: "POSITIVE", summary: PRODUCT_WORDING,
    detail: "Capability evidence, Genius One, Inc. Design and development of physical products using FDM 3D "
      + "printing, parametric CAD, slicer configuration, material selection and tolerance testing, taken "
      + "through to repeated production and commercial sale. HUMAN_CONFIRMED 2026-09-02.",
    confidence: "SELF_REPORTED", origin: "PROFILE", classification: "NORMAL_PERSONAL",
  });
  console.log(`product capability evidence: ${e2?.message ?? "added"}`);
}

console.log("\ncorrections applied. Nothing frozen yet.");
