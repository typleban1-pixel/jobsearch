/**
 * Records compensation an employer stated on their own application form.
 *
 *   node scripts/record-form-compensation.ts              inspect all
 *   node scripts/record-form-compensation.ts --write      record it
 *   node scripts/record-form-compensation.ts <appId>      one application
 *
 * Closes the gap that let Flexport through. The rate was in the label of
 * a required form field, inside a frozen form snapshot nothing read for
 * pay, so job_versions and jobs both carried null salary, compareToFloor
 * returned INDETERMINATE, and the job stayed ELIGIBLE.
 *
 * This reads the snapshots that already exist and records what it finds
 * against the opening. Running eligibility afterwards is what turns that
 * into a verdict; this script never writes a verdict itself, because
 * deciding eligibility is the rule's job and it has not changed.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import {
  compensationFromFormSnapshot, isNewInformation, governingCompensation,
  observationFingerprint, type CompensationObservation, type EvidenceIdentity,
} from "../lib/scoring/openingCompensation.ts";
import { createHash } from "node:crypto";
import { compareToFloor } from "../lib/scoring/salary.ts";

const write = process.argv.includes("--write");
const onlyApp = process.argv.slice(2).find((a) => !a.startsWith("--"));
const FLOOR = 85_000;

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

// Test applications must never mint real compensation evidence against a
// real opening: the evidence gates a hard floor and would outlive the
// probe that produced it.
let q = db.from("applications")
  .select("id,job_id,job_version_id,canonical_opening_id,form_snapshot,form_snapshot_hash,prepared_at,created_at,status")
  .or("is_test.is.null,is_test.eq.false");
if (onlyApp) q = q.eq("id", onlyApp);
const { data: apps } = await q;

let found = 0;
let recorded = 0;

for (const app of apps ?? []) {
  const hits = compensationFromFormSnapshot(app.form_snapshot as any);
  if (!hits.length) continue;

  const { data: job } = await db.from("jobs")
    .select("id,title,company_id,canonical_opening_id,eligibility").eq("id", app.job_id).maybeSingle();
  if (!job) continue;
  const openingId = app.canonical_opening_id ?? job.canonical_opening_id;
  if (!openingId) { console.log(`  (${app.id.slice(0, 8)} has no opening to attach compensation to)`); continue; }
  const { data: company } = await db.from("companies").select("name").eq("id", job.company_id).maybeSingle();

  const { data: existingRows, error: readErr } = await db.from("opening_compensation")
    .select("amount_min,amount_max,currency,period,source,observed_at,source_ref,source_locator,source_text")
    .eq("canonical_opening_id", openingId);
  if (readErr) { console.error(`opening_compensation unreadable: ${readErr.message}`); console.error("Apply migration 0078 first."); process.exit(1); }

  const existing: CompensationObservation[] = (existingRows ?? []).map((o: any) => ({
    amountMin: o.amount_min === null ? null : Number(o.amount_min),
    amountMax: o.amount_max === null ? null : Number(o.amount_max),
    currency: o.currency, period: o.period, source: o.source,
    observedAt: o.observed_at,
    identity: {
      openingId, sourceRef: o.source_ref,
      sourceLocator: o.source_locator, sourceText: o.source_text,
    },
  }));

  // The evidence container, content-addressed where possible. A
  // re-prepared application can reuse its id while the form has changed,
  // so the snapshot's own hash is the honest reference; if one was never
  // stored, the snapshot content is hashed here instead.
  const sourceRef: string = app.form_snapshot_hash
    ?? createHash("sha256").update(JSON.stringify(app.form_snapshot ?? {})).digest("hex");

  // When the evidence was captured, not when this script ran. Re-reading
  // an old snapshot must not make the sighting look newer than it is.
  const observedAt: string = app.prepared_at ?? app.created_at ?? new Date().toISOString();

  for (const hit of hits) {
    found++;
    const identity: EvidenceIdentity = {
      openingId, sourceRef, sourceLocator: hit.fieldKey, sourceText: hit.label,
    };
    const candidate: CompensationObservation = {
      amountMin: hit.amountMin, amountMax: hit.amountMax, currency: hit.currency,
      period: hit.period, source: "APPLICATION_FORM",
      observedAt, identity,
    };

    const floor = compareToFloor({
      salaryMin: hit.amountMin, salaryMax: hit.amountMax,
      period: hit.period, isEstimated: false, floor: FLOOR,
    });

    console.log(`\n${company?.name} — ${String(job.title).slice(0, 46)}`);
    console.log(`  field  ${hit.fieldKey}`);
    console.log(`  says   ${JSON.stringify(hit.label.slice(0, 90))}`);
    console.log(`  reads  ${hit.amountMin === hit.amountMax ? hit.amountMin : `${hit.amountMin}-${hit.amountMax}`} ${hit.currency} per ${hit.period.toLowerCase()}`);
    console.log(`  floor  ${floor.verdict}: ${floor.detail}`);
    console.log(`  job is currently ${job.eligibility}`);

    console.log(`  seen   ${observedAt} (when the snapshot was captured)`);
    if (!isNewInformation(candidate, existing)) {
      console.log("  this exact evidence is already recorded, nothing to add");
      continue;
    }
    if (!write) { console.log("  would record (pass --write)"); continue; }

    const { error } = await db.from("opening_compensation").insert({
      canonical_opening_id: openingId,
      job_id: job.id,
      amount_min: hit.amountMin,
      amount_max: hit.amountMax,
      currency: hit.currency,
      period: hit.period,
      source: "APPLICATION_FORM",
      source_ref: sourceRef,
      source_locator: hit.fieldKey,
      // The exact words, so the number is always traceable to its sentence.
      source_text: hit.label,
      source_detail: { applicationId: app.id, jobVersionId: app.job_version_id ?? null },
      evidence_fingerprint: observationFingerprint({
        identity, source: "APPLICATION_FORM", period: hit.period,
        currency: hit.currency, amountMin: hit.amountMin, amountMax: hit.amountMax,
      }),
      observed_at: observedAt,
    });
    if (error) {
      // The unique index is the same rule isNewInformation applies, held
      // in the database. Hitting it means the evidence was already there.
      if (/opening_compensation_one_per_evidence|duplicate key/i.test(error.message)) {
        console.log("  this exact evidence is already recorded (database refused the replay)");
      } else {
        console.log(`  FAILED: ${error.message}`);
      }
      continue;
    }
    existing.push(candidate);
    recorded++;
    console.log("  recorded");

    const gov = governingCompensation(existing);
    if (gov) console.log(`  governing evidence is now ${gov.source} ${gov.amountMax} per ${gov.period.toLowerCase()}`);
  }
}

console.log(`\n${found} statement(s) found, ${write ? `${recorded} recorded` : "nothing written"}.`);
if (recorded) console.log("Run scripts/eligibility.ts --commit, then eligibility-refresh.ts --commit, to turn this into verdicts.");
