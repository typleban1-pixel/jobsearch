/**
 * Always-on worker: turns application DRAFTs into PREPARED applications, on
 * the Mac that holds the model key and Chrome.
 *
 *   node scripts/prepare-listener.ts            run in the foreground
 *   node scripts/prepare-listener.ts --once     one poll, for testing
 *
 * The deployed portal creates a DRAFT when you decide to apply and freezes
 * the posting version. It cannot prepare it: snapshotting the employer's
 * form and tailoring the resume need an Anthropic key, and the portal
 * deliberately has none. This process claims each DRAFT and runs the SAME
 * prepareApplication() the scheduled sweep (prepare-queue.ts) runs. It does
 * NOT reimplement preparation, readiness, grounding, answer-confidence,
 * demographic, salary, geography, provider, or duplicate safeguards, and it
 * NEVER submits -- it only takes a DRAFT to its resulting prepared state.
 *
 * Claiming is atomic and does NOT touch status. A single UPDATE stamps
 * prepare_started_at only where status='DRAFT' AND prepare_started_at IS
 * NULL, so two workers cannot both own a DRAFT -- the database decides who
 * won -- and prepareApplication() remains the sole owner of the
 * DRAFT -> PREPARING -> AWAITING_REVIEW/BLOCKED_NEEDS_INPUT transitions.
 *
 * Restart / stale / duplicate safe: a claim left by a dead process is
 * released (a row stuck in PREPARING is returned to DRAFT, the exact
 * transition prepareApplication uses on failure); prepareApplication is
 * itself idempotent (a re-prep replaces the prior answer mapping and points
 * the application at the new resume), so nothing is prepared or mutated
 * twice. A row that refuses preparation is parked with a blocked_reason so
 * it is not re-claimed until a person clears it -- identical to the sweep.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { liveSnapshot } from "../lib/browser/prepareSnapshot.ts";
import { required, optional } from "../lib/env.ts";
import { prepareApplication, type PrepareResult } from "../lib/applications/prepare.ts";
import { AnthropicProvider } from "../lib/llm/anthropic.ts";

const once = process.argv.includes("--once");
const POLL_MS = 5_000;
/** A claim older than this was left by a process that died mid-run. */
const STALE_CLAIM_MS = 15 * 60_000;
/** How often a live worker refreshes its lease. Well under STALE_CLAIM_MS so
 *  several beats can be missed before a still-running prep looks stale. */
const HEARTBEAT_MS = 2 * 60_000;

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);

export { liveSnapshot };

export interface DraftClaim { id: string; job_id: string; title: string | null; leaseAt: string }

/**
 * Release claims left behind by a dead process. A row stuck in PREPARING
 * with an old stamp goes back to DRAFT (the same PREPARING->DRAFT move
 * prepareApplication makes when a snapshot or the provenance gate fails);
 * a stray stamp on any other row is simply cleared. Nothing that reached a
 * terminal state has its status touched.
 */
export async function releaseStale(db: SupabaseClient, cutoffMs = STALE_CLAIM_MS): Promise<number> {
  const cutoff = new Date(Date.now() - cutoffMs).toISOString();
  let released = 0;
  const { data: stuck } = await db.from("applications")
    .update({ status: "DRAFT", prepare_started_at: null })
    .eq("status", "PREPARING").not("prepare_started_at", "is", null).lt("prepare_started_at", cutoff)
    .select("id");
  for (const r of stuck ?? []) { released++; log(`released stale PREPARING claim ${String(r.id).slice(0, 8)} back to DRAFT`); }
  const { data: stray } = await db.from("applications")
    .update({ prepare_started_at: null })
    .neq("status", "PREPARING").not("prepare_started_at", "is", null).lt("prepare_started_at", cutoff)
    .select("id");
  for (const r of stray ?? []) { released++; log(`cleared stray claim stamp on ${String(r.id).slice(0, 8)}`); }
  return released;
}

/**
 * Claim exactly one queued DRAFT, atomically. Returns null when there is
 * nothing to do or another worker won the race. status is intentionally
 * left as DRAFT; prepareApplication moves it to PREPARING itself.
 */
export async function claimDraft(db: SupabaseClient): Promise<DraftClaim | null> {
  const { data: next } = await db.from("applications")
    .select("id,job_id")
    .eq("status", "DRAFT").eq("is_test", false)
    .is("prepare_started_at", null).is("blocked_reason", null)
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!next) return null;
  const { data: claimed } = await db.from("applications")
    .update({ prepare_started_at: new Date().toISOString() })
    .eq("id", next.id).eq("status", "DRAFT").is("prepare_started_at", null)
    .select("id,job_id,prepare_started_at").maybeSingle();
  if (!claimed) return null; // another worker won the race
  const { data: job } = await db.from("jobs").select("title").eq("id", claimed.job_id).single();
  // leaseAt is the exact stamp we wrote, as the database stored it. The
  // heartbeat compare-and-swaps against it so only the current owner can
  // refresh the lease -- a stray or stolen claim never matches.
  return { id: claimed.id, job_id: claimed.job_id, title: job?.title ?? null, leaseAt: claimed.prepare_started_at };
}

