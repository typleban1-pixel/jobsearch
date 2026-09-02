/**
 * Batch lifecycle, written so a crash cannot buy the same work twice.
 *
 * THE PROBLEM THIS EXISTS FOR
 *
 * The Message Batches create endpoint accepts no client-supplied
 * idempotency key -- the documented body is `requests[]` of
 * {custom_id, params} and nothing else. So this sequence is ambiguous:
 *
 *   intent written locally
 *   create reaches Anthropic and succeeds
 *   the process dies before the id comes back
 *
 * A worker that treated "no provider_batch_id" as "never submitted"
 * would create and pay for a duplicate. SUBMITTING makes that state
 * representable; AMBIGUOUS makes it terminal until a person looks.
 *
 * Reconciliation cannot close it automatically. Listing batches returns
 * no developer identifier, and results_url stays null until processing
 * ends, so an in-flight orphan can only be matched on created_at and
 * request_counts. That is a heuristic. It is offered to a person as
 * evidence; it never decides.
 */
import { createHash } from "node:crypto";

export const BATCH_STATES = [
  "PLANNED",     // intent written; nothing sent
  "SUBMITTING",  // create is in flight; outcome unknown
  "SUBMITTED",   // provider accepted it and gave us an id
  "PROCESSING",  // provider reports in_progress
  "COMPLETED",   // processing ended; results reconciled
  "FAILED",      // create was definitively refused
  "EXPIRED",
  "CANCELLED",
  "AMBIGUOUS",   // a create was sent and we do not know what happened
] as const;
export type BatchState = (typeof BATCH_STATES)[number];

/** States from which no further provider call may be made automatically. */
const FROZEN = new Set<BatchState>(["AMBIGUOUS"]);
/** States where the work is over. */
const TERMINAL = new Set<BatchState>(["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"]);

export const isTerminal = (s: BatchState) => TERMINAL.has(s);
export const needsHuman = (s: BatchState) => FROZEN.has(s);

/**
 * May a worker create a provider batch for this row, unattended?
 *
 * Only from PLANNED. Not from SUBMITTING -- that is the whole point --
 * and not from AMBIGUOUS, which is SUBMITTING that stopped being
 * transient.
 */
export const maySubmit = (s: BatchState): boolean => s === "PLANNED";

/**
 * What a stalled row becomes.
 *
 * A row left in SUBMITTING by a dead process is not evidence of failure.
 * It is evidence that we stopped watching, which is a different thing,
 * and the only safe reading is that the outcome is unknown.
 */
export const resolveStalled = (s: BatchState): { status: BatchState; reason: string } | null =>
  s === "SUBMITTING"
    ? { status: "AMBIGUOUS",
        reason: "a create request was sent and the process ended before the provider's response was "
          + "recorded. The batch may or may not exist. It is not resubmitted automatically, because "
          + "the create endpoint has no idempotency key and a duplicate would be paid for twice." }
    : null;

/** Request identity, durable across batches. */
export interface RequestIdentity {
  jobId: string;
  descriptionHash: string;
  extractionVersion: number;
  schemaVersion: number;
  attempt: number;
}

/**
 * The identity a request is deduplicated on.
 *
 * The description hash alone is not enough: identical text legitimately
 * belongs to several job records, and a later extractor or schema
 * version needs a fresh extraction of the same words. attempt makes a
 * retry of a terminal failure a new identity rather than a silent
 * bypass.
 */
export const identityKey = (i: RequestIdentity): string =>
  [i.jobId, i.descriptionHash, i.extractionVersion, i.schemaVersion, i.attempt].join("␟");

/** The provider-facing id. Their limit is 64 chars of [a-zA-Z0-9_-]. */
export const customIdFor = (i: RequestIdentity): string =>
  createHash("sha256").update(identityKey(i)).digest("hex").slice(0, 48);

/** Deterministic key for a whole planned batch. */
export const intentKeyFor = (ids: RequestIdentity[]): string =>
  createHash("sha256").update(ids.map(identityKey).sort().join("\n")).digest("hex");

/** Request states that mean the work is still owed to us. */
const LIVE_REQUEST = new Set(["PENDING"]);

/**
 * Which of the wanted identities may be planned into a new batch.
 *
 * Anything already live elsewhere is held back. A terminal request does
 * NOT block: it may be retried, but only as attempt N+1, so the caller
 * has to say so.
 */
export function planAgainstLive(
  wanted: RequestIdentity[],
  live: Array<{ identity: RequestIdentity; status: string }>,
): { plan: RequestIdentity[]; heldBack: RequestIdentity[] } {
  const liveKeys = new Set(
    live.filter((r) => LIVE_REQUEST.has(r.status)).map((r) => identityKey(r.identity)));
  const plan: RequestIdentity[] = [];
  const heldBack: RequestIdentity[] = [];
  for (const w of wanted) (liveKeys.has(identityKey(w)) ? heldBack : plan).push(w);
  return { plan, heldBack };
}

/** Provider processing_status mapped to our own. */
export function fromProviderStatus(s: string, ended: boolean): BatchState {
  if (s === "canceling") return "PROCESSING";
  if (s === "in_progress") return "PROCESSING";
  if (s === "ended") return ended ? "COMPLETED" : "PROCESSING";
  return "PROCESSING";
}

/**
 * Whether a listed provider batch could be the orphan of this intent.
 *
 * Deliberately weak, and named so. The API exposes no developer
 * identifier on the batch object and no results until processing ends,
 * so this can only say "consistent with", never "is". It exists to give
 * a person the shortlist, not to make the decision.
 */
export function couldBeOrphan(
  intent: { requestCount: number; submittingAt: string },
  batch: { created_at: string; request_counts: { processing: number; succeeded: number;
           errored: number; canceled: number; expired: number } },
  windowMs = 15 * 60_000,
): boolean {
  const total = Object.values(batch.request_counts).reduce((a, b) => a + b, 0);
  if (total !== intent.requestCount) return false;
  const dt = new Date(batch.created_at).getTime() - new Date(intent.submittingAt).getTime();
  return dt >= -windowMs && dt <= windowMs;
}
