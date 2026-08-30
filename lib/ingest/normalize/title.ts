/**
 * Title analysis: seniority, and whether the role manages people.
 *
 * The hard case is "Manager". "Engineering Manager" leads a team;
 * "Product Manager" does not. Getting this wrong in either direction
 * corrupts the one career-quality signal the user named first, so the
 * ambiguous middle returns null rather than a guess.
 */

export type Seniority =
  | "INTERN" | "ENTRY" | "ASSOCIATE" | "MID" | "SENIOR" | "LEAD"
  | "MANAGER" | "DIRECTOR" | "EXECUTIVE" | "UNKNOWN";

export interface TitleAnalysis {
  normalizedTitle: string;
  seniority: Seniority;
  managesPeople: boolean | null;
  isIndividualContributor: boolean | null;
  warnings: string[];
}

// "Manager" titles that are individual-contributor roles by convention.
const IC_MANAGER_TITLES = [
  "product manager", "program manager", "project manager", "account manager",
  "customer success manager", "partner manager", "partnerships manager",
  "community manager", "social media manager", "marketing manager",
  "product marketing manager", "technical account manager", "delivery manager",
  "category manager", "brand manager", "content manager", "campaign manager",
  "channel manager", "alliance manager", "implementation manager",
  "relationship manager", "portfolio manager", "case manager",
];

const PEOPLE_MANAGER_PATTERNS: RegExp[] = [
  /\bengineering manager\b/i,
  /\bmanager\s*,\s*\w/i,                        // "Manager, Data Platform"
  /\bmanager\s+(?:i{1,3}|\d)\s*,\s*\w/i,        // "Manager II, Customer Success"
  /\bmanager of\b/i,
  /\b(team|group|people|staff)\s+manager\b/i,
  /\b(senior|sr\.?)\s+manager\b/i,
  /\bhead of\b/i,
  /\bdirector\b/i,
  /\bvp\b|\bvice president\b/i,
  /\bchief\b/i,
];

export function analyzeTitle(rawTitle: string): TitleAnalysis {
  const warnings: string[] = [];
  const title = rawTitle.replace(/\s+/g, " ").trim();
  const t = title.toLowerCase();
  // Sales titles carry region codes that collide with roman-numeral
  // levels: "Account Executive - UK&I" is not a level I role. Stripped
  // before any seniority test so the numeral rules never see them.
  const tForLevel = t.replace(/\b[a-z]{2,6}\s?[&\/]\s?i\b/g, " ");

  // Strip trailing location/req noise some boards append to the title.
  const normalizedTitle = title
    .replace(/\s*[([]\s*(remote|hybrid|onsite|contract|us|usa)\s*[)\]]\s*$/i, "")
    .replace(/\s*[-–—]\s*(remote|hybrid|onsite)\s*$/i, "")
    .trim();

  const isIcManagerTitle = IC_MANAGER_TITLES.some((p) => t.includes(p));
  const peopleManagerHit = PEOPLE_MANAGER_PATTERNS.some((re) => re.test(t));
  const hasManagerWord = /\bmanager\b|\bmgr\b/i.test(t);

  let managesPeople: boolean | null = null;
  if (peopleManagerHit && !isIcManagerTitle) {
    managesPeople = true;
  } else if (isIcManagerTitle && !/\bdirector\b|\bhead of\b|\bvp\b|\bchief\b/i.test(t)) {
    managesPeople = false;
  } else if (hasManagerWord) {
    // A "Manager" the patterns did not resolve. Unknown stays unknown.
    warnings.push(`title contains "manager" but IC-vs-people-management is not determinable from the title alone`);
  } else if (/\b(engineer|developer|designer|analyst|scientist|specialist|associate|consultant|architect|writer|recruiter|accountant|controller)\b/i.test(t)) {
    managesPeople = false;
  }

  const seniority = deriveSeniority(t, managesPeople, tForLevel);
  const isIndividualContributor = managesPeople === null ? null : !managesPeople;

  return { normalizedTitle, seniority, managesPeople, isIndividualContributor, warnings };
}

function deriveSeniority(t: string, managesPeople: boolean | null, tForLevel: string): Seniority {
  if (/\bintern(ship)?\b|\bco-?op\b/.test(t)) return "INTERN";
  if (/\bchief\b|\bc[teoif]o\b|\bvp\b|\bvice president\b|\bhead of\b|\bpresident\b/.test(t)) return "EXECUTIVE";
  if (/\bdirector\b/.test(t)) return "DIRECTOR";
  // Only a title we actually resolved as people-management becomes MANAGER.
  if (managesPeople === true && /\bmanager\b|\bmgr\b/.test(t)) return "MANAGER";
  if (/\b(staff|principal|distinguished|fellow)\b/.test(t)) return "LEAD";
  // "Lead" as a noun ("Tech Lead"), not as a verb inside a longer phrase.
  if (/\blead\b/.test(t) && !/\bleads?\s+(the|a|our)\b/.test(t)) return "LEAD";
  if (/\b(senior|snr|sr\.?)\b/.test(t)) return "SENIOR";
  if (/\b(junior|jr\.?|entry[- ]level|graduate|new grad)\b/.test(t)) return "ENTRY";
  if (/\bassociate\b/.test(t)) return "ASSOCIATE";
  if (/\b(iii|3)\b/.test(tForLevel)) return "SENIOR";
  if (/\b(ii|2)\b/.test(tForLevel)) return "MID";
  if (/\b(i|1)\b/.test(tForLevel)) return "ENTRY";
  return "UNKNOWN";
}
