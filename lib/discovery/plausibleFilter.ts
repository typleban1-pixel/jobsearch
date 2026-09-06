/**
 * The cheap, deterministic plausibility prefilter.
 *
 * Eligibility already decided location, salary and dealbreakers. This adds
 * the two signals that decide whether a posting is worth an LLM extraction
 * call at all: is it in a function this person could plausibly do, and is it
 * at a level they could plausibly hold. Everything it lets through still
 * faces the real qualification test (extraction -> fit -> candidacy); its
 * only job is to keep obviously-irrelevant postings from ever costing money.
 *
 * Deliberately biased toward BREADTH. It EXCLUDES only two things: a clearly
 * different occupation (a backend engineer, a nurse, a litigator, a
 * quant trader, a warehouse role) and clear leadership seniority (director
 * and up). Everything else -- a named relevant function OR an ambiguous
 * generalist title -- passes, because the candidacy engine evaluates the
 * actual responsibilities and a cheap title filter must not pre-empt it.
 * Distinct disciplines are never treated as interchangeable here; that
 * judgement is the extractor's and candidacy's, not this filter's.
 */

export interface PlausibleInput {
  title: string;
  /** job_versions.seniority, when known (e.g. DIRECTOR, LEAD, SENIOR, MID). */
  seniority?: string | null;
  /** job_versions.is_individual_contributor, when known. */
  isIC?: boolean | null;
}

export interface PlausibleVerdict { plausible: boolean; reason: string }

/**
 * Occupations clearly outside this person's evidence. Each pattern names a
 * discipline whose core is a body of experience he does not have and that no
 * marketing/operations/creative background stands in for. Kept narrow: it
 * matches the occupation, not a word that merely appears in a broader role
 * ("marketing analyst" is not excluded by "analyst").
 */
const IRRELEVANT: RegExp[] = [
  // Any engineering role: the discipline is a body of experience this
  // person does not have, and "engineer"/"engineering" in a title always
  // names it (Security Operations Engineer, Software Engineer, Engineering
  // at X). No verified-evidence function is titled "engineer".
  /\bengineer(ing)?\b/i,
  /\b(data scientist|research scientist|scientist|biologist|chemist|physicist|geologist|bioinformatic)\b/i,
  // Clinical / medical / care.
  /\b(nurse|nursing|physician|clinician|clinical|medical assistant|pharmacist|therapist|caregiver|dental|veterinar|phlebotom|radiolog|surgeon)\b/i,
  // Legal.
  /\b(attorney|lawyer|counsel|paralegal|litigation|litigator)\b/i,
  // Accounting / quantitative finance.
  /\b(accountant|\bcpa\b|controller|auditor|bookkeep|actuar|underwrit|quantitative|\bquant\b|trader|trading desk|portfolio manager|investment banker|equity research)\b/i,
  // Quota-carrying / pre-sales technical.
  /\b(sales engineer|solutions engineer|solutions architect|pre[- ]?sales|sales representative|account executive|\bsdr\b|\bbdr\b)\b/i,
  // Recruiting.
  /\b(recruiter|recruiting|talent acquisition|sourcer)\b/i,
  // Skilled trades / frontline hourly.
  /\b(warehouse|forklift|electrician|plumber|hvac|welder|machinist|assembler|picker|packer|barista|cashier|custodian|janitor|driver|delivery|line cook|dishwasher|security guard|maintenance technician)\b/i,
  // Education instruction.
  /\b(teacher|professor|lecturer|faculty|adjunct|tutor)\b/i,
];

/** Leadership levels this person does not hold. Structured seniority wins
 * when present; the title is the fallback. */
const LEADERSHIP_TITLE = /\b(director|vice president|\bvp\b|\bsvp\b|\bevp\b|head of|chief|\bc[teofpm]o\b|president|managing director|general manager|partner|principal)\b/i;
const LEADERSHIP_SENIORITY = new Set(["DIRECTOR", "VP", "VICE_PRESIDENT", "EXECUTIVE", "C_LEVEL", "PRINCIPAL", "HEAD"]);

/**
 * Named functions this person's verified evidence supports, broadly. Used
 * only to log WHY an ambiguous pass happened; a title that matches none of
 * these still passes unless it is excluded above, so breadth is preserved.
 */
const RELEVANT = /\b(market|growth|digital|e[- ]?commerce|brand|content|creative|video|motion|social|seo|sem|paid media|demand gen|lifecycle|campaign|community|operations|\bops\b|process|implementation|onboarding|customer success|client success|account manager|program manager|project (manager|coordinator)|coordinat|product (manager|operations|marketing)|business operations|revenue operations|marketing operations|go[- ]to[- ]market|\bgtm\b|partnership|strategy|specialist|associate|analyst|generalist|ecommerce)\b/i;

export function isPlausibleJob(input: PlausibleInput): PlausibleVerdict {
  const t = (input.title ?? "").toLowerCase();
  if (!t.trim()) return { plausible: false, reason: "no title to judge" };

  // Seniority: the structured signal is authoritative when present.
  if (input.seniority && LEADERSHIP_SENIORITY.has(input.seniority.toUpperCase())) {
    return { plausible: false, reason: `leadership seniority (${input.seniority})` };
  }
  // Title-level leadership, unless the record explicitly marks it an IC role.
  if (LEADERSHIP_TITLE.test(t) && input.isIC !== true) {
    return { plausible: false, reason: "leadership title (director/VP/head/chief/principal)" };
  }

  for (const rx of IRRELEVANT) {
    if (rx.test(t)) return { plausible: false, reason: "occupation outside verified evidence" };
  }

  // Everything that is not excluded passes -- a named relevant function or
  // an ambiguous generalist title. Candidacy makes the real call.
  return { plausible: true, reason: RELEVANT.test(t) ? "relevant function" : "ambiguous title, left for candidacy" };
}
