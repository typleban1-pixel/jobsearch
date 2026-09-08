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
  // Note the plural "s": "Software Engineers"/"Developers" must be caught too
  // (a trailing \b after the singular silently missed the plural form).
  /\bengineer(ing|s)?\b/i,
  /\b(data scientist|research scientist|scientist|biologist|chemist|physicist|geologist|bioinformatic)\b/i,
  // Clinical / medical / care.
  /\b(nurse|nursing|physician|clinician|clinical|medical assistant|pharmacist|therapist|caregiver|dental|veterinar|phlebotom|radiolog|surgeon)\b/i,
  // Legal.
  /\b(attorney|lawyer|counsel|paralegal|litigation|litigator)\b/i,
  // Accounting / assurance / quantitative finance. "actuar" needs an explicit
  // suffix or the trailing \b never matches "actuary"/"actuarial".
  /\b(accountant|\bcpa\b|controller|auditor|audit|assurance|bookkeep|actuar(?:y|ies|ial)|underwrit|quantitative|\bquant\b|trader|trading desk|portfolio manager|investment banker|equity research)\b/i,
  // Quota-carrying / pre-sales technical.
  /\b(sales engineer|solutions engineer|solutions architect|pre[- ]?sales|sales representative|account executive|\bsdr\b|\bbdr\b)\b/i,
  // Recruiting.
  /\b(recruiter|recruiting|talent acquisition|sourcer)\b/i,
  // Skilled trades / frontline hourly.
  /\b(warehouse|forklift|electrician|plumber|hvac|welder|machinist|assembler|picker|packer|barista|cashier|custodian|janitor|driver|delivery|line cook|dishwasher|security guard|maintenance technician)\b/i,
  // Education instruction.
  /\b(teacher|professor|lecturer|faculty|adjunct|tutor)\b/i,
  // Specialist design PRODUCTION roles. This person is a generalist with
  // creative-adjacent evidence (content, video, brand strategy), not a
  // production designer, and is not looking for a role that is only that.
  // Matches the noun "designer" (Graphic/Visual/UX/Product Designer), so it
  // deliberately does NOT catch generalist "Design Manager", "Design
  // Program Manager" or "Design Ops" titles, which contain "design" but not
  // "designer".
  /\bdesigner\b/i,
  // Additional off-target families the blocklist missed (evidence: a sweep of
  // the plausible pool). Each is high-precision — worded to name the
  // off-target ROLE and not a word that also appears in a generalist title,
  // because the breadth strategy must never drop a good role at this gate.
  //
  // Software development (same reasoning as "engineer": a discipline this
  // person does not evidence). The negative lookahead preserves the
  // developer-facing MARKETING/community family (Developer Relations,
  // Developer Advocate/Marketing/Experience/Platform), which is a generalist
  // function this person could hold, and drops only the engineer role.
  /\bdevelopers?\b(?!\s+(relations|advocate|marketing|experience|platform|community|ecosystem|success|program))/i,
  // Manufacturing / skilled-technical frontline. "technician"/"mechanic" name
  // the role directly; "manufacturing associate/operator" is bounded so the
  // sector word alone (e.g. a marketing role for a manufacturer) is not hit.
  /\b(technician|mechanic|welder|welding|cnc|machine operator|manufacturing (associate|operator|technician))\b/i,
  // Enterprise-platform specialists (ERP/HRIS and their admins/devs). Off
  // target for a generalist marketer/operator; the platform name in a title
  // reliably marks the specialist role.
  /\b(workday|peoplesoft|epm|hris|\berp\b|mulesoft|netsuite|servicenow)\b/i,
  // Clinical delivery not already covered by the medical list above.
  /\b(patient access|patient care|advanced practice provider|physician assistant|nurse practitioner|psychiatrist)\b/i,
  // Quota-carrying / field sales management. Bounded to the adjacent phrase so
  // "Sales Operations Manager" or "Sales Enablement Manager" (ops-adjacent,
  // relevant) are NOT caught.
  /\b(sales manager|territory manager|regional sales|district manager|sales territory)\b/i,
  // Insurance carrier / brokerage delivery roles.
  /\b(insurance agent|licensed insurance|insurance broker|claims (adjuster|specialist|manager|examiner|representative|associate))\b/i,
  // Commercial real-estate / facilities operations.
  /\b(leasing|property manager|facilities (coordinator|manager|management|associate)|mailroom|janitorial)\b/i,
  // Bare frontline "tech" (a technician synonym) and field/plant operators.
  /\b(\btech\b|field operator|field specialist|yard worker|dismantler|disassembly|process operator|quality inspector)\b/i,
  // Further off-target families observed leaking into the kept set: clinical
  // (RN and allied-health suffixes the "nurse" pattern missed), tax, investment
  // banking, security/risk, QA, plant operator, and Salesforce platform
  // specialists (but NOT generalist "Salesforce Marketing Cloud" ops).
  /\b(registered nurse|rn|per diem|cytologist|sonographer|radiologic|phlebotomist|investment bank|\btax\b|insider threat|insider & data|soc analyst|security analyst|cybersecurity|operator|test lead|test analyst|salesforce (developer|administrator|admin|consultant|architect))\b/i,
  // Finance specialists beyond the accountant/auditor list above.
  /\b(fund accounting|payroll|treasury|financial due diligence|tax (analyst|manager|associate|expert|senior|consultant|accountant))\b/i,
];

