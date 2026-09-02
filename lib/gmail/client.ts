/**
 * A deliberately narrow Gmail reader.
 *
 * Two calls exist: list ids matching a constrained query, and fetch one
 * message by id. There is no sync, no local mirror of the mailbox, and
 * no way to ask for everything: buildQuery refuses a query with no
 * constraint, so "read my mail" is not expressible through this module.
 *
 * The token behind these calls carries gmail.readonly, so the API would
 * refuse a modify or send even if something here tried to issue one.
 */
import { accessToken } from "./oauth.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Hard ceiling. A job search generates tens of messages, not thousands. */
const MAX_RESULTS = 50;

export type MessageHeaders = {
  id: string;
  threadId: string;
  /** Epoch ms, from Gmail rather than the Date header, which a sender controls. */
  internalDate: number;
  date: string;
  from: string;
  to: string;
  subject: string;
  snippetLength: number;
};

export type MessageBody = MessageHeaders & { text: string };

async function api<T>(path: string, params?: Record<string, string | string[]>): Promise<T> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params ?? {})) {
    for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
  }
  const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
  if (!res.ok) {
    // The body of a Gmail error names the reason without carrying mail
    // content; the bearer token is in the request, never in the reply.
    const detail = await res.text().catch(() => "");
    throw new Error(`Gmail API ${res.status} on ${path}: ${detail.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Builds a Gmail query that is always bounded.
 *
 * Every search this system runs is anchored to senders or subjects it
 * expects and to a time window, so a bug upstream cannot turn into a
 * full-mailbox read.
 */
export function buildQuery(opts: {
  from?: string[];
  subjectAny?: string[];
  withinDays: number;
  extra?: string;
}): string {
  const clauses: string[] = [];
  if (opts.from?.length) clauses.push(`(${opts.from.map((f) => `from:${f}`).join(" OR ")})`);
  if (opts.subjectAny?.length) {
    clauses.push(`(${opts.subjectAny.map((s) => `subject:"${s}"`).join(" OR ")})`);
  }
  if (opts.extra) clauses.push(opts.extra);
  if (!clauses.length) {
    throw new Error("refusing to search Gmail with no sender or subject constraint");
  }
  if (!(opts.withinDays > 0 && opts.withinDays <= 400)) {
    throw new Error("a Gmail search must be bounded to between 1 and 400 days");
  }
  clauses.push(`newer_than:${Math.floor(opts.withinDays)}d`);
  // Nothing this system reads lives in Spam or Trash, and excluding them
  // keeps a stale rejection from being re-read as news.
  clauses.push("-in:spam -in:trash");
  return clauses.join(" ");
}

/** Ids only. Nothing is downloaded at this stage. */
export async function searchIds(query: string, limit = 25): Promise<string[]> {
  const capped = Math.min(Math.max(1, limit), MAX_RESULTS);
  const body = await api<{ messages?: Array<{ id: string }>; resultSizeEstimate?: number }>(
    "/messages", { q: query, maxResults: String(capped) },
  );
  return (body.messages ?? []).map((m) => m.id);
}

type RawMessage = {
  id: string; threadId: string; snippet?: string; internalDate?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    mimeType?: string;
    body?: { data?: string };
    parts?: RawMessage["payload"][];
  };
};

const headerOf = (m: RawMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

const summarize = (m: RawMessage): MessageHeaders => ({
  id: m.id, threadId: m.threadId,
  internalDate: Number(m.internalDate ?? 0),
  date: headerOf(m, "Date"), from: headerOf(m, "From"),
  to: headerOf(m, "To"), subject: headerOf(m, "Subject"),
  snippetLength: (m.snippet ?? "").length,
});

/** Headers only. Enough to decide whether a message is worth opening. */
export async function getHeaders(id: string): Promise<MessageHeaders> {
  return summarize(await api<RawMessage>(`/messages/${encodeURIComponent(id)}`, {
    format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"],
  }));
}

/** One message, with its text flattened. Called only for matched ids. */
export async function getMessage(id: string): Promise<MessageBody> {
  const raw = await api<RawMessage>(`/messages/${encodeURIComponent(id)}`, { format: "full" });
  return { ...summarize(raw), text: flatten(raw.payload) };
}

/** Prefers text/plain; falls back to stripping tags off the HTML part. */
function flatten(payload: RawMessage["payload"], depth = 0): string {
  if (!payload || depth > 8) return "";
  const decode = (d?: string) =>
    d ? Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";

  if (payload.mimeType === "text/plain" && payload.body?.data) return decode(payload.body.data);
  if (payload.parts?.length) {
    const plain = payload.parts.find((p) => p?.mimeType === "text/plain");
    if (plain) return flatten(plain, depth + 1);
    const joined = payload.parts.map((p) => flatten(p, depth + 1)).filter(Boolean).join("\n");
    if (joined) return joined;
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decode(payload.body.data)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/\s+/g, " ").trim();
  }
  return decode(payload.body?.data);
}

/**
 * The senders application mail actually arrives from. Boards send on the
 * employer's behalf, so the board domains matter more than the employer.
 */
export const APPLICATION_SENDERS = [
  // Greenhouse sends from greenhouse-mail.io, not greenhouse.io. Listing
  // only the latter matched nothing at all, which is the failure mode a
  // sender allowlist has: it fails silent and looks like an empty inbox.
  "greenhouse-mail.io", "us.greenhouse-mail.io", "greenhouse.io",
  "lever.co", "hire.lever.co", "ashbyhq.com",
  "myworkday.com", "workday.com",
  "smartrecruiters.com", "icims.com", "jobvite.com", "successfactors.com",
];

export const APPLICATION_SUBJECTS = [
  "thank you for applying", "application received", "your application",
  "we received your application", "application to", "next steps",
  "interview", "update on your application",
];
