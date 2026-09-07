/**
 * Low-stakes recruiting / attribution / sourcing survey questions.
 *
 * "How did you hear about us?", "Where did you find this job?", "What
 * brought you to our careers page?" are mandatory on many forms and have
 * no bearing on qualifications, eligibility, legal status, compensation,
 * identity, background, work authorization, conflicts, demographics or
 * employment history. Blocking an otherwise valid application on one is
 * pure friction, so the engine may choose a reasonable generic answer.
 *
 * The permission is deliberately narrow. It is granted ONLY when the
 * wording is a recognised attribution/sourcing question AND matches none
 * of the substantive guards below. Anything touching work authorization,
 * legal attestations, background, prior employment, conflicts,
 * compensation, availability, education, experience, skills, management,
 * location/relocation, demographics/EEO, or a named referral falls
 * through to the real truth paths (VERIFIED / DERIVED / HUMAN_CONFIRMED)
 * or blocks. This is a category the engine learns, not a hard-coded
 * question.
 *
 * A low-stakes answer is never evidence about the person and never
 * modifies the truth profile.
 */

/** Attribution / sourcing wordings the fallback is allowed to answer. */
const SURVEY_PATTERNS: RegExp[] = [
  /\bhow (?:did|do|would) you (?:\w+\s+){0,3}(?:hear|learn|find|discover|come across)\b/i,
  /\bwhere (?:did|do|have) you (?:\w+\s+){0,3}(?:hear|learn|find|see)\b/i,
  /\bwhat brought you (?:to|here)\b/i,
  /\bhow (?:you|did you) heard? about\b/i,
  /\bhow did you find (?:this|out about|us)\b/i,
  /\bwhere did you (?:see|find|hear about) (?:this|the|our)\b/i,
  /\bhow were you (?:made aware|introduced)\b/i,
  /\breferral source\b|\bsourcing (?:channel|question)\b/i,
];

/**
 * If ANY of these match, the question is NOT low-stakes: a generic answer
 * could misrepresent something that affects hiring. Checked first.
 */
const SUBSTANTIVE_GUARD: RegExp[] = [
  /\bauthori[sz]ed?\b|\bwork authorization\b|\bright to work\b|\bsponsor\w*|\bvisa\b|\bh-?1b\b/i,
  /\bcitizen\w*|\bimmigration\b|\bnationalit\w*/i,
  /\bfelon\w*|\bconvict\w*|\bcriminal\b|\bbackground check\b|\bdrug (?:test|screen)/i,
  /\bpreviously (?:been )?employed\b|\bever (?:been )?employed\b|\bformer employee\b|\bworked (?:here|for us|for the company|for this)\b|\bre[- ]?hire\b|\bboomerang\b/i,
  /\bconflict of interest\b|\bgovernment\b|\bpublic official\b|\bnon[- ]?compete\b|\brestrictive covenant\b|\bconfidentialit\w*|\bnda\b/i,
  /\bsalary\b|\bcompensation\b|\bpay (?:rate|expectation)\b|\bdesired (?:pay|salary)\b|\bexpected (?:salary|pay|compensation)\b|\bwage\b/i,
  /\bstart date\b|\bavailab\w*|\bnotice period\b|\bwhen can you\b/i,
  /\beducation\b|\bdegree\b|\bgpa\b|\bschool\b|\buniversit\w*|\bcertif\w*|\blicens\w*|\bcredential\b|\bmajor\b/i,
  /\byears? of experience\b|\bhow many years\b|\bexperience (?:with|in|using)\b|\blevel of experience\b/i,
  /\bmanage(?:d|ment|r)?\b|\bsupervis\w*|\bdirect reports?\b|\bteam size\b|\bleadership\b/i,
  /\brelocat\w*|\bwilling to (?:relocate|travel)\b|\bcommut\w*|\bonsite\b|\bon-site\b|\bin[- ]?office\b|\bwhere (?:are you|do you) (?:located|based|live|reside)\b|\bcurrent (?:location|city)\b/i,
  /\bgender\b|\brace\b|\bethnic\w*|\bhispanic\b|\blatino\b|\bdisab\w*|\bveteran\b|\bpronoun\b|\bsexual orientation\b|\bmarital\b|\bage\b|\bdate of birth\b|\bdemographic\b|\bself[- ]?identif\w*|\beeo\b/i,
  /\breferred by\b|\breferrer\b|\bemployee referral\b|\bname of (?:the )?(?:person|employee|referrer|contact)\b|\bwho referred\b/i,
  /\bskill\b|\bqualif\w*|\bproficien\w*|\bcompetenc\w*/i,
];