/**
 * Refresh a live worker's lease: move prepare_started_at forward, but ONLY
 * if it still equals the stamp we last wrote. This is a compare-and-swap on
 * the ownership marker -- if the claim was released or reclaimed, the stamp
 * no longer matches and this no-ops, so a heartbeat can neither resurrect a
 * finished claim nor steal one back. Returns the new lease stamp, or null if
 * the lease was lost (caller stops beating). Never touches status.
 */
export async function heartbeat(db: SupabaseClient, id: string, lease: string): Promise<string | null> {
  const next = new Date().toISOString();
  const { data } = await db.from("applications")
    .update({ prepare_started_at: next })
    .eq("id", id).eq("prepare_started_at", lease)
    .select("prepare_started_at").maybeSingle();
  return data ? (data.prepare_started_at as string) : null;
}

/**
 * Record the outcome of one preparation and release the claim. This never
 * decides readiness -- prepareApplication already set the terminal status
 * (AWAITING_REVIEW / BLOCKED_NEEDS_INPUT) or left the row DRAFT on refusal.
 * A refusal is parked with a blocked_reason so it is not re-claimed until a
 * person clears it, matching the scheduled sweep exactly.
 */
export async function finalizeClaim(
  db: SupabaseClient, claim: DraftClaim, result: PrepareResult,
): Promise<void> {
  if (result.refusedReason) {
    await db.from("applications")
      .update({ blocked_reason: result.refusedReason, prepare_started_at: null })
      .eq("id", claim.id);
    log(`  NOT PREPARED ${claim.id.slice(0, 8)} (${(claim.title ?? "").slice(0, 40)}): ${result.refusedReason.slice(0, 100)}`);
    return;
  }
  await db.from("applications").update({ prepare_started_at: null }).eq("id", claim.id);
  log(`  ${result.status} ${claim.id.slice(0, 8)} (${(claim.title ?? "").slice(0, 40)}): `
    + `${result.answered} answered, ${result.blocked} blocked, ${result.skipped} skipped`);
}

async function processOne(db: SupabaseClient, llm: AnthropicProvider | null, claim: DraftClaim): Promise<void> {
  log(`claimed ${claim.id.slice(0, 8)} (${(claim.title ?? "untitled").slice(0, 40)})`);

  // Keep the lease fresh for as long as this preparation actually runs, so a
  // legitimately long prepareApplication() is never mistaken for a dead
  // process and reclaimed. A recursive timer (not setInterval) means beats
  // never overlap. If the lease is ever lost, stop beating rather than
  // stamping over another owner.
  let lease = claim.leaseAt;
  let beating = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const beat = async () => {
    if (!beating) return;
    const next = await heartbeat(db, claim.id, lease);
    if (!next) { beating = false; log(`  lease lost on ${claim.id.slice(0, 8)}; stopping heartbeat`); return; }
    lease = next;
    if (beating) timer = setTimeout(beat, HEARTBEAT_MS);
  };
  timer = setTimeout(beat, HEARTBEAT_MS);
  const stopBeating = () => { beating = false; if (timer) clearTimeout(timer); };

  let result: PrepareResult;
  try {
    result = await prepareApplication(db, claim.job_id, llm, { existingApplicationId: claim.id, liveSnapshot });
  } catch (e) {
    stopBeating();
    // A crash mid-prepare may have left the row PREPARING. Return it to
    // DRAFT (prepareApplication's own failure transition) and park a
    // reason so it is recoverable and not silently re-run in a loop.
    const detail = String((e as Error)?.message ?? e).slice(0, 300);
    await db.from("applications")
      .update({ status: "DRAFT", blocked_reason: `preparation crashed: ${detail}`, prepare_started_at: null })
      .eq("id", claim.id);
    log(`  CRASH ${claim.id.slice(0, 8)}: ${detail.slice(0, 100)}`);
    return;
  }
  // Stop the heartbeat BEFORE finalizing so no beat can re-stamp the row
  // after the claim is cleared. finalizeClaim clears prepare_started_at
  // immediately on success -- not on a later cleanup tick.
  stopBeating();
  await finalizeClaim(db, claim, result);
}

export async function tick(db: SupabaseClient, llm: AnthropicProvider | null): Promise<boolean> {
  await releaseStale(db);
  const claim = await claimDraft(db);
  if (!claim) return false;
  await processOne(db, llm, claim);
  return true;
}

// Only construct clients / run the loop when executed directly, so the self
// test can import the pure claim/release/finalize helpers without a network.
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const llm = optional("ANTHROPIC_API_KEY") ? new AnthropicProvider() : null;
  if (!llm) log("WARNING: no ANTHROPIC_API_KEY -- resume tailoring falls back to master wording");
  if (once) {
    await tick(db, llm);
    process.exit(0);
  } else {
    log("watching for application DRAFTs to prepare every 5s");
    for (;;) {
      try { await tick(db, llm); } catch (e) { log(`tick error: ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}
