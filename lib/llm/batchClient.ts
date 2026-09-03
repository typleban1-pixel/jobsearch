/**
 * The Message Batches endpoints, and the one distinction that matters.
 *
 * create() can fail in two ways that look identical to a caller and are
 * not: the provider REFUSED the batch, or we never learned what it did.
 * A refusal is terminal and safe to retry; an unknown outcome is not,
 * because the create endpoint has no idempotency key and a retry would
 * pay twice. So create() never throws a bare error -- it returns a
 * discriminated result and the caller must handle both.
 */
import { required } from "../env.ts";

const BASE = "https://api.anthropic.com/v1/messages/batches";
const VERSION = "2023-06-01";

const headers = () => ({
  "x-api-key": required("ANTHROPIC_API_KEY"),
  "anthropic-version": VERSION,
  "content-type": "application/json",
});

export interface BatchRequest { custom_id: string; params: Record<string, unknown> }

export interface ProviderBatch {
  id: string;
  processing_status: "in_progress" | "canceling" | "ended";
  request_counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
  created_at: string;
  ended_at: string | null;
  results_url: string | null;
}

/**
 * The three outcomes of a create.
 *
 * UNKNOWN is the important one. It covers a timeout, an aborted socket,
 * a 5xx after the request was accepted, and anything else where the
 * provider may or may not have created the batch. The caller must move
 * to AMBIGUOUS and stop.
 */
export type CreateResult =
  | { outcome: "CREATED"; batch: ProviderBatch }
  | { outcome: "REFUSED"; status: number; detail: string }
  | { outcome: "UNKNOWN"; detail: string };

/**
 * Creates a batch. Called at most once per intent, ever.
 *
 * The timeout is generous because a slow response is not a failed one,
 * and treating it as failure is what manufactures the ambiguity this
 * whole design works around.
 */
export async function createBatch(requests: BatchRequest[], timeoutMs = 120_000): Promise<CreateResult> {
  let res: Response;
  try {
    res = await fetch(BASE, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ requests }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // The request left this process and we never saw an answer. Whether
    // it arrived is not knowable from here.
    return { outcome: "UNKNOWN", detail: `no response from the provider: ${String(e).slice(0, 200)}` };
  }

  if (res.ok) {
    try { return { outcome: "CREATED", batch: (await res.json()) as ProviderBatch }; }
    catch (e) {
      // A 200 we could not parse. The batch very likely exists.
      return { outcome: "UNKNOWN", detail: `provider returned 200 but the body could not be read: ${String(e).slice(0, 160)}` };
    }
  }

  // 4xx is a refusal: the provider rejected the request and made nothing.
  // 5xx is not -- it may have been accepted and failed to respond.
  const body = (await res.text().catch(() => "")).slice(0, 300);
  return res.status >= 400 && res.status < 500
    ? { outcome: "REFUSED", status: res.status, detail: body }
    : { outcome: "UNKNOWN", detail: `provider returned ${res.status}: ${body}` };
}

/** Reads one batch. Safe to call any number of times. */
export async function getBatch(id: string): Promise<ProviderBatch | null> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getBatch ${id}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as ProviderBatch;
}

/** Lists batches, newest first. The only tool for finding an orphan. */
export async function listBatches(limit = 100): Promise<ProviderBatch[]> {
  const res = await fetch(`${BASE}?limit=${limit}`, { headers: headers() });
  if (!res.ok) throw new Error(`listBatches: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { data: ProviderBatch[] }).data;
}

export interface BatchResultLine {
  custom_id: string;
  result: { type: "succeeded"; message: any } | { type: "errored"; error: any }
        | { type: "canceled" } | { type: "expired" };
}

/** Streams the .jsonl results. Only available once processing has ended. */
export async function getResults(resultsUrl: string): Promise<BatchResultLine[]> {
  const res = await fetch(resultsUrl, { headers: headers() });
  if (!res.ok) throw new Error(`getResults: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as BatchResultLine);
}
