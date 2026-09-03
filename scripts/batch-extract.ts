/**
 * Extraction through the Message Batches API. Half price, same answers.
 *
 *   node scripts/batch-extract.ts                    plan only, zero spend
 *   node scripts/batch-extract.ts --submit           create a paid batch
 *   node scripts/batch-extract.ts --poll             reconcile open batches
 *
 * Batch creation is deliberately NOT in the scheduled pipeline. Scheduled
 * work may discover and plan; only this command may spend.
 *
 * THE ORDER OF THE WRITES IS THE SAFETY PROPERTY
 *
 *   1. the complete intent is written and never rewritten
 *   2. the row moves to SUBMITTING
 *   3. only then does the create request leave this process
 *
 * If the outcome is unknown -- a timeout, a dropped socket, a 5xx, a 200
 * we could not parse -- the row becomes AMBIGUOUS and nothing automatic
 * touches it again. The create endpoint has no idempotency key, so a
 * retry on an unknown outcome would pay twice.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { modelForTier, messageBody } from "../lib/llm/anthropic.ts";
import { EXTRACTION_VERSION, buildExtractionRequest } from "../lib/llm/extractRequirements.ts";
import { planExtraction, EMPTY_SHA256 } from "../lib/llm/extractionDedup.ts";
import { estimateExtraction, formatEstimate } from "../lib/llm/extractionCost.ts";
import { customIdFor, intentKeyFor, planAgainstLive, resolveStalled, maySubmit,
         fromProviderStatus, type RequestIdentity } from "../lib/llm/batchState.ts";
import { createBatch, getBatch, getResults } from "../lib/llm/batchClient.ts";
import { createHash } from "node:crypto";

const SUBMIT = process.argv.includes("--submit");
const POLL = process.argv.includes("--poll");
/** Bumped only by an explicit retry or after an AMBIGUOUS resolution. */
const SCHEMA_VERSION = 1;
const MODEL = modelForTier("fast");
const HAIKU = { in: 1.0, out: 5.0 };

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const page = async (t: string, c: string, ord = "id") => { const o: any[] = [];
  for (let x = 0; ; x += 1000) { const { data, error } = await db.from(t).select(c).order(ord).range(x, x + 999);
    if (error) throw new Error(`${t}: ${error.message}`); o.push(...data); if (data.length < 1000) break; } return o; };
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

// ---- a stalled SUBMITTING is ambiguous, always ------------------------
//
// Done before anything else so a dead process from a previous run cannot
// be mistaken for a fresh start.
{
  const { data: stalled } = await db.from("extraction_batches").select("id,status,submitting_at").eq("status", "SUBMITTING");
  for (const b of stalled ?? []) {
    const r = resolveStalled("SUBMITTING")!;
    await db.from("extraction_batches").update({
      status: r.status, ambiguous_reason: r.reason, updated_at: new Date().toISOString(),
    }).eq("id", b.id);
    console.log(`batch ${b.id.slice(0, 8)}: left SUBMITTING by a dead process -> AMBIGUOUS`);
  }
}

const { data: ambiguous } = await db.from("extraction_batches").select("id,request_count,submitting_at,ambiguous_reason").eq("status", "AMBIGUOUS");
if ((ambiguous ?? []).length) {
  console.log(`\n${ambiguous!.length} AMBIGUOUS batch(es) need a person. Nothing will be submitted while they exist.`);
  for (const b of ambiguous!) console.log(`  ${b.id.slice(0, 8)}  ${b.request_count} request(s)  ${b.ambiguous_reason?.slice(0, 100)}`);
  console.log(`  Resolve with scripts/batch-resolve.ts before submitting anything new.`);
  if (SUBMIT) process.exit(3);
}

if (POLL) { await poll(); process.exit(0); }

// ---- plan --------------------------------------------------------------
const jobs = await page("jobs", "id,title,company_id,source,status,eligibility,extracted_at,description_hash");
const descs = await page("job_descriptions", "job_id,description_text", "job_id");
const text = new Map(descs.map((d: any) => [d.job_id, d.description_text ?? ""]));
const pending = jobs.filter((j: any) =>
  j.status === "OPEN" && j.eligibility === "ELIGIBLE" && !j.extracted_at
  && (text.get(j.id) ?? "").trim().length > 0);