export interface SurveyClassification { low: boolean; reason: string }

/**
 * `text` should carry the visible label and, if available, the field key,
 * because employers put the meaning in either one.
 */
export function classifyLowStakesSurvey(label: string, key?: string): SurveyClassification {
  const t = `${label ?? ""} ${key ?? ""}`.trim();
  if (!t) return { low: false, reason: "no question text" };
  const guard = SUBSTANTIVE_GUARD.find((r) => r.test(t));
  if (guard) return { low: false, reason: `substantive question (guarded); must use verified, derived, or human-confirmed truth or block` };
  const hit = SURVEY_PATTERNS.find((r) => r.test(t));
  if (hit) return { low: true, reason: `recruiting/attribution survey question with no bearing on qualifications, eligibility, legal status, compensation, or identity` };
  return { low: false, reason: "not a recognised low-stakes attribution/survey question" };
}

/** The neutral free-text answer. */
export const GENERIC_SURVEY_FREETEXT = "Company website";

/**
 * Preference order for option controls, from the user's rule. The truthful
 * middle tier (career platform / job board) is where this system's jobs
 * are actually discovered, so it is preferred over a bare "Other".
 */
const OPTION_PREFERENCE: RegExp[] = [
  /company\s*website/i,
  /company\s*careers?/i,
  /careers?\s*(?:page|site|website|web\s*site)/i,
  // The employer names its own site: "Northern Trust Web Site". A
  // generic web presence, not a specific channel.
  /\bweb\s*site\b|\bwebsite\b/i,
  /\binternet\b|\bonline\b/i,
  /web\s*search|search engine|\bgoogle\b/i,
  /career\s*platform|job\s*board|\blinkedin\b|\bindeed\b|\bglassdoor\b|\bbuiltin\b|\bziprecruiter\b/i,
  /company\s*(?:site|page)/i,
  /other\s*\/\s*not listed|not listed/i,
  /\bother\b|something\s*else|none\s*of\s*the\s*above/i,
];

export type OptionLike = { label?: string; value?: string } | string;

/**
 * Options that name a SPECIFIC channel this application did not come through.
 * Selecting one asserts a sourcing story that did not happen, so they are
 * removed before any preference match and are never a fallback -- even when
 * the label loosely contains a generic word. "Campus Career Site" contains
 * "career site" but is a campus-recruiting channel, not a generic careers
 * page, and picking it told an employer something untrue.
 */
const UNTRUTHFUL_SPECIFIC = /\bcampus\b|career\s*fair|job\s*fair|\bfair\b|conference|\bevent\b|meet\s*up|meetup|hackathon|webinar|\balumni\b|professor|\bfaculty\b|\bfriend\b|\bfamily\b|referr|recruiter\s*(?:reached|contact|reach|out)|\bagency\b|current\s*(?:employee|staff|colleague)|word\s*of\s*mouth|news\s*letter|newsletter|podcast|\bradio\b|\btv\b|billboard|\bmagazine\b/i;

export function pickSurveyOption(options: OptionLike[]): { value: string; reason: string } | null {
  const opts = (options ?? []).map((o) =>
    typeof o === "string" ? { label: o, value: o } : { label: o.label ?? o.value ?? "", value: o.value ?? o.label ?? "" });
  // Only options that could be answered truthfully. A specific channel that
  // did not happen is dropped, not preferred-around.
  const usable = opts.filter((o) => o.label.trim() && !UNTRUTHFUL_SPECIFIC.test(o.label));
  if (!usable.length) return null; // nothing truthful to say -> caller leaves it for review
  for (const pref of OPTION_PREFERENCE) {
    const m = usable.find((o) => pref.test(o.label));
    if (m) return { value: m.label, reason: `truthful generic sourcing option: "${m.label}"` };
  }
  // No generic option we can stand behind. Do NOT fall back to an arbitrary
  // option -- leaving it for a person is better than inventing a source.
  return null;
}
