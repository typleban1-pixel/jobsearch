/**
 * Watches for Resume Builder requests you make in the portal.
 *
 *   node scripts/resume-listener.ts            run in the foreground
 *   node scripts/resume-listener.ts --once     one poll, for testing
 *
 * The portal cannot generate a resume: it has no Anthropic key and no
 * Chrome, and it will stay that way. It writes a QUEUED row; this process,
 * on your Mac, extracts the pasted posting, composes through the shared
 * grounded engine, renders the PDF, and links the immutable resume.
 *
 * Claiming is atomic: the claim is a single UPDATE whose WHERE clause
 * includes "still QUEUED", so two listeners cannot generate the same
 * request twice -- the database decides who won. Restart-safe: a claim
 * left PREPARING by a process that died is released back to QUEUED, and a
 * DONE row is immutable, so nothing is ever generated or mutated twice.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";
import { generateResume, EXTRACTION_VERSION, type ResumeGenerationRow } from "../lib/applications/resumeGeneration.ts";

const once = process.argv.includes("--once");
const POLL_MS = 5_000;
/** A claim older than this was left by a process that died. */
const STALE_CLAIM_MS = 15 * 60_000;

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const llm = new AnthropicProvider();
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);

const COLS = "id,pasted_text,pasted_html,detected_title,detected_company,corrected_title,corrected_company";

/** Return a PREPARING row abandoned by a dead process to the queue. */
async function releaseStale(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const { data } = await db.from("resume_generations")
    .update({ status: "QUEUED", started_at: null })
    .eq("status", "PREPARING").lt("started_at", cutoff).select("id");
  for (const r of data ?? []) log(`released stale claim ${String(r.id).slice(0, 8)} back to the queue`);
}

/** Claim exactly one queued request, atomically. Null if none / lost the race. */
async function claim(): Promise<ResumeGenerationRow | null> {
  const { data: next } = await db.from("resume_generations")
    .select("id").eq("status", "QUEUED").order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!next) return null;
  const { data: claimed } = await db.from("resume_generations")
    .update({ status: "PREPARING", started_at: new Date().toISOString() })
    .eq("id", next.id).eq("status", "QUEUED").select(COLS).maybeSingle();
  return (claimed as ResumeGenerationRow) ?? null; // null = another listener won
}

async function processOne(gen: ResumeGenerationRow): Promise<void> {
  log(`claimed ${gen.id.slice(0, 8)} (${(gen.corrected_title ?? gen.detected_title ?? "untitled").slice(0, 40)})`);
  let outcome;
  try {
    outcome = await generateResume(db, gen, llm);
  } catch (e) {
    outcome = { ok: false as const, errorCategory: "RENDER_FAILED" as const, errorDetail: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  const now = new Date().toISOString();
  if (outcome.ok) {
    // DONE carries every binding the DB trigger checks against the resume.
    const { error } = await db.from("resume_generations").update({
      status: "DONE",
      resume_id: outcome.resumeId,
      profile_version: outcome.profileVersion,
      extraction_version: EXTRACTION_VERSION,
      artifact_sha256: outcome.artifactSha256,
      content_sha256: outcome.contentSha256,
      tailoring_summary: outcome.tailoringSummary as any,
      finished_at: now,
    }).eq("id", gen.id);
    if (error) log(`  DONE write refused for ${gen.id.slice(0, 8)}: ${error.message}`);
    else log(`  done ${gen.id.slice(0, 8)} -> resume ${outcome.resumeId.slice(0, 8)} (${outcome.artifactSha256.slice(0, 12)})`);
  } else {
    await db.from("resume_generations").update({
      status: "FAILED", error_category: outcome.errorCategory, error_detail: outcome.errorDetail, finished_at: now,
    }).eq("id", gen.id);
    log(`  failed ${gen.id.slice(0, 8)}: ${outcome.errorCategory} - ${outcome.errorDetail.slice(0, 80)}`);
  }
}

async function tick(): Promise<void> {
  await releaseStale();
  const gen = await claim();
  if (gen) await processOne(gen);
}

if (once) {
  await tick();
  process.exit(0);
} else {
  log("watching for resume generation requests every 5s");
  for (;;) {
    try { await tick(); } catch (e) { log(`tick error: ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