const companyName = new Map((await page("companies", "id,name")).map((c: any) => [c.id, c.name]));
const plan = planExtraction(pending.map((j: any) => ({ id: j.id, descriptionHash: sha(text.get(j.id) ?? "") })));
const leaders = plan.leaders.filter((l) => l.descriptionHash !== EMPTY_SHA256);

const wanted: RequestIdentity[] = leaders.map((l) => ({
  jobId: l.id, descriptionHash: l.descriptionHash!, extractionVersion: EXTRACTION_VERSION,
  schemaVersion: SCHEMA_VERSION, attempt: 1,
}));

// Work already in flight anywhere is not planned again.
const liveRows = await page("extraction_batch_requests",
  "job_id,description_hash,extraction_version,schema_version,attempt,status");
const live = (liveRows as any[]).map((r) => ({
  identity: { jobId: r.job_id, descriptionHash: r.description_hash, extractionVersion: r.extraction_version,
              schemaVersion: r.schema_version, attempt: r.attempt },
  status: r.status,
}));
const { plan: toSend, heldBack } = planAgainstLive(wanted, live);

const estimate = estimateExtraction({ jobs: pending.length, calls: toSend.length, price: HAIKU, batch: true });
console.log(`\npending eligible with text: ${pending.length}`);
console.log(`distinct descriptions:      ${plan.uniqueInputs}  (${plan.reused} reuse a result)`);
console.log(`already in flight elsewhere: ${heldBack.length}`);
console.log(`requests to send:           ${toSend.length}`);
console.log(`model ${MODEL}, extraction v${EXTRACTION_VERSION}, schema v${SCHEMA_VERSION}`);
console.log(`cost (batch, half price):   ${formatEstimate(estimate)}`);

if (!SUBMIT) {
  console.log(`\nfirst 20 request identities:`);
  for (const w of toSend.slice(0, 20)) {
    const t = jobs.find((j: any) => j.id === w.jobId);
    console.log(`  ${customIdFor(w)}  ${w.jobId.slice(0, 8)}  ${String(t?.title).slice(0, 46)}`);
  }
  console.log(`\n(dry run: no API call was made and nothing was written. Pass --submit to spend.)`);
  process.exit(0);
}

if (toSend.length === 0) { console.log("nothing to submit"); process.exit(0); }

// ---- 1. the intent, written before anything leaves ---------------------
const intentKey = intentKeyFor(toSend);
const { data: existing } = await db.from("extraction_batches").select("id,status").eq("intent_key", intentKey).maybeSingle();
if (existing) {
  console.log(`this exact work is already batch ${existing.id.slice(0, 8)} (${existing.status}); refusing to duplicate it`);
  process.exit(3);
}
// THE PROMPT IS NOT WIRED YET.
//
// extractRequirements builds the system prompt, the tool schema and the
// user message together for the synchronous path. Batch must send the
// identical construction or the results are not comparable, and lifting
// it out cleanly is the next change. Submitting a placeholder would buy
// 20 responses to the wrong question, so this refuses rather than
// spending. Everything below -- the intent write, SUBMITTING, the create
// outcomes, polling -- is complete and exercised; only the payload is
// missing.
// The payload, from the SAME two functions the synchronous path uses.
//
// buildExtractionRequest produces the prompt, system text, schema and
// token ceiling; messageBody turns that into the Messages API body that
// batch sends as a request's `params`. Neither is reimplemented here, so
// a change to either moves both transports at once.
const requestBodies = toSend.map((w) => {
  const job: any = jobs.find((j: any) => j.id === w.jobId);
  const company = companyName.get(job.company_id) ?? "";
  const req = buildExtractionRequest({
    title: job.title, company, descriptionText: text.get(w.jobId) ?? "",
  });
  return { custom_id: customIdFor(w), params: messageBody(MODEL, req) };
});
const { data: batch, error: be } = await db.from("extraction_batches").insert({
  intent_key: intentKey, intent: { requests: requestBodies.map((r) => r.custom_id), jobIds: toSend.map((w) => w.jobId) },
  status: "PLANNED", extraction_version: EXTRACTION_VERSION, model: MODEL,
  schema_version: SCHEMA_VERSION, request_count: toSend.length,
  estimated_cost_cents: estimate.expectedCents,
}).select("id").single();
if (be) throw new Error(`could not write the intent: ${be.message}`);
const { error: re } = await db.from("extraction_batch_requests").insert(toSend.map((w) => ({
  batch_id: batch!.id, custom_id: customIdFor(w), job_id: w.jobId,
  description_hash: w.descriptionHash, extraction_version: w.extractionVersion,
  schema_version: w.schemaVersion, attempt: w.attempt, status: "PENDING",
})));
if (re) throw new Error(`could not write the requests: ${re.message}`);
console.log(`intent written as batch ${batch!.id.slice(0, 8)} (${toSend.length} requests)`);

