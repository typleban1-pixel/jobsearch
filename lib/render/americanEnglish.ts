/**
 * American English normalization for employer-facing output.
 *
 * Runs at the RENDERING layer, not only in generation prompts. A prompt
 * can drift between sections of a long document, and mixed conventions
 * inside one resume is exactly the failure this exists to prevent. A
 * final pass cannot drift.
 *
 * The hard part is not the spellings. It is not touching things that only
 * look like spellings: an employer named "Centre for Applied Research"
 * keeps its name, a quoted posting keeps its wording, and a credential is
 * written however the issuing body writes it.
 *
 * This is a rendering constraint. It is never profile evidence and must
 * never reach a score.
 */

export const AMERICAN_ENGLISH_VERSION = 1;

/** British or Commonwealth form on the left, American on the right. */
const SPELLINGS: Array<[RegExp, string]> = [
  [/\borganisation(s?)\b/gi, "organization$1"],
  [/\borganis(e|ed|ing|es)\b/gi, "organiz$1"],
  [/\banalys(e|ed|es|ing)\b/gi, "analyz$1"],
  [/\bbehaviour(s?|al|ally)\b/gi, "behavior$1"],
  [/\bcentre(s?)\b/gi, "center$1"],
  [/\bprogramme(s?)\b/gi, "program$1"],
  [/\bfulfilment\b/gi, "fulfillment"],
  [/\bspecialis(e|ed|ing|es|t|ts)\b/gi, "specializ$1"],
  [/\boptimis(e|ed|ing|es|ation)\b/gi, "optimiz$1"],
  [/\bprioritis(e|ed|ing|es|ation)\b/gi, "prioritiz$1"],
  [/\brecognis(e|ed|ing|es)\b/gi, "recogniz$1"],
  [/\butilis(e|ed|ing|es|ation)\b/gi, "utiliz$1"],
  [/\bcolour(s?|ed|ing|ful)\b/gi, "color$1"],
  [/\bfavour(s?|ed|ing|able|ably)\b/gi, "favor$1"],
  [/\blabour(s?|ed|ing)\b/gi, "labor$1"],
  [/\bdefence\b/gi, "defense"],
  [/\blicence\b/gi, "license"],
  [/\bpractis(e|ed|ing)\b/gi, "practic$1"],
  [/\bcatalogu(e|es|ed|ing)\b/gi, "catalog$1"],
  [/\btravelling\b/gi, "traveling"],
  [/\btravelled\b/gi, "traveled"],
  [/\bmodelling\b/gi, "modeling"],
  [/\bmodelled\b/gi, "modeled"],
  [/\bcancelled\b/gi, "canceled"],
  [/\benrolment\b/gi, "enrollment"],
  [/\bjudgement(s?)\b/gi, "judgment$1"],
  [/\bwhilst\b/gi, "while"],
  [/\bamongst\b/gi, "among"],
  [/\bstorey(s?)\b/gi, "story$1"],
  [/\bmetre(s?)\b/gi, "meter$1"],
  [/\blitre(s?)\b/gi, "liter$1"],
];

/**
 * Long dashes never reach an employer. Same standing rule as the spelling,
 * enforced in the same pass so a document cannot satisfy one and fail the
 * other.
 */
const DASHES: Array<[RegExp, string]> = [
  [/\s*\u2014\s*/g, ", "],
  [/(\d)\s*\u2013\s*(\d)/g, "$1-$2"],
  [/\s*\u2013\s*/g, ", "],
];

export interface NormalizeOptions {
  /**
   * Strings to leave exactly as written: company names, institutions,
   * product names, credentials, quotations. Longest first, so "Centre for
   * Applied Research" is protected before "Centre" can be rewritten.
   */
  protect?: string[];
}

export interface NormalizeResult {
  text: string;
  changes: Array<{ from: string; to: string }>;
  protectedSpans: number;
}

export function toAmericanEnglish(input: string, opts: NormalizeOptions = {}): NormalizeResult {
  const protect = [...(opts.protect ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
  const vault: string[] = [];
  let text = input;

  // Protected spans are lifted out before any rewriting and restored
  // afterwards. It is the only reliable way to stop a substring rule from
  // editing a company's own name.
  for (const phrase of protect) {
    let at = text.indexOf(phrase);
    while (at !== -1) {
      const token = `\u0000P${vault.length}\u0000`;
      vault.push(phrase);
      text = text.slice(0, at) + token + text.slice(at + phrase.length);
      at = text.indexOf(phrase);
    }
  }

  const changes: Array<{ from: string; to: string }> = [];
  for (const [re, to] of [...SPELLINGS, ...DASHES]) {
    text = text.replace(re, (m: string, ...rest: any[]) => {
      const groups = rest.slice(0, -2);
      const replaced = to.replace(/\$(\d)/g, (_, i) => groups[Number(i) - 1] ?? "");
      const out = matchCase(m, replaced);
      if (out !== m) changes.push({ from: m, to: out });
      return out;
    });
  }

  for (let i = 0; i < vault.length; i++) text = text.replaceAll(`\u0000P${i}\u0000`, vault[i]!);
  return { text, changes, protectedSpans: vault.length };
}

/** Preserves capitalization so "Organisation" does not become "organization". */
function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && /[A-Z]{2,}/.test(original)) return replacement.toUpperCase();
  if (/^[A-Z]/.test(original)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}

/** Fails loudly rather than silently emitting non-American output. */
export function assertAmericanEnglish(text: string, opts: NormalizeOptions = {}): void {
  const r = toAmericanEnglish(text, opts);
  if (r.text !== text) {
    throw new Error(
      "employer-facing text is not American English: " +
      r.changes.slice(0, 5).map((c) => `"${c.from}" -> "${c.to}"`).join(", "),
    );
  }
}
