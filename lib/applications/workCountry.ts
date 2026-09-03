/**
 * Where he anticipates working: the United States.
 *
 * A standing, user-declared truth, and like every standing answer its
 * value is in its scope. This one answers "which country or countries do
 * you anticipate working in" and nothing else. Citizenship, work
 * authorisation, sponsorship, nationality and travel all sound adjacent,
 * all appear on the same forms, and all have their own answers that this
 * declaration does not supply -- answering them from here would be
 * inventing facts about immigration status.
 *
 * Residence is excluded too. It is a different question and already
 * resolves on its own from the profile; claiming it here would mean two
 * rules answering one field, which is the failure mode that stopped the
 * Stripe run in the first place.
 */
import { normalizeCountryName } from "../browser/geography.ts";

export const ANTICIPATED_WORK_COUNTRY = "United States";

export type WorkCountryMatch = { covered: boolean; why: string; excludedBy?: string };

/** Questions that merely sound like it, checked first. */
const NOT_THIS_QUESTION: { re: RegExp; what: string }[] = [
  { re: /\bcitizen(?:ship)?\b|\bnational(?:ity)?\b|\bpassport\b/i, what: "citizenship or nationality" },
  { re: /\bauthori[sz]ed\b|\bauthori[sz]ation\b|\beligible to work\b|\bright to work\b|\bwork permit\b/i,
    what: "work authorisation" },
  { re: /\bsponsor\w*\b|\bvisa\b|\bimmigration\b|\bh-?1b\b/i, what: "sponsorship or visa status" },
  { re: /\btravel\b|\brelocat\w*\b/i, what: "travel or relocation" },
  { re: /\breside\w*\b|\bresidenc\w*\b|\bcurrently live\b|\bhome (?:country|address)\b/i,
    what: "country of residence" },
];

/** The wording this rule is for. */
const COVERED: RegExp[] = [
  /\bcountr(?:y|ies)\b[^?.]{0,60}\banticipate\b[^?.]{0,30}\bwork/i,
  /\banticipate\b[^?.]{0,40}\bwork\w*\b[^?.]{0,30}\bcountr(?:y|ies)\b/i,
  /\bcountr(?:y|ies)\b[^?.]{0,60}\b(?:expect|plan|intend)\w*\b[^?.]{0,30}\bwork/i,
  /\bin (?:which|what) countr(?:y|ies)\b[^?.]{0,40}\bwork(?:ing)?\b/i,
  /\bwork(?:ing)? location\b[^?.]{0,20}\bcountr(?:y|ies)\b/i,
];

export function matchesAnticipatedWorkCountry(text: string): WorkCountryMatch {
  const t = String(text ?? "");
  if (!t.trim()) return { covered: false, why: "no question text" };
  for (const x of NOT_THIS_QUESTION) {
    const m = x.re.exec(t);
    if (m) {
      return { covered: false, excludedBy: m[0].trim(),
        why: `this asks about ${x.what}, which the anticipated-work-country answer does not cover` };
    }
  }
  for (const re of COVERED) {
    if (re.test(t)) return { covered: true, why: "asks which country the work will happen in" };
  }
  return { covered: false, why: "the wording does not ask which country the work will happen in" };
}

export type OptionMatch =
  | { ok: true; option: string; how: string }
  | { ok: false; why: string; candidates: string[] };

/**
 * Map a verified answer onto exactly one of the employer's own options.
 *
 * Fails closed in both directions. No match is a stop, and more than one
 * match is a stop rather than a tie to break: the whole point of naming
 * one country is that the form records one country.
 *
 * Never substring-matches. "US" is a substring of nothing useful and a
 * superstring of nothing either, but "Ireland" sits inside "Northern
 * Ireland" and "China" inside "Taiwan, China", so a contains-test would
 * quietly answer a different country.
 */
export function matchCountryOption(options: string[], answer: string): OptionMatch {
  const opts = options.filter((o) => String(o ?? "").trim());
  if (!opts.length) return { ok: false, why: "the control offered no options", candidates: [] };

  const exact = opts.filter((o) => o.trim().toLowerCase() === answer.trim().toLowerCase());
  if (exact.length === 1) return { ok: true, option: exact[0]!, how: "exact label" };
  if (exact.length > 1) {
    return { ok: false, why: `${exact.length} options carry the identical label ${JSON.stringify(answer)}`, candidates: exact };
  }

  const want = normalizeCountryName(answer);
  const same = opts.filter((o) => normalizeCountryName(o) === want);
  if (same.length === 1) return { ok: true, option: same[0]!, how: `country name (${want})` };
  if (same.length > 1) {
    return { ok: false, why: `${same.length} options name the same country as ${JSON.stringify(answer)}`, candidates: same };
  }
  return { ok: false, why: `no option names ${JSON.stringify(answer)}`, candidates: opts };
}
