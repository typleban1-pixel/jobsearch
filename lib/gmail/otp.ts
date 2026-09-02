/**
 * Retrieving one verification code, for one application, once.
 *
 * The shape of this module is the security argument. There is no
 * `getCode()` that hands a caller a string it can log, store, or put in
 * an error. The only entrance takes a callback, lends the code to it for
 * the duration of one call, and returns the callback's result plus
 * non-secret provenance. Nothing that escapes this file carries the code.
 *
 * Every constraint below is a gate, not a score. Failing any one is a
 * handoff, and there is deliberately no "most recent wins" anywhere: we
 * observed three identical security-code emails arrive within fourteen
 * minutes for a single application, so "the newest one" is exactly the
 * heuristic that would have picked an arbitrary one of them.
 *
 * See verification.ts for why an email cannot classify itself.
 */
import type { MessageBody } from "./client.ts";
import { classify, expectedCodeLength, type PageContext } from "./verification.ts";

/** How long after the form asked for a code a message may still be it. */
const WINDOW_MS = 10 * 60_000;
/** Most a search may return before the situation is called ambiguous. */
const MAX_CANDIDATES = 5;

export type OtpRequest = {
  /** The application being processed. There is no unbound lookup. */
  applicationId: string;
  employer: { name: string; domain: string | null };
  /** Sender domains this board legitimately mails from. */
  boardSenders: string[];
  /** The mailbox this system reads, which the message must be addressed to. */
  recipient: string;
  /** T: when the form asked for a code. Anchors everything. */
  requestedAt: Date;
  /** What the form is showing, which is what decides the classification. */
  page: PageContext;
};

export type Provenance = {
  applicationId: string;
  messageId: string;
  from: string;
  sentAt: string;
  /** Never the code. Present so an audit row can prove which mail was used. */
  subject: string;
};

export type OtpResult<T> =
  | { ok: true; result: T; provenance: Provenance }
  | { ok: false; handoff: true; reason: string };

/** Injectable so the suite runs offline; production passes the real client. */
export type GmailDeps = {
  searchIds(query: string, limit: number): Promise<string[]>;
  getMessage(id: string): Promise<MessageBody>;
  now(): number;
};

// ---- the screenshot latch --------------------------------------------
//
// A screenshot of a form holding a code is a durable copy of the code, in
// a directory that outlives the run. While a code is in flight nothing
// may capture the page, and the guard throws rather than returning false
// so a caller cannot ignore it by accident.
let codeInFlight = false;
export const screenshotsBlocked = (): boolean => codeInFlight;
export function guardScreenshot(): void {
  if (codeInFlight) {
    throw new Error("refusing to capture the page while a verification code is present in the form");
  }
}

/** Builds the query. Every axis is constrained; none of them is optional. */
export function otpQuery(req: OtpRequest): string {
  const senders = [...req.boardSenders];
  if (req.employer.domain) senders.push(req.employer.domain);
  if (!senders.length) throw new Error("refusing to search with no sender constraint");
  if (!req.recipient) throw new Error("refusing to search with no recipient constraint");
  if (!req.employer.name) throw new Error("refusing to search with no employer constraint");

  const afterSeconds = Math.floor(req.requestedAt.getTime() / 1000);
  return [
    `(${senders.map((s) => `from:${s}`).join(" OR ")})`,
    `to:${req.recipient}`,
    `"${req.employer.name}"`,
    `after:${afterSeconds}`,
    "-in:spam -in:trash",
  ].join(" ");
}

/**
 * Pulls a code out of a body, or refuses to.
 *
 * Shape alone is not enough: an eight character alphanumeric run matches
 * tracking ids and URL fragments, so a candidate must also sit just after
 * wording that introduces a code. Two different candidates is a refusal,
 * not a ranking problem.
 */
