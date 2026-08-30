/**
 * Three hard negatives that cannot be seen before extraction.
 *
 * Geography and salary are decidable from structured fields. These are
 * not: whether quota-carrying sales is the PRIMARY function of a role,
 * whether pay is PRIMARILY commission, and whether a schedule is a true
 * split shift all require reading the posting.
 *
 * The word doing the work in all three is "primarily". The user has real
 * evidence in customer acquisition, business development, partnerships
 * and phone sales, and none of that should be excluded. What he does not
 * want is a role whose core purpose is hitting an individual quota. So
 * every rule here needs TWO signals agreeing, never one keyword, because
 * a single mention of commission or a sales-sounding title is exactly the
 * kind of thin evidence that would throw away good jobs.
 */

export type RoleShapeFlag =
  | "SPLIT_SHIFT_REQUIRED"
  | "PRIMARY_QUOTA_SALES_ROLE"
  | "PRIMARILY_COMMISSION_COMPENSATION";

export interface RoleShapeInput {
  title: string;
  descriptionText: string;
  requirementTexts: string[];
  salaryMin: number | null;
  salaryMax: number | null;
}

export interface RoleShapeResult {
  flags: RoleShapeFlag[];
  detail: string[];
}

// A genuine split shift: one workday broken into two separated blocks.
// "Shift work" and "split the week between" are not that.
const SPLIT_SHIFT = /\b(split[- ]shift|split shifts|splitshift)\b/i;

// Two tiers, because sales titles are not equally informative.
//
// UNAMBIGUOUS titles have one meaning in the industry. A Sales
// Development Representative prospects against a quota; an Account
// Executive closes against one. Neither is anything else. Requiring
// corroborating quota language for these was too conservative: six
// SDR and BDR postings survived purely because the word "quota" never
// appeared in the text, which says something about how the posting was
// written and nothing about the job.
const UNAMBIGUOUS_QUOTA_TITLE =
  /\b(account executive|sales development representative|business development representative|account development representative|client development representative|\bsdr\b|\bbdr\b|\badr\b)\b/i;

// AMBIGUOUS titles genuinely go either way, so they still need quota
// language to corroborate. Deliberately excludes "Account Manager" and
// "Customer Success Manager": those are retention and relationship roles
// far more often than quota roles, and the user has real evidence there.
const AMBIGUOUS_SALES_TITLE =
  /\b(sales representative|inside sales|outside sales|territory (?:sales )?(?:manager|representative)|enterprise sales|field sales|sales associate|sales consultant|sales specialist)\b/i;

// Roles whose titles contain a sales word but whose function is not
// carrying a quota. Sales engineering is technical pre-sales, sales
// operations and enablement are internal functions, and a Director of
// Field Sales Engineering leads engineers. The first probe flagged all
// three, which is exactly the over-reach this guard exists to stop.
const NOT_QUOTA_CARRYING =
  /\b(sales engineer|sales engineering|solutions? engineer|sales operations|sales enablement|sales ops|revenue operations|sales analyst|sales recruit|sales trainer|sales support|sales systems)\b/i;

// Quota language, as distinct from a passing mention of commission.
const QUOTA = /\b(quota|pipeline generation|new logo|book of business|sales targets?|revenue targets?|\bOTE\b|on-target earnings)\b/i;

// Compensation that is primarily commission, not merely commission-bearing.
const COMMISSION_PRIMARY =
  /\b(100%\s*commission|commission[- ]only|straight commission|uncapped commission with no base|no base salary|purely commission|solely commission|commission[- ]based (?:pay|compensation|role|position))\b/i;

export function assessRoleShape(input: RoleShapeInput): RoleShapeResult {
  const flags: RoleShapeFlag[] = [];
  const detail: string[] = [];
  const haystack = `${input.title}\n${input.descriptionText}\n${input.requirementTexts.join("\n")}`;

  if (SPLIT_SHIFT.test(haystack)) {
    flags.push("SPLIT_SHIFT_REQUIRED");
    detail.push("posting states a split-shift requirement");
  }

  // Two signals required. A sales title alone is not enough, because
  // plenty of them are partnership or account roles; quota language alone
  // is not enough either, because ordinary roles mention targets.
  const notQuotaCarrying = NOT_QUOTA_CARRYING.test(input.title);
  const mentionsQuota = QUOTA.test(haystack);

  if (!notQuotaCarrying && UNAMBIGUOUS_QUOTA_TITLE.test(input.title)) {
    flags.push("PRIMARY_QUOTA_SALES_ROLE");
    detail.push("title is unambiguously a quota-carrying sales role");
  } else if (!notQuotaCarrying && AMBIGUOUS_SALES_TITLE.test(input.title) && mentionsQuota) {
    flags.push("PRIMARY_QUOTA_SALES_ROLE");
    detail.push("sales title plus explicit quota or OTE language: primary function is quota-carrying sales");
  }

  if (COMMISSION_PRIMARY.test(haystack)) {
    // A stated base salary contradicts "primarily commission", so the
    // posting's own numbers get the last word over its wording.
    const hasStatedBase = input.salaryMin !== null || input.salaryMax !== null;
    if (!hasStatedBase) {
      flags.push("PRIMARILY_COMMISSION_COMPENSATION");
      detail.push("compensation described as primarily or wholly commission, with no base salary stated");
    } else {
      detail.push("commission language present but a base salary is stated, so not treated as commission-primary");
    }
  }

  return { flags, detail };
}

/**
 * Preference weights, NOT exclusions.
 *
 * The user was explicit that these must never make an otherwise good job
 * ineligible: travel at any percentage, evenings, weekends, overnights,
 * on-call, unusual time zones, and contract work. Lower disruption is
 * preferred and he will trade it for a better opportunity or higher pay,
 * which is precisely what an Opportunity adjustment expresses and an
 * eligibility gate cannot.
 */
export function schedulePreferenceAdjustment(input: {
  travelPct: number | null;
  descriptionText: string;
}): { points: number; reasons: string[] } {
  const reasons: string[] = [];
  let points = 0;

  if (input.travelPct !== null) {
    if (input.travelPct >= 50) { points -= 6; reasons.push(`${input.travelPct}% travel`); }
    else if (input.travelPct >= 25) { points -= 3; reasons.push(`${input.travelPct}% travel`); }
  }
  if (/\b(overnight|third shift|graveyard)\b/i.test(input.descriptionText)) {
    points -= 4; reasons.push("overnight schedule");
  }
  if (/\b(weekend rotation|weekends required|every other weekend)\b/i.test(input.descriptionText)) {
    points -= 3; reasons.push("weekend rotation");
  }
  if (/\bon-?call\b/i.test(input.descriptionText)) {
    points -= 2; reasons.push("on-call");
  }
  return { points, reasons };
}
