/**
 * A deterministic recruiter-facing language guard for résumé prose.
 *
 * The truth store holds evidence written for many purposes -- some of it
 * captured from a repository or a database inspection, in implementation
 * language ("a scheduled job recomputes obligation statuses ... undelivered
 * alerts spooled for a later run and failures reported to the operator").
 * That is legitimate evidence and stays in the truth store; it must never
 * become a résumé bullet, because a recruiter reads outcomes and
 * capabilities, not a system's internals.
 *
 * This does NOT rewrite or invent anything. It only detects source text that
 * reads like engineering documentation and refuses to let it render, so the
 * composer selects different evidence (or the line is dropped) instead.
 *
 * Two kinds of signal:
 *   - IMPLEMENTATION vocabulary: words that describe how a system is built
 *     or operated rather than what it does for someone.
 *   - STRUCTURAL: a sentence fragment, or a bullet far denser/longer than
 *     the résumé's other bullets.
 */

export const LANGUAGE_QUALITY_VERSION = 1;

export interface LanguageFlag { kind: string; matched: string; reason: string }

/**
 * Implementation / engineering-documentation vocabulary. Each entry is a
 * word or phrase whose presence in a résumé bullet marks it as internals
 * rather than recruiter-facing. Narrow by design: it names the machinery
 * ("scheduled job", "spool", "operator", "cron", "queue", "recompute"), not
 * ordinary product words. A genuinely technical ROLE can allow these back in
 * explicitly (see checkRecruiterLanguage's `allowTechnical`).
 */
const IMPLEMENTATION: Array<{ rx: RegExp; reason: string }> = [
  { rx: /\bscheduled job\b|\bcron\b|\bcron job\b|\bbackground job\b|\bworker process\b/i, reason: "names a scheduled/background job (internal mechanism)" },
  { rx: /\brecompute[sd]?\b|\bre-?compute[sd]?\b/i, reason: "\"recompute\" is implementation language" },
  { rx: /\bspool(ed|s|ing)?\b/i, reason: "\"spool\" is implementation language" },
  { rx: /\b(the )?operator\b/i, reason: "\"operator\" describes running the system, not the product" },
  { rx: /\b(message |job |task )?queue[sd]?\b/i, reason: "names a queue (internal mechanism)" },
  { rx: /\bpipeline[sd]?\b/i, reason: "\"pipeline\" is implementation language" },
  { rx: /\b(database|db|schema|table|row|column|index|foreign key|primary key) (synchroni[sz]ation|sync|migration|record)?\b/i, reason: "database/schema language" },
  { rx: /\bsynchroni[sz]ation\b|\bsynchroni[sz]e[sd]?\b(?! outreach)/i, reason: "\"synchronization\" is implementation language" },
  { rx: /\bobligation status(es)?\b/i, reason: "internal status-record language" },
  { rx: /\bsubsystem[s]?\b|\bmodule[s]?\b(?! )/i, reason: "\"subsystem/module\" is architecture language" },
  { rx: /\b(back[- ]?end|front[- ]?end|full[- ]?stack|micro[- ]?service[s]?|endpoint[s]?|API call[s]?)\b/i, reason: "software-architecture language" },
  { rx: /\bdeterministic (variant )?assignment\b|\bvariant assignment\b|\bexperiment slot[s]?\b/i, reason: "experiment-infrastructure internals" },
  { rx: /\bidempoten|\bthrottl|\bdebounce|\bpolling\b|\bpoll[s]?\b(?! )/i, reason: "low-level control-flow language" },
  { rx: /\bnormali[sz]e[sd]? (information|records|data)\b/i, reason: "\"normalize\" is data-engineering language" },
  { rx: /\breported to the\b|\brouted? to (staff|the)\b/i, reason: "internal routing/reporting language" },
];

/** Trim to compare length against siblings. */
const lenOf = (s: string) => s.replace(/\s+/g, " ").trim().length;

/**
 * Flag a single résumé line. `allowTechnical` lets a genuinely technical role
 * keep implementation vocabulary (still subject to the structural checks).
 */
export function checkRecruiterLanguage(
  text: string,
  opts: { allowTechnical?: boolean; siblingLengths?: number[] } = {},
): LanguageFlag[] {
  const flags: LanguageFlag[] = [];
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return flags;

  if (!opts.allowTechnical) {
    for (const { rx, reason } of IMPLEMENTATION) {
      const m = rx.exec(t);
      if (m) flags.push({ kind: "IMPLEMENTATION", matched: m[0], reason });
    }
  }

  // Sentence fragment: a résumé line should read as a clause with a verb,
  // not a dangling noun phrase. A crude but deterministic proxy: no letter
  // group that could be a verb and no terminal punctuation on a long line.
  // Kept conservative so ordinary bullets are never flagged.
  const words = t.split(/\s+/);
  if (words.length >= 4 && !/[.!?]$/.test(t) && !/\b(built|led|designed|created|launched|shipped|grew|drove|managed|owned|delivered|produced|developed|ran|operates?|operated|helps?|tracks?|alerts?|monitors?|automates?|generates?|identifies|maintains?|supports?|handles?|includes?|covering|from concept)\b/i.test(t)) {
    flags.push({ kind: "STRUCTURAL", matched: t.slice(0, 40), reason: "reads as a fragment (no clear action verb, no terminal punctuation)" });
  }

  // Density: a bullet materially longer than its siblings reads as a
  // paragraph of documentation dropped into a list.
  if (opts.siblingLengths && opts.siblingLengths.length >= 2) {
    const others = opts.siblingLengths.filter((n) => n > 0);
    if (others.length) {
      const median = [...others].sort((a, b) => a - b)[Math.floor(others.length / 2)]!;
      if (lenOf(t) > Math.max(180, median * 2.2)) {
        flags.push({ kind: "STRUCTURAL", matched: `${lenOf(t)} chars`, reason: `far longer than the other bullets (~${median} chars)` });
      }
    }
  }

  return flags;
}

/** True when the text is safe to show a recruiter. */
export function isRecruiterFacing(text: string, opts?: { allowTechnical?: boolean; siblingLengths?: number[] }): boolean {
  return checkRecruiterLanguage(text, opts).length === 0;
}

/**
 * Final gate: throws if any rendered line reads like engineering
 * documentation. Called once a résumé's lines are assembled, so a bad source
 * bullet can never reach a submitted PDF. `allowTechnical` is passed through
 * for a genuinely technical target role.
 */
export function assertRecruiterFacing(
  lines: Array<{ text: string; where?: string }>,
  opts: { allowTechnical?: boolean } = {},
): void {
  const siblingLengths = lines.map((l) => lenOf(l.text));
  const problems: string[] = [];
  for (const l of lines) {
    const flags = checkRecruiterLanguage(l.text, { allowTechnical: opts.allowTechnical, siblingLengths });
    // Only IMPLEMENTATION violations hard-block; structural ones are advisory
    // at the gate (the composer already controls length/order), so the gate
    // stays narrow and never rejects an ordinary bullet.
    const blocking = flags.filter((f) => f.kind === "IMPLEMENTATION");
    if (blocking.length) {
      problems.push(`${l.where ? l.where + ": " : ""}${blocking.map((f) => f.reason).join("; ")} -> ${JSON.stringify(l.text.slice(0, 90))}`);
    }
  }
  if (problems.length) {
    throw new Error(`résumé language guard: ${problems.length} line(s) read as engineering documentation, not recruiter-facing:\n  ${problems.join("\n  ")}`);
  }
}