export function extractCode(body: string, expectedLength: number | null): {
  code: string | null; reason: string;
} {
  const len = expectedLength;
  const shape = len ? new RegExp(`\\b[A-Za-z0-9]{${len}}\\b`, "g") : /\b[A-Za-z0-9]{4,8}\b/g;
  const intro = /(?:verification|security|confirmation|one.?time|sign.?in|access)\s*(?:code|passcode)\s*(?:is)?\s*[:\-]?|your code is|code[:\s]/gi;

  const found = new Set<string>();
  for (const m of body.matchAll(intro)) {
    const start = (m.index ?? 0) + m[0].length;
    const window = body.slice(start, start + 200);
    for (const c of window.matchAll(shape)) {
      const token = c[0];
      // A run of only letters that spells a word is prose, not a code.
      if (!/\d/.test(token) && !/^[A-Z]+$/.test(token)) continue;
      found.add(token.toUpperCase());
    }
  }
  if (found.size === 0) return { code: null, reason: "no code of the expected shape follows any code wording" };
  if (found.size > 1) {
    return { code: null, reason: `${found.size} different candidate codes are present, which is ambiguous` };
  }
  return { code: [...found][0]!, reason: "exactly one candidate" };
}

/** Removes a code from anything on its way out. Belt and braces. */
const scrub = (text: string, code: string): string =>
  code ? text.split(code).join("[redacted]").split(code.toLowerCase()).join("[redacted]") : text;

/**
 * The only entrance. Lends the code to `use`, then drops it.
 *
 * On every refusal path the return is a handoff with a reason that names
 * what failed and quotes nothing that could be entered into a form.
 */
export async function withVerificationCode<T>(
  req: OtpRequest,
  deps: GmailDeps,
  use: (code: string) => Promise<T>,
): Promise<OtpResult<T>> {
  const handoff = (reason: string): OtpResult<T> => ({ ok: false, handoff: true, reason });

  // 1. The form decides, before any mail is touched.
  const verdict = classify(req.page);
  if (!verdict.mayExtract) {
    return handoff(`${verdict.classification}: ${verdict.why}`);
  }
  if (!req.applicationId) return handoff("no application was bound to this lookup");

  // 2. One constrained search.
  const ids = await deps.searchIds(otpQuery(req), MAX_CANDIDATES);
  if (ids.length === 0) return handoff("no message matched the constrained search");

  // 3. Exactly one message may survive the gates.
  const T = req.requestedAt.getTime();
  const senders = [...req.boardSenders, ...(req.employer.domain ? [req.employer.domain] : [])];
  const kept: MessageBody[] = [];
  const rejected: string[] = [];

  for (const id of ids) {
    const msg = await deps.getMessage(id);
    const from = msg.from.toLowerCase();
    if (!senders.some((s) => from.includes(s.toLowerCase()))) {
      rejected.push("sender is not an expected address for this application"); continue;
    }
    if (!msg.to.toLowerCase().includes(req.recipient.toLowerCase())) {
      rejected.push("addressed to a different recipient"); continue;
    }
    const names = `${msg.subject} ${msg.text}`.toLowerCase();
    if (!names.includes(req.employer.name.toLowerCase())) {
      rejected.push("does not name this employer"); continue;
    }
    if (msg.internalDate < T) { rejected.push("predates the request, so it is a stale code"); continue; }
    if (msg.internalDate > T + WINDOW_MS) { rejected.push("arrived after the window closed"); continue; }
    kept.push(msg);
  }

  if (kept.length === 0) {
    return handoff(`no message survived the constraints (${[...new Set(rejected)].join("; ") || "none matched"})`);
  }
  if (kept.length > 1) {
    return handoff(`${kept.length} messages matched, which is ambiguous; there is no latest-wins fallback`);
  }

  // 4. Exactly one code.
  const message = kept[0]!;
  const { code, reason } = extractCode(message.text, expectedCodeLength(req.page.text));
  if (!code) return handoff(reason);

  const provenance: Provenance = {
    applicationId: req.applicationId, messageId: message.id, from: message.from,
    sentAt: new Date(message.internalDate).toISOString(), subject: message.subject,
  };

  // 5. Lend it, then drop it. The latch closes the screenshot path for
  //    exactly as long as the code could be sitting in the form.
  codeInFlight = true;
  try {
    const result = await use(code);
    return { ok: true, result, provenance };
  } catch (err) {
    // A caller's error can easily carry the value it just tried to type.
    const message = scrub((err as Error)?.message ?? String(err), code);
    throw new Error(`the verification step failed: ${message}`);
  } finally {
    codeInFlight = false;
  }
}
