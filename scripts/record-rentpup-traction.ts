/**
 * New HUMAN_CONFIRMED RentPup evidence: users and revenue.
 *
 *   node scripts/record-rentpup-traction.ts            show what would change
 *   node scripts/record-rentpup-traction.ts --commit   apply it
 *
 * Confirmed by the user on 2 Sep 2026:
 *
 *   21 current users
 *   approximately $1,200 in monthly revenue
 *   the product is mostly low-maintenance to operate
 *
 * WHAT THIS SUPERSEDES
 *
 * Evidence 0aa19e95 says RentPup has no paying customers and no revenue.
 * That was true when it was recorded on 30 Aug 2026 and is not now. It
 * is superseded prospectively rather than rewritten: the restriction it
 * carried was correct for every document produced while it held, and the
 * frozen versions that contain it stay exactly as they are.
 *
 * WHAT IS DELIBERATELY NOT RECORDED
 *
 * A $600 per month figure was mentioned in conversation and was wrong.
 * It is recorded nowhere, and this script asserts that before writing.
 *
 * $1,200 a month is not converted into $14,400 a year, and not called
 * MRR or ARR. Those words mean the revenue recurs on a subscription, and
 * nothing confirmed says so. Monthly revenue is the fact; annualizing it
 * would be arithmetic on an assumption.
 *
 * 21 USERS means 21 users. Not customers, not paying customers, not
 * subscribers, not accounts, not landlords, not businesses. Whether all
 * 21 pay is a separate fact nobody has stated.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const PROJECT = "ccef3c63-43b9-4103-a40d-f7f95e265d19";
const PRE_REVENUE_EVIDENCE = "0aa19e95";

// The scope guard both new facts carry.
const GUARD =
  "HUMAN_CONFIRMED 2026-09-02. SCOPE GUARDRAIL, and every clause matters. "
  + "21 USERS means twenty-one current users. It does not establish that they are customers, paying customers, "
  + "subscribers, accounts, landlords or businesses, and none of those words may be substituted. "
  + "APPROXIMATELY $1,200 PER MONTH is current monthly revenue. It is NOT confirmed to be recurring or "
  + "subscription revenue, so it must never be called MRR or ARR, and it must never be multiplied into $14,400 "
  + "a year or any other annual figure. "
  + "Neither fact supports product-market fit, profitability, a profitable business, rapid growth, a large user "
  + "or customer base, a scaled SaaS business, or revenue generated for clients. "
  + "RentPup remains an independent product built outside full-time employment, and this is never evidence of "
  + "professional software-engineering employment, a development team, or engineering at scale.";

console.log("checking that the incorrect $600 figure is nowhere in the record");
{
  let found = 0;
  for (const t of ["evidence", "metrics", "projects", "project_evidence"]) {
    const { data } = await db.from(t).select("*");
    found += (data ?? []).filter((r: any) => /\$\s?600\b|\b600\s*(?:\/|per\s)\s*month/i.test(JSON.stringify(r))).length;
  }
  console.log(found === 0 ? "  clean: no $600 figure recorded anywhere" : `  WARNING: ${found} row(s) mention $600`);
  if (found > 0) process.exit(1);
}

console.log("\nwould record:");
console.log("  evidence: 21 current users");
console.log("  evidence + metric: approximately $1,200 in current monthly revenue, not annualized, not called MRR");
console.log("  evidence: the product is largely automated and low-maintenance to operate");
console.log(`  supersede: evidence ${PRE_REVENUE_EVIDENCE} (no paying customers and no revenue)`);

if (!commit) { console.log("\ndry run. Pass --commit to apply."); process.exit(0); }

// ---- supersede the pre-revenue restriction -------------------------
{
  const { data: old } = await db.from("evidence").select("id,detail").ilike("summary", "%no paying customers and no revenue%").maybeSingle();
  if (old) {
    const { error } = await db.from("evidence").update({
      summary: "SUPERSEDED 2026-09-02: RentPup had no paying customers and no revenue as of 30 Aug 2026",
      detail: "SUPERSEDED by HUMAN_CONFIRMED evidence of 21 users and approximately $1,200 in monthly revenue. "
        + "Retained because it was true when recorded and governs every document produced while it held. "
        + "Must not be cited in any new document. Original: " + String(old.detail),
    }).eq("id", old.id);
    console.log(`\nsuperseded the pre-revenue restriction: ${error?.message ?? "done"}`);
  }
}

// ---- users ---------------------------------------------------------
{
  const summary = "RentPup currently has 21 users";
  const { data: ev, error: e1 } = await db.from("evidence").insert({
    polarity: "POSITIVE", summary, detail: "Independent product, RentPup. " + GUARD,
    confidence: "SELF_REPORTED", origin: "PROJECT", classification: "NORMAL_PERSONAL",
  }).select("id").single();
  if (e1) console.log(`users evidence: ${e1.message}`);
  const { error } = await db.from("metrics").insert({
    project_id: PROJECT, label: "RentPup current users",
    approved_wording: summary, numeric_value: 21, unit: "users",
    evidence_id: ev?.id ?? null, confidence: "SELF_REPORTED",
    approved_for_use: true, approved_at: new Date().toISOString(), context_note: GUARD,
  });
  console.log(`users metric: ${error?.message ?? "added"}`);
}

// ---- revenue -------------------------------------------------------
{
  const summary = "RentPup currently generates approximately $1,200 in monthly revenue";
  const { data: ev, error: e1 } = await db.from("evidence").insert({
    polarity: "POSITIVE", summary, detail: "Independent product, RentPup. " + GUARD,
    confidence: "SELF_REPORTED", origin: "PROJECT", classification: "NORMAL_PERSONAL",
  }).select("id").single();
  if (e1) console.log(`revenue evidence: ${e1.message}`);
  const { error } = await db.from("metrics").insert({
    project_id: PROJECT, label: "RentPup current monthly revenue",
    approved_wording: summary, numeric_value: 1200, unit: "USD_PER_MONTH",
    evidence_id: ev?.id ?? null, confidence: "SELF_REPORTED",
    approved_for_use: true, approved_at: new Date().toISOString(), context_note: GUARD,
  });
  console.log(`revenue metric: ${error?.message ?? "added"}`);
}

// ---- how it runs ---------------------------------------------------
{
  // Recorded because it says something real about what he built: the
  // product operates without much intervention. "Passive income" is not
  // used, on the resume or here: it describes the income rather than the
  // engineering, and it reads as a side hustle rather than a product.
  const { error } = await db.from("evidence").insert({
    polarity: "POSITIVE",
    summary: "RentPup runs largely automatically and requires relatively little ongoing work to operate",
    detail: "Independent product, RentPup. HUMAN_CONFIRMED 2026-09-02: the user states the product is mostly "
      + "passive or low-maintenance from his perspective. SCOPE: this is evidence about how the product was "
      + "built, namely that its monitoring and delivery run on a schedule without manual intervention. It must "
      + "not be phrased as passive income on any employer-facing document, and it is not evidence of "
      + "profitability, margin or business maturity. " + GUARD,
    confidence: "SELF_REPORTED", origin: "PROJECT", classification: "NORMAL_PERSONAL",
  });
  console.log(`operating-effort evidence: ${error?.message ?? "added"}`);
}

console.log("\nrecorded. Nothing frozen yet.");