/**
 * Early-career / training roles this person (an experienced hire) is not a
 * candidate for. Precise by design: bounded phrases, never a bare "student"
 * (which would wrongly catch a "Student Success Manager" ops role) and never
 * a bare "fellow" (which appears in senior titles). Matches the whole word so
 * "international" is not caught by "intern".
 */
const EARLY_CAREER = /\b(intern|internships?|co[- ]?op|apprentice(ship)?|trainee|new[- ]grad(uate)?|(recent|university|college)\s+graduate|early[- ]career|fellowship|working student|rotational program)\b/i;

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

/**
 * The RANKED-LIST allowlist. Stricter than isPlausibleJob (which is the
 * breadth-biased extraction-cost gate): this keeps a title ONLY if it names
 * one of the candidate's actual target functions. Used at card build so the
 * Jobs list shows target-function roles and not the finance / IB / bare-analyst
 * / consulting residue that a blocklist can never fully enumerate. A leadership
 * title is still excluded (via isPlausibleJob below), so this is an AND with it.
 */
const TARGET_FUNCTION = /(\bproduct manager\b|\bproduct management\b|\bproduct owner\b|\bproduct marketing\b|\bproduct operations\b|\bprogram manager\b|\bprogram management\b|\btpm\b|\btechnical program\b|\bmarketing\b|\bgrowth\b|\bdemand gen\b|\bdemand generation\b|\blifecycle\b|\bcontent\b|\bbrand\b|\bsocial media\b|\bcampaign\b|\bseo\b|\bsem\b|\bpaid media\b|\baffiliate\b|\bcustomer success\b|\bclient success\b|\bcsm\b|\bcustomer education\b|\bcustomer marketing\b|\benablement\b|\brevenue operations\b|\brevops\b|\bbusiness operations\b|\bsales operations\b|\bgo[- ]to[- ]market\b|\bgtm\b|\bpartner marketing\b|\bpartnerships\b|\bpartner manager\b|\bimplementation\b|\bonboarding\b|\bcommunications\b|\bcategory manager\b|\boperations associate\b|\boperations manager\b|\boperations program\b|\bstrategy (&|and) operations\b|\bstrategy (&|and) analytics\b|\bdeveloper advocate\b|\bdeveloper relations\b|\btechnical account manager\b)/i;

export function isTargetFunction(title: string): boolean {
  return TARGET_FUNCTION.test(title ?? "");
}

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

  // Early-career / training roles: an experienced hire is not a candidate,
  // and these arrive in bulk (e.g. a company's whole summer-internship set).
  if (EARLY_CAREER.test(t)) return { plausible: false, reason: "internship / early-career role" };

  for (const rx of IRRELEVANT) {
    if (rx.test(t)) return { plausible: false, reason: "occupation outside verified evidence" };
  }

  // Everything that is not excluded passes -- a named relevant function or
  // an ambiguous generalist title. Candidacy makes the real call.
  return { plausible: true, reason: RELEVANT.test(t) ? "relevant function" : "ambiguous title, left for candidacy" };
}
