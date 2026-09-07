/**
 * The same answer, worded the tenant's way.
 *
 * A Workday control offers its own labels, and the stored answer is the
 * system's: "US" against "United States of America", "Company website"
 * against "Northern Trust Web Site", a spelled-out ethnicity against
 * Yes/No. None of those is a different answer, and refusing them stopped
 * whole submissions one field short. This decides, as a pure function
 * over the offered labels, which one label the answer names -- or that
 * none does. It never picks among several.
 *
 * Tiers, strictest first: the exact label; the label with a trailing
 * qualifier removed ("White (United States of America)"); the answer's
 * known spellings (US / United States / United States of America, OH /
 * Ohio) against both; Yes/No polarity where the control offers only
 * those; and, only for the generic sourcing answer, the survey
 * preference table -- the same one the resolver uses when a form
 * publishes its options up front.
 */
import { equivalents } from "../applications/answer.ts";
import { normalizeCountryName, normalizeRegionName } from "../browser/geography.ts";
import { GENERIC_SURVEY_FREETEXT, pickSurveyOption } from "../applications/lowStakesSurvey.ts";

export type OptionMatch =
  | { ok: true; label: string; how: string }
  | { ok: false; hits: string[]; labels: string[] };

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
/** "White (United States of America)" -> "white"; "United States of America (+1)" -> "united states of america". */
export const unqualify = (l: string) => norm(l.replace(/\s*\((?:[^()]*)\)\s*$/, ""));

const isGenericSource = (wanted: string) =>
  norm(wanted) === norm(GENERIC_SURVEY_FREETEXT) || /^(?:company|employer|corporate)\s*(?:web\s*site|website|site)$/i.test(wanted.trim());

export function matchOptionLabel(offered: string[], wanted: string): OptionMatch {
  // The same label read twice is one option, not an ambiguity: a popup
  // scan that swept in a second copy must not turn a match into a tie.
  const labels = [...new Set(offered.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean))];
  const want = norm(wanted);
  const done = (hits: string[], how: string): OptionMatch =>
    hits.length === 1 ? { ok: true, label: hits[0]!, how } : { ok: false, hits, labels };

  let hits = labels.filter((l) => norm(l) === want);
  if (hits.length) return done(hits, "exact");

  hits = labels.filter((l) => unqualify(l) === want);
  if (hits.length) return done(hits, "unqualified");

  const spellings = equivalents(wanted).map(norm);
  hits = labels.filter((l) => spellings.includes(norm(l)) || spellings.includes(unqualify(l)));
  if (hits.length) return done(hits, "spelling");

  const wc = normalizeCountryName(wanted);
  hits = labels.filter((l) => normalizeCountryName(l) === wc || normalizeCountryName(unqualify(l)) === wc);
  if (hits.length) return done(hits, "country");
  const wr = normalizeRegionName(wanted);
  hits = labels.filter((l) => normalizeRegionName(l) === wr || normalizeRegionName(unqualify(l)) === wr);
  if (hits.length) return done(hits, "region");

  // Only where the control genuinely offers just Yes and No.
  const yesNo = labels.filter((l) => /^(yes|no)$/i.test(l));
  if (yesNo.length === 2 && labels.length === 2) {
    const negative = /^(not\b|no\b|i am not\b|i do not\b|i don't\b|decline)/i.test(wanted.trim());
    const positive = /^(yes\b|i am\b|i do\b)/i.test(wanted.trim());
    if (negative) return done(labels.filter((l) => /^no$/i.test(l)), "polarity");
    if (positive) return done(labels.filter((l) => /^yes$/i.test(l)), "polarity");
  }

  // The generic sourcing answer, against a list the form did not publish
  // up front. Same preference table, same refusal of specific channels.
  if (isGenericSource(wanted)) {
    const pick = pickSurveyOption(labels);
    if (pick) return { ok: true, label: pick.value, how: `survey: ${pick.reason}` };
  }

  return { ok: false, hits: [], labels };
}
