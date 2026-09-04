/**
 * Guessing a job's title and company from pasted text, deterministically.
 *
 * Assistive, never authoritative: it reads obvious structured cues and
 * stops. It runs in the portal at paste time with NO model call, so a
 * person sees a suggestion to confirm or correct before generating, and
 * it never blocks generation. When nothing clear is present it says so
 * (confidence NONE) rather than inventing a value from fuzzy guesswork.
 *
 * Confidence:
 *   HIGH  a structured cue said it outright (a label, a heading, "About X")
 *   LOW   a positional heuristic (the first line looks like a title)
 *   NONE  nothing dependable was found; the field is left for the person
 */
export type Confidence = "HIGH" | "LOW" | "NONE";
export interface Detected { value: string | null; confidence: Confidence }
export interface PostingDetection { title: Detected; company: Detected }

const NONE: Detected = { value: null, confidence: "NONE" };
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const linesOf = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** A section header, not a title. */
const SECTION = /^(apply|about|overview|summary|responsibilities|requirements|qualifications|benefits|who we are|what you.?ll do|the role|role|job description|description|compensation|salary|location|posted)\b/i;
/** Words that make a line read like an actual role. */
const ROLE_HINT = /\b(manager|engineer|developer|designer|analyst|director|lead|specialist|coordinator|associate|consultant|architect|scientist|administrator|officer|representative|executive|strategist|advisor|adviser|technician|accountant|recruiter|operations|marketing|sales|product|program|project|counsel|attorney|nurse|partner|principal|head|vp|president|intern|controller|planner|writer|editor|buyer|supervisor)\b/i;
const SENIORITY = /\b(senior|sr\.?|junior|jr\.?|staff|principal|lead|head|chief|vp|vice president|director|entry.level|associate|mid.level)\b/i;

function looksLikeTitle(line: string): boolean {
  const w = clean(line);
  if (!w || w.length > 90) return false;
  if (w.split(/\s+/).length > 12) return false;
  if (/[.!?]$/.test(w)) return false;           // a sentence is not a title
  if (SECTION.test(w)) return false;
  return ROLE_HINT.test(w) || SENIORITY.test(w);
}

/** Pull the first heading out of raw clipboard HTML, if any. */
function headingFromHtml(html: string): string | null {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (!m) return null;
  const text = clean(m[1]!.replace(/<[^>]+>/g, " "));
  return text && text.length <= 90 ? text : null;
}

const LABEL_TITLE = /^(?:job\s*title|position|role|title)\s*[:\-–]\s*(.+)$/i;
const LABEL_COMPANY = /^(?:company|employer|organi[sz]ation|org)\s*[:\-–]\s*(.+)$/i;

/** A proper-noun-ish company name, trimmed at a natural boundary. */
function tidyCompany(raw: string): string | null {
  let s = clean(raw).replace(/[.,;:–\-].*$/, "").trim();  // stop at first punctuation clause
  s = s.replace(/\s+(is|are|was|we|our|the|a|an)\b.*$/i, "").trim();
  if (!s || s.length > 60) return null;
  if (!/[A-Za-z]/.test(s)) return null;
  // reject bare common words ("Scale", "Home") only when a single lowercase-y token
  if (/^\s*(scale|home|remote|us|team|careers?)\s*$/i.test(s)) return null;
  return s;
}

function detectCompany(text: string, lines: string[]): Detected {
  // 1. Explicit label -> HIGH
  for (const l of lines.slice(0, 12)) {
    const m = l.match(LABEL_COMPANY);
    if (m) { const c = tidyCompany(m[1]!); if (c) return { value: c, confidence: "HIGH" }; }
  }
  // 2. Structured phrasings -> HIGH
  const head = lines.slice(0, 8).join("\n");
  const about = head.match(/\bAbout\s+([A-Z][A-Za-z0-9&'’.\- ]{1,45})/)
    ?? head.match(/\bJoin\s+([A-Z][A-Za-z0-9&'’.\- ]{1,45})/);
  if (about) { const c = tidyCompany(about[1]!); if (c) return { value: c, confidence: "HIGH" }; }
  const isA = head.match(/\b([A-Z][A-Za-z0-9&'’.\-]+(?:\s+[A-Z][A-Za-z0-9&'’.\-]+){0,3})\s+is\s+(?:a|an|the|looking|hiring|seeking|building|on a)\b/);
  if (isA) { const c = tidyCompany(isA[1]!); if (c) return { value: c, confidence: "HIGH" }; }
  // 3. "... at Company" -> LOW. Per line, so a match never spills across a
  //    line break into the next sentence.
  for (const l of lines.slice(0, 3)) {
    const at = l.match(/\bat\s+([A-Z][A-Za-z0-9&'’.\-]+(?:\s+[A-Z][A-Za-z0-9&'’.\-]+){0,3})\s*$/)
      ?? l.match(/\bat\s+([A-Z][A-Za-z0-9&'’.\-]+(?:\s+[A-Z][A-Za-z0-9&'’.\-]+){0,3})/);
    if (at) { const c = tidyCompany(at[1]!); if (c) return { value: c, confidence: "LOW" }; }
  }
  return NONE;
}

function detectTitle(lines: string[], html?: string | null): Detected {
  // 1. Explicit label -> HIGH
  for (const l of lines.slice(0, 12)) {
    const m = l.match(LABEL_TITLE);
    if (m) { const t = clean(m[1]!); if (t && t.length <= 90) return { value: t, confidence: "HIGH" }; }
  }
  // 2. A real HTML heading -> HIGH (structured cue from the source page)
  if (html) { const h = headingFromHtml(html); if (h && looksLikeTitle(h)) return { value: h, confidence: "HIGH" }; }
  // 3. Positional heuristic: an early line that looks like a title.
  for (const l of lines.slice(0, 4)) {
    if (looksLikeTitle(l)) {
      const w = clean(l);
      // a strong role/seniority signal reads HIGH; a bare short line is LOW.
      return { value: w, confidence: SENIORITY.test(w) || ROLE_HINT.test(w) ? "HIGH" : "LOW" };
    }
  }
  return NONE;
}

export function detectTitleCompany(text: string, html?: string | null): PostingDetection {
  const lines = linesOf(text ?? "");
  if (!lines.length) return { title: NONE, company: NONE };
  return { title: detectTitle(lines, html), company: detectCompany(text ?? "", lines) };
}