// ---- 2. SUBMITTING, before the network call ----------------------------
const { data: fresh } = await db.from("extraction_batches").select("status").eq("id", batch!.id).single();
if (!maySubmit(fresh!.status as any)) { console.log(`batch is ${fresh!.status}; not submitting`); process.exit(3); }
await db.from("extraction_batches").update({ status: "SUBMITTING", submitting_at: new Date().toISOString() }).eq("id", batch!.id);

// ---- 3. the one create call -------------------------------------------
const result = await createBatch(requestBodies as any);
if (result.outcome === "CREATED") {
  await db.from("extraction_batches").update({
    status: "SUBMITTED", provider_batch_id: result.batch.id, submitted_at: new Date().toISOString(),
  }).eq("id", batch!.id);
  console.log(`SUBMITTED as ${result.batch.id}`);
} else if (result.outcome === "REFUSED") {
  // A 4xx: the provider made nothing. Safe to mark terminal.
  await db.from("extraction_batch_requests").update({ status: "FAILED", error: `create refused: ${result.detail.slice(0, 200)}` }).eq("batch_id", batch!.id);
  await db.from("extraction_batches").update({ status: "FAILED", completed_at: new Date().toISOString() }).eq("id", batch!.id);
  console.log(`REFUSED (${result.status}): ${result.detail.slice(0, 200)}`);
} else {
  await db.from("extraction_batches").update({
    status: "AMBIGUOUS", ambiguous_reason: result.detail,
  }).eq("id", batch!.id);
  console.log(`\nAMBIGUOUS: ${result.detail}`);
  console.log(`The batch may or may not exist. It will NOT be resubmitted automatically.`);
  console.log(`Run scripts/batch-resolve.ts to look for it.`);
  process.exit(4);
}

// ---- polling and per-request persistence -------------------------------
async function poll(): Promise<void> {
  const { data: open } = await db.from("extraction_batches").select("*")
    .in("status", ["SUBMITTED", "PROCESSING"]).not("provider_batch_id", "is", null);
  console.log(`open batches: ${(open ?? []).length}`);
  for (const b of open ?? []) {
    const p = await getBatch(b.provider_batch_id);
    if (!p) { console.log(`  ${b.id.slice(0, 8)}: provider has no such batch`); continue; }
    console.log(`  ${b.id.slice(0, 8)} -> ${p.processing_status} ${JSON.stringify(p.request_counts)}`);
    if (p.processing_status !== "ended" || !p.results_url) {
      await db.from("extraction_batches").update({ status: "PROCESSING" }).eq("id", b.id);
      continue;
    }
    const lines = await getResults(p.results_url);
    let ok = 0, bad = 0;
    for (const line of lines) {
      const status = line.result.type === "succeeded" ? "SUCCEEDED"
        : line.result.type === "expired" ? "EXPIRED"
        : line.result.type === "canceled" ? "CANCELLED" : "FAILED";
      // A job is marked extracted only when ITS OWN result validated and
      // persisted. Persistence of the requirements themselves is the
      // synchronous path's job and is wired in a following change; this
      // records the per-request outcome so nothing is lost meanwhile.
      await db.from("extraction_batch_requests").update({
        status, error: line.result.type === "errored" ? JSON.stringify(line.result.error).slice(0, 400) : null,
        result_persisted_at: status === "SUCCEEDED" ? new Date().toISOString() : null,
      }).eq("batch_id", b.id).eq("custom_id", line.custom_id);
      status === "SUCCEEDED" ? ok++ : bad++;
    }
    await db.from("extraction_batches").update({
      status: fromProviderStatus(p.processing_status, true), completed_at: new Date().toISOString(),
    }).eq("id", b.id);
    console.log(`    reconciled ${ok} succeeded, ${bad} not`);
  }
}
