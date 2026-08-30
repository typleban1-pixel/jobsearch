import type { ScoringProfile } from "./types.ts";

/**
 * Seniority and title-family signals.
 *
 * The weights for these existed from the start and nothing ever emitted
 * them, so Fit had exactly one positive input: literal skill matching, at
 * a 1 percent hit rate. That is why every score was negative.
 *
 * Both rules below are deterministic and both can decline to fire.
 * "Unknown" is a valid answer and is used often, because a posting that
 * never states seniority should not be guessed at.
 */

const LADDER: Record<string, number> = {
  INTERN: 0, ENTRY: 1, ASSOCIATE: 2, MID: 3, SENIOR: 4,
  LEAD: 5, MANAGER: 5, DIRECTOR: 6, EXECUTIVE: 7,
};

export interface SeniorityVerdict {
  verdict: "MATCH" | "MISMATCH" | "UNKNOWN";
  detail: string;
}

/**
 * The profile's plausible band, derived from verified employment rather
 * than declared. Ty has roughly a decade of contract and staff work with
 * supervision of student employees and no professional-staff management,
 * which supports mid through lead and does not support director or above.
 */
export function assessSeniority(jobSeniority: string, profile: ScoringProfile): SeniorityVerdict {
  if (!jobSeniority || jobSeniority === "UNKNOWN") {
    return { verdict: "UNKNOWN", detail: "posting does not state a seniority level" };
  }
  const level = LADDER[jobSeniority];
  if (level === undefined) return { verdict: "UNKNOWN", detail: `unrecognised level ${jobSeniority}` };

  const managesPeopleEvidence = profile.skills.some((s) => s.name === "Staff supervision");
  const bandMin = 2;                                    // associate
  const bandMax = managesPeopleEvidence ? 5 : 4;        // lead, or senior without management evidence

  if (level >= bandMin && level <= bandMax) {
    return { verdict: "MATCH", detail: `${jobSeniority} sits inside the supported band` };
  }
  if (level > bandMax) {
    return { verdict: "MISMATCH", detail: `${jobSeniority} is above the level the verified profile supports` };
  }
  return { verdict: "MISMATCH", detail: `${jobSeniority} is below the level the profile supports` };
}

/**
 * Title family. Fires only when the title's own words name a function the
 * profile has verified evidence in, so it is a genuine signal rather than
 * a restatement of the concept coverage.
 */
const TITLE_FAMILIES: Array<[string, RegExp]> = [
  ["marketing", /\b(marketing|growth|demand gen|brand|content|seo|acquisition|lifecycle|campaign)\b/i],
  ["ecommerce", /\b(ecommerce|e-commerce|commerce|merchandis|storefront|dtc)\b/i],
  ["operations", /\b(operations|ops\b|implementation|program|project|process|delivery)\b/i],
  ["product", /\b(product)\b/i],
  ["creative", /\b(video|creative|design|motion|producer|multimedia|brand studio)\b/i],
  ["partnerships", /\b(partner|partnership|alliance)\b/i],
  ["support", /\b(support|customer success|client success)\b/i],
];

const FAMILY_EVIDENCE: Record<string, string[]> = {
  marketing: ["SEO", "Email marketing", "Campaign execution", "Marketing funnel design", "Customer acquisition", "Paid advertising", "Branding"],
  ecommerce: ["Shopify", "BigCommerce", "Ecommerce", "Subscription billing"],
  operations: ["Project coordination", "External partnership coordination", "Customer support"],
  product: ["Product ideation", "Launching a new offering", "Pricing"],
  creative: ["Video production", "Video editing", "Motion graphics", "Graphic design", "Email design"],
  partnerships: ["External partnership coordination"],
  support: ["Customer support"],
};

export function assessTitleFamily(title: string, profile: ScoringProfile): { matched: string | null; detail: string } {
  const verified = new Set(profile.skills.map((s) => s.name));
  for (const [family, re] of TITLE_FAMILIES) {
    if (!re.test(title)) continue;
    const backing = (FAMILY_EVIDENCE[family] ?? []).filter((s) => verified.has(s));
    // At least two verified skills in the family, so a single tangential
    // skill cannot make a whole title family "match".
    if (backing.length >= 2) {
      return { matched: family, detail: `title is a ${family} role and ${backing.length} verified skills sit in that family` };
    }
  }
  return { matched: null, detail: "no title family with enough verified evidence behind it" };
}
