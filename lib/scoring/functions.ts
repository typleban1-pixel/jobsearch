/**
 * Functional domains, for measuring breadth.
 *
 * The first pass gave nearly every job a Generalist score of 16, because
 * it counted requirement KINDS (skill, tool, domain) and looked for
 * "cross-functional" in the text. Almost every posting has three kinds
 * and says cross-functional, so the measure had no variance and told us
 * nothing.
 *
 * Breadth is not how many kinds of requirement a posting has. It is how
 * many distinct BUSINESS FUNCTIONS the role reaches across. A role
 * demanding marketing, product, operations and data spans four functions
 * and genuinely rewards a generalist. One demanding five backend
 * technologies spans one and rewards depth.
 */

export const FUNCTION_VERSION = 1;

export type BusinessFunction =
  | "MARKETING" | "SALES" | "PRODUCT" | "ENGINEERING" | "DATA"
  | "OPERATIONS" | "FINANCE" | "PEOPLE" | "DESIGN" | "LEGAL"
  | "CLINICAL" | "SUPPORT" | "SUPPLY_CHAIN";

const FUNCTION_PATTERNS: Array<[BusinessFunction, RegExp]> = [
  ["MARKETING", /\b(marketing|seo|sem|email marketing|campaign|brand|content|advertis|demand gen|growth|acquisition|funnel|copywrit|social media|paid media|crm)\b/i],
  ["SALES", /\b(sales|quota|pipeline|prospect|closing|account executive|revenue target|upsell|cross-sell|negotiat)\b/i],
  ["PRODUCT", /\b(product management|product manager|roadmap|user stor|product strategy|discovery|prd|product requirements|prioriti[sz]ation|product ideation|product launch)\b/i],
  ["ENGINEERING", /\b(software|engineering|python|java|javascript|typescript|react|node|api|backend|frontend|kubernetes|docker|aws|azure|gcp|ci\/cd|microservice|architecture|code|programming|devops)\b/i],
  ["DATA", /\b(sql|analytics|data analysis|tableau|looker|power bi|databricks|dashboard|reporting|metrics|statistic|data model|etl|bigquery|snowflake)\b/i],
  ["OPERATIONS", /\b(operations|process improvement|workflow|logistics|fulfillment|warehouse|scheduling|vendor|procurement|project coordination|program management|implementation)\b/i],
  ["FINANCE", /\b(finance|financial|fp&a|budget|forecast|accounting|p&l|revenue recognition|pricing|cost analysis|audit)\b/i],
  ["PEOPLE", /\b(recruit|hiring|talent|onboarding|people management|coaching|mentoring|training|hr\b|human resources|performance management)\b/i],
  ["DESIGN", /\b(design|figma|ux|ui\b|user experience|visual|motion graphics|graphic|video|photography|creative|adobe)\b/i],
  ["LEGAL", /\b(legal|compliance|regulatory|contract|privacy|gdpr|ccpa|counsel|litigation|policy)\b/i],
  ["CLINICAL", /\b(clinical|patient|nurse|physician|medical|diagnos|treatment|emr|electronic medical record|pharmac|therap|care delivery)\b/i],
  ["SUPPORT", /\b(customer support|technical support|help desk|troubleshoot|ticket|escalation|customer service|customer success)\b/i],
  ["SUPPLY_CHAIN", /\b(supply chain|inventory|shipping|freight|carrier|customs|transportation|warehouse management|procurement)\b/i],
];

export function functionsOf(text: string): BusinessFunction[] {
  const out = new Set<BusinessFunction>();
  for (const [fn, re] of FUNCTION_PATTERNS) if (re.test(text)) out.add(fn);
  return [...out];
}

/**
 * Breadth across a job's requirement concepts.
 *
 * Counted per concept and then aggregated, so a posting that mentions
 * marketing forty times still contributes one function. A function needs
 * at least two distinct concepts to count as genuinely spanned: one
 * passing mention of a dashboard does not make a role a data role.
 */
export function jobFunctionProfile(concepts: string[], title: string): {
  spanned: BusinessFunction[];
  primary: BusinessFunction | null;
  conceptsPerFunction: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  for (const c of concepts) for (const fn of functionsOf(c)) counts[fn] = (counts[fn] ?? 0) + 1;
  for (const fn of functionsOf(title)) counts[fn] = (counts[fn] ?? 0) + 2;  // the title is a strong signal

  const spanned = Object.entries(counts).filter(([, n]) => n >= 2).map(([f]) => f as BusinessFunction);
  const primary = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] as BusinessFunction ?? null;
  return { spanned, primary, conceptsPerFunction: counts };
}
