import { toConcept } from "../matching/concepts.ts";

/**
 * What KIND of thing a requirement is, decided from the text rather than
 * from the extractor's own label.
 *
 * The pilot's TRAIT fix handled personality words. This handles the wider
 * problem the first scoring pass exposed: 20 percent of unmatched hard
 * requirements were phrases like "technology proficiency", "professional
 * experience" and "written and verbal communication". Those are not
 * capabilities anyone can hold or lack, yet each cost the same 18 points
 * as a missing professional licence.
 *
 * Six classes, and they are scored very differently:
 *
 *   GATING_CREDENTIAL  a licence, board certification or qualifying exam.
 *                      Regulated, binary, and not something adjacent
 *                      experience can substitute for.
 *   EDUCATION          a degree requirement, generic or field-specific.
 *   SKILL              a nameable capability, tool or domain.
 *   TRAIT              a personal quality.
 *   CONSTRAINT         a condition of the job rather than the person.
 *   GENERIC            a phrase with no capability content at all.
 */

// 2: term-primary classification with sibling-aware contextual fallback,
// "master" no longer a bare degree keyword, field extraction in three
// word orders, constraints tested before education.
// 3: the extractor's own kind is consulted when no pattern matches, so a
//    trait or a logistical condition stops falling through to SKILL.
// 4: a TRAIT label no longer removes a demonstrable workplace competency
//    from Fit. The extractor labels "cross-functional collaboration" and
//    "stakeholder management" TRAIT alongside "creativity", and only the
//    first two are things a person is given responsibility for.
export const TAXONOMY_VERSION = 4;

/**
 * What the extractor said this requirement was.
 *
 * Mirrors job_requirements.kind. Null when the caller has no kind to
 * offer, which reproduces the version 2 behaviour exactly.
 */
export type ExtractedKind =
  | "SKILL" | "TOOL" | "DOMAIN" | "EXPERIENCE_YEARS" | "EDUCATION"
  | "CREDENTIAL" | "TRAIT" | "LOGISTICAL" | "LEGAL" | "OTHER" | "RESPONSIBILITY" | null;

/**
 * What an unmatched requirement of each kind actually is.
 *
 * The default for everything used to be SKILL, and that default was the
 * entire defect. Measured over all 24,525 requirements: 2,391 of 4,613
 * TRAIT requirements and 587 of 1,387 LOGISTICAL ones were being scored
 * as missing professional capabilities, and 100% of them arrived there
 * through the fallback rather than through any positive text match. So
 * "coachability", "fast-paced team environment", "reach and extend arms
 * overhead" and "california residency" each cost the same as a missing
 * licence.
 *
 * Two rules bound this map, and both matter:
 *
 * It may only REMOVE a requirement from Fit. A kind may resolve to
 * TRAIT, CONSTRAINT or GENERIC and never to SKILL, EDUCATION or
 * GATING_CREDENTIAL. This is the same doctrine the contextual fallback
 * already follows: the extractor's label is a hint, and a hint may not
 * manufacture a match or a gate.
 *
 * It applies ONLY where no pattern matched. A term the classifier
 * positively recognises keeps its class whatever the extractor called
 * it, because the text is the better evidence when it speaks.
 *
 * LEGAL is deliberately absent. Its unmatched cases are genuinely mixed
 * -- "hipaa compliance" beside "medicare active status" -- and guessing
 * one way would either lose a real domain skill or keep scoring a
 * personal status as a capability. It stays SKILL until someone decides
 * it case by case.
 */
/**
 * Scopes that make an activity a shared responsibility rather than a
 * personal style: work done ACROSS something.
 */
const ACROSS = "cross[- ]?functional|cross[- ]?department\\w*|cross[- ]?team|interdepartmental|inter[- ]?team|multi[- ]?disciplinary";

/**
 * Things a person is given responsibility for, and can therefore be
 * asked to evidence.
 *
 * Deliberately a NAMED list of workplace functions, not a heuristic. The
 * extractor labels TRAIT generously: "cross-functional collaboration"
 * (78 occurrences), "stakeholder management" (12) and "systems thinking"
 * (16) arrive with the same label as "creativity" (97) and
 * "self-motivation" (110). The first three describe work someone was
 * accountable for; the last two describe what someone is like.
 *
 * The test each entry has to pass: could a person point at prior work
 * and say "this is where I did that"? Coordinating across departments,
 * managing stakeholders, running a project, mentoring someone -- yes.
 * Being creative or self-motivated -- no, and a resume claiming so is
 * making an assertion about character that no evidence grounds.
 */
const COMPETENCY: RegExp[] = [
  // Collaboration, coordination or communication ACROSS teams, in either
  // word order.
  new RegExp(`\\b(?:${ACROSS})\\b[\\w\\s-]*\\b(?:collaborat\\w*|coordinat\\w*|communicat\\w*|partner\\w*|work\\w*|alignment|engagement|influence|relationship\\w*)`, "i"),
  new RegExp(`\\b(?:collaborat\\w*|coordinat\\w*|communicat\\w*|partner\\w*|alignment|engagement)\\b[\\w\\s-]*\\b(?:${ACROSS})\\b`, "i"),
  // Stakeholder work, in either word order.
  /\bstakeholder\b[\w\s-]*\b(?:manage\w*|engag\w*|communicat\w*|coordinat\w*|influenc\w*|align\w*|relationship\w*|partner\w*)/i,
  /\b(?:manage\w*|engag\w*|communicat\w*|coordinat\w*|influenc\w*|align\w*)\b[\w\s-]*\bstakeholder/i,
  /\bsystems thinking\b/i,
  // Running a project or programme, in either word order.
  /\b(?:project|program|portfolio|roadmap)\b[\w\s-]*\b(?:manage\w*|coordinat\w*|leader\w*|ownership|delivery|execution|planning)\b/i,
  /\b(?:manage\w*|coordinat\w*|leader\w*|ownership|delivery|execution|planning)\b[\w\s-]*\b(?:project|program|portfolio|roadmap)s?\b/i,
  // Developing other people. Narrow on purpose: "coaching" alone catches
  // "coachability", which is the opposite of a responsibility.
  /\b(?:mentor\w*|mentorship)\b/i,
  // Managing a process, a vendor or a change.
  /\b(?:change|vendor|supplier|process|workflow|operations?)\b[\w\s-]*\b(?:manage\w*|improve\w*|design\w*|optimiz\w*|coordinat\w*)\b/i,
];

/**
 * An inclination, appetite or comfort, which stays a trait however many
 * competency words trail after it.
 *
 * Without this, "coachability" matches the mentoring pattern and "rapid
 * onboarding ability" matches an onboarding one. Both describe how a
 * person takes to something, not something they did.
 */
const DISPOSITION = /\b(?:coachab\w*|onboard\w*|orientation|comfort\w*|willing\w*|aptitude|mindset|passion\w*|enthusias\w*|curiosity|agility|tolerance|motivat\w*|positivity|attitude|culture[- ]fit|eager\w*|desire|interest in)\b/i;

/**
 * Whether a TRAIT-labelled requirement names work rather than character.
 *
 * Exported so the boundary can be tested directly and argued with.
 */
export function isDemonstrableCompetency(term: string): boolean {
  if (!term.trim()) return false;
  if (DISPOSITION.test(term)) return false;
  return COMPETENCY.some((re) => re.test(term));
}

const FALLBACK_BY_KIND: Partial<Record<NonNullable<ExtractedKind>, RequirementClass>> = {
  // A personal quality. Descriptive, not a capability anyone holds or lacks.
  TRAIT: "TRAIT",
  // A condition of the job rather than the person, and one eligibility has
  // already ruled on. Counting it again as an absent capability charges
  // the same fact twice.
  LOGISTICAL: "CONSTRAINT",
  // A duty the role performs ("own the roadmap", "manage cross-functional
  // projects"). What someone DID -- not a qualification it gates on. Scored
  // as its own class so Fit can credit a duty that maps to a verified
  // capability as POSITIVE evidence while NEVER letting an unmapped duty
  // become an unmet requirement (see fit.ts). Text classification still
  // wins first, so a responsibility whose term IS a nameable skill is
  // classified SKILL on the term.
  RESPONSIBILITY: "RESPONSIBILITY",
};

/**
 * Credential families.
 *
 * A posting demanding "RN compact license", "nurse practitioner license",
 * "board certification", "USMLE" and "family medicine residency" is
 * stating ONE fact five times: this job needs a clinician. Counting each
 * separately made Fit scale with how thoroughly a posting enumerated its
 * licensing, which is posting length wearing a different hat. Families
 * collapse them back to the single fact.
 */
export type CredentialFamily = "CLINICAL" | "LEGAL" | "FINANCE" | "ENGINEERING" | "OTHER";

const CREDENTIAL_FAMILIES: Array<[CredentialFamily, RegExp]> = [
  // Board certifications are clinical whatever specialty they name. The
  // first version matched "board certif" only as a bare phrase, so
  // "board certification in obesity medicine" and "ABMS or AOA board
  // certification" fell through to OTHER, which made OTHER look like a
  // catch-all when it was really a gap.
  ["CLINICAL", /\b(rn|nurse|aprn|lpn|fnp|np license|physician|medical|usmle|comlex|nclex|dea|acls|bls|pals|pharmacist|pharmd|clinical|lcsw|lpc|psychologist|residency|fellowship)\b/i],
  ["CLINICAL", /\bboard[- ]certif\w*/i],
  // The degree abbreviations, added when term-primary classification
  // started passing "md or do degree" rather than the sentence containing
  // the word "Medical". Without these the requirement landed in OTHER,
  // which is UNDECLARED and must never behave like a catch-all absence.
  ["CLINICAL", /\b(?:md or do|md\/do|md degree|do degree|doctor of osteopathic|osteopathic medicine)\b/i],
  ["CLINICAL", /\b(abms|aoa)\b/i],
  ["LEGAL", /\b(bar admission|admitted to the bar|licensed attorney)\b/i],
  ["FINANCE", /\b(cpa|certified public accountant|series 7|series 63|series 65|finra|insurance license|cfa|cfp)\b/i],
  ["ENGINEERING", /\b(pe license|professional engineer)\b/i],
];

export function credentialFamily(text: string): CredentialFamily {
  for (const [f, re] of CREDENTIAL_FAMILIES) if (re.test(text)) return f;
  return "OTHER";
}

export type RequirementClass =
  | "GATING_CREDENTIAL" | "EDUCATION" | "SKILL" | "TRAIT" | "CONSTRAINT" | "GENERIC" | "RESPONSIBILITY";

/**
 * Regulated credentials. Deliberately a NAMED list, not a keyword like
 * "license", because "driver's license" and "licensed to operate a forklift"
 * are logistical, and "software licensing experience" is a skill.
 *
 * These are the ones where adjacent experience genuinely cannot
 * substitute: you either hold the credential or you do not.
 */
const GATING_CREDENTIAL = new RegExp("\\b(?:" + [
  // clinical
  "rn license", "rn compact", "compact license", "registered nurse",
  "nurse practitioner", "\\bnp license", "\\bfnp\\b", "\\baprn\\b", "\\blpn\\b",
  "physician assistant", "\\bpa-c\\b", "medical license", "medical doctor",
  "board certification", "board certified", "usmle", "comlex", "nclex",
  "md or do", "md degree", "do degree", "doctor of osteopathic",
  "dea registration", "acls", "\\bbls\\b", "pals certification",
  "pharmacist license", "pharmd", "licensed clinical", "\\blcsw\\b", "\\blpc\\b",
  "psychologist license", "residency in", "fellowship in", "medical residency",
  // other regulated professions
  "bar admission", "admitted to the bar", "licensed attorney",
  "\\bcpa\\b", "certified public accountant", "\\bpe license", "professional engineer license",
  "series 7", "series 63", "series 65", "finra", "insurance license",
  "real estate license", "\\bcfa\\b", "\\bcfp\\b",
].join("|") + ")\\b", "i");

/**
 * Degree language.
 *
 * "master" is NOT a bare alternative here, and that is the point. It is
 * an ordinary English verb and noun, and as a bare keyword it classified
 * "eager to master the Linux shell", "master of organization" and "a
 * master understanding of corporate IT" as degree requirements. The
 * possessive and the "Master of <subject>" form are unambiguous; the
 * bare word is not.
 *
 * "diploma" and the high-school forms are included because a posting
 * asking for a high school diploma is stating an education requirement,
 * and leaving it out meant the phrase only ever classified correctly by
 * accident, via words belonging to a neighbouring clause.
 */
/**
 * Two-letter degree abbreviations need context to be degrees.
 *
 * "MS" is a master's in "BS, MS, or PhD in Computer Science" and a
 * product name in "advanced skills in Google Sheets and/or MS Excel".
 * Unguarded, the second became a master's-degree requirement the
 * candidate could never meet: a phantom unmet qualification produced by
 * a spreadsheet. A real degree abbreviation is followed by a list
 * separator, a conjunction, "in", "from", or the word "degree".
 */
const ABBR = "(?=\\s*(?:$|[,;.)\\/]|\\bor\\b|\\band\\b|\\bin\\b|\\bdegree\\b|\\bfrom\\b))";

const EDUCATION_REQ = new RegExp("\\b(?:" + [
  "bachelor'?s?", "ba\\b" + ABBR, "bs\\b" + ABBR, "bsc\\b" + ABBR, "b\\.s\\.", "b\\.a\\.",
  "master'?s", "master of (?:science|arts|business|engineering|public health|education|fine arts)",
  "ms\\b" + ABBR, "m\\.s\\.", "msc\\b" + ABBR, "mba", "m\\.b\\.a\\.",
  "doctoral", "doctorate", "phd", "ph\\.d\\.", "doctor of",
  "associate'?s? degree", "associates degree",
  "degree in",
  // "degree" alone is needed for "advanced degree" and "Welding
  // Engineering degree", but it is also ordinary English: "a high degree
  // of autonomy" is not an education requirement. Excluded where a
  // quantifier precedes it or "of" follows it.
  "(?<!\\b(?:high|higher|low|lower|great|greater|certain|some|varying|any|large|small|significant|considerable|reasonable)\\s)degree\\b(?!\\s+of\\b)",
  "four-year degree", "undergraduate degree", "graduate degree",
  "diploma", "high school", "ged\\b",
].join("|") + ")\\b", "i");

/** Degree-level words, checked separately so level and presence cannot disagree. */
const LEVEL_PATTERNS: Array<[string, RegExp]> = [
  // Professional doctorates are doctorates. "Juris Doctor" matched none
  // of these and fell through to the BACHELOR default, which let a
  // bachelor's degree satisfy "J.D. or graduate degree".
  ["DOCTORATE", /\b(?:phd|ph\.d\.|doctoral|doctorate|doctor of|juris doctor|j\.d\.|jd|m\.d\.|d\.o\.|pharm\.?d|dds|dmd|ed\.?d)\b/i],
  ["MASTER", new RegExp("\\b(?:master'?s|master of (?:science|arts|business|engineering|public health|education|fine arts)|mba|m\\.b\\.a\\.|ms\\b" + ABBR + "|m\\.s\\.|msc\\b" + ABBR + "|graduate degree|postgraduate degree|advanced degree)", "i")],
  // Bachelor's was previously only the fallback, so it could not appear
  // as one alternative among several. A requirement reading "BS, MS, or
  // PhD" is satisfied by the BS, and without this the lowest acceptable
  // level was invisible.
  ["BACHELOR", new RegExp("\\b(?:bachelor'?s|bachelors|b\\.s\\.|b\\.a\\.|bs\\b" + ABBR + "|ba\\b" + ABBR + "|undergraduate degree|(?:4|four)[- ]year degree)", "i")],
  ["ASSOCIATE", /\b(?:associate'?s? degree|associates degree)\b/i],
  ["HIGH_SCHOOL", /\b(?:high school|diploma|ged)\b/i],
];

/** Lowest first, because a list of acceptable degrees is satisfied by its lowest. */
const LEVEL_RANK: Record<string, number> = {
  HIGH_SCHOOL: 0, ASSOCIATE: 1, BACHELOR: 2, MASTER: 3, DOCTORATE: 4,
};

/**
 * Phrases with no capability content. Matched against the WHOLE concept,
 * so "communication" alone is generic while "technical communication with
 * enterprise IT teams" is not.
 */
const PURE_GENERIC = new Set([
  "professional experience", "relevant experience", "prior experience", "work experience",
  "industry experience", "technology proficiency", "technical proficiency",
  "written and verbal communication", "verbal and written communication",
  "written communication", "verbal communication", "oral communication",
  "communication", "communications", "communication skills",
  "interpersonal", "interpersonal communication",
  "problem solving", "problem-solving", "critical thinking", "analytical thinking",
  "strategic thinking", "strategic mindset", "analytical skills", "analytical",
  "problem-solving skills", "conceptual thinking", "creative thinking",
  "attention to detail", "detail orientation", "time management", "organization",
  "organizational", "multitasking", "prioritization", "adaptability", "flexibility",
  "collaboration", "teamwork", "team player", "self-starter", "self starter",
  "work ethic", "professionalism", "reliability", "accountability", "ownership",
  "curiosity", "growth mindset", "positive attitude", "passion", "motivation",
  "leadership", "leadership skills", "presentation skills", "presentation",
  "business acumen", "technical acumen", "customer focus", "customer service",
  "results driven", "results-oriented", "data driven", "data-driven",
]);

/**
 * Generic by SHAPE rather than by exact string.
 *
 * "Communication" is a trait whatever adjective precedes it: technical
 * communication, executive communication, stakeholder communication and
 * written communication are all the same non-capability. Enumerating
 * every adjective would be endless, so the head noun decides.
 */
const GENERIC_BY_SHAPE: RegExp[] = [
  /^(?:\w+\s+){0,2}communications?$/i,
  /^(?:\w+\s+){0,2}(?:collaboration|teamwork|professionalism|adaptability|flexibility)$/i,
  /^(?:emotional intelligence|executive presence|business sense|common sense|soft skills)$/i,
  // "strategic thinking", "growth mindset": a disposition, not a nameable
  // capability. Kept to the soft-trait adjectives on purpose so a
  // recognised competency ("systems thinking") and a real method ("design
  // thinking") are NOT swallowed.
  /^(?:strategic|analytical|critical|creative|conceptual|logical|abstract|big[- ]?picture|holistic|independent)\s+thinking$/i,
  /^(?:growth|entrepreneurial|ownership|abundance|beginner'?s?|founder'?s?|owner'?s?)\s+mindset$/i,
  /^technolog(?:y|ies)$/i,
  /^(?:general|broad|strong|solid)$/i,
];

/** Personal qualities that are not in the pure-generic list but still traits. */
const TRAIT_MARKER =
  /\b(mindset|attitude|passionate|passion for|self-motivat|self-direct|self-start|entrepreneurial|resilien|empathy|humility|integrity|judgment|judgement|thrives?|comfortable with ambiguity|bias for action|sense of urgency|results[- ]driven|results[- ]oriented|detail[- ]oriented|proactiv)\b/i;

/**
 * "Translating strategy into execution" and its kin. A description of a
 * way of working, not a nameable capability with evidence behind it, so
 * it can contribute as a trait but never stand as a role-defining gap.
 */
const SOFT_COMPETENCY_PHRASE =
  /\btranslat\w*\s+(?:strategy|vision|goals?|ideas?|concepts?|insights?)\s+(?:in)?to\s+(?:execution|action|results|reality|practice|outcomes?)\b/i;

const CONSTRAINT_MARKER =
  // "residency restriction" and "residing" are here rather than left to
  // the credential list on purpose: a posting excluding certain states is
  // stating where you may live, not asking for a medical residency. The
  // credential test runs first and matches only "residency in" and
  // "medical residency", so the two cannot collide.
  /\b(travel|shift|schedule|weekend|overtime|on-?call|time zone|lift|stand for|walk|physically|pounds|lbs|authorized to work|work authorization|sponsor|visa|clearance|must reside|must live|based in|relocate|residency restriction|residing|excluded states|driver'?s license|valid driver)\b/i;

export interface ClassifiedRequirement {
  concept: string;
  credentialFamily: CredentialFamily | null;
  requirementClass: RequirementClass;
  /** For EDUCATION: the field named, if any. */
  educationField: string | null;
  /** For EDUCATION: the level named. */
  educationLevel: "HIGH_SCHOOL" | "ASSOCIATE" | "BACHELOR" | "MASTER" | "DOCTORATE" | null;
  reason: string;
  /** Which text decided the class. Reported so the choice is auditable. */
  /** TERM and CONTEXT come from the text; KIND from the extractor's label. */
  evidence: "TERM" | "CONTEXT" | "KIND";
}

/**
 * Extracts the field of study, in the three word orders postings actually
 * use. Previously only the first was recognised, so "Bachelor of Science
 * in Nursing" and "Welding Engineering degree" both extracted no field
 * and became generic degree requirements that any bachelor's satisfies.
 */
const FIELD_PATTERNS: RegExp[] = [
  // degree in X / education in X / BS in X
  /\b(?:degree|education|major|study|studies)\s+in\s+(?:a\s+|an\s+)?([a-z][\w\s,\/&-]{2,60})/i,
  // Bachelor of Science in X
  /\b(?:bachelor|master|doctor)\s+of\s+(?:science|arts|business|engineering|fine arts)\s+in\s+(?:a\s+|an\s+)?([a-z][\w\s,\/&-]{2,60})/i,
  // BS/MS/PhD in X
  /\b(?:bs|ba|bsc|ms|msc|mba|phd|ph\.d\.)\s+in\s+(?:a\s+|an\s+)?([a-z][\w\s,\/&-]{2,60})/i,
  // X degree  (the reversed form: "Welding Engineering degree")
  /^([a-z][\w\s,\/&-]{2,60}?)\s+(?:field\s+)?degree\b/i,
];

/**
 * A capture made only of degree words is not a field. The reversed
 * pattern reads "MBA or advanced degree in Supply Chain" and captures
 * "mba or advanced", which would shadow the real field named after it.
 */
const DEGREE_WORDS_ONLY =
  /^(?:(?:advanced|undergraduate|graduate|post-?graduate|higher|technical|bachelor'?s?|master'?s?|associate'?s?|doctoral|doctorate|ba|bs|bsc|ms|msc|mba|phd|ph\.d\.|md|four-year)\b[\s,\/]*(?:or|and|,|\/)?[\s,\/]*)+$/i;

/** "a relevant field" and friends name no field at all. */
const VAGUE_FIELD =
  /^(?:a\s+|an\s+)?(?:relevant|related|similar|comparable|applicable|any|other|equivalent|appropriate|technical|advanced|undergraduate|graduate|college|university|higher)$/i;

/**
 * Examples are not requirements. "Advanced degree (e.g., MBA, MHA, MS in
 * Operations Research or Analytics)" asks for an advanced degree and then
 * illustrates it; reading a field out of the illustration turns a generic
 * requirement into a field-specific failure, which is the opposite of
 * what the posting says.
 */
const EXAMPLE_PARENTHETICAL = /\((?:\s*(?:e\.?g\.?|i\.?e\.?|such as|including|examples?:)[^)]*)\)/gi;

function educationField(text: string): string | null {
  const cleaned = text.replace(EXAMPLE_PARENTHETICAL, " ");
  for (const re of FIELD_PATTERNS) {
    const m = cleaned.match(re);
    if (!m?.[1]) continue;
    let field = m[1]
      .replace(/\b(field|discipline|area|subject)\b.*$/i, "")
      .replace(/\b(bachelor'?s?|master'?s?|associate'?s?|degree|ba|bs|bsc|ms|msc|mba|phd)\b\s*$/i, "")
      .replace(/\s*[,;]\s*$/, "")
      .replace(/^(?:a|an|the)\s+/i, "")
      .trim();
    if (!field || field.length < 3) continue;
    if (VAGUE_FIELD.test(field)) continue;
    if (DEGREE_WORDS_ONLY.test(field)) continue;
    return field;
  }
  return null;
}

/**
 * The level a requirement actually demands.
 *
 * A requirement naming several degrees is naming ALTERNATIVES, so the
 * level it demands is the lowest of them: "BS, MS, or PhD in Computer
 * Science" asks for a bachelor's, and reading it as a doctorate invents
 * a barrier the posting did not set. Taking the first pattern to match
 * made the answer depend on the order of the list above rather than on
 * what the posting said.
 */
function educationLevel(text: string): ClassifiedRequirement["educationLevel"] {
  const matched = LEVEL_PATTERNS.filter(([, re]) => re.test(text)).map(([level]) => level);
  if (matched.length === 0) return "BACHELOR";
  return matched.reduce((lowest, l) => (LEVEL_RANK[l]! < LEVEL_RANK[lowest]! ? l : lowest)) as any;
}

/**
 * Classifies one piece of text in isolation. Returns null when the text
 * carries no class-deciding signal, so the caller can decide whether it
 * is entitled to look somewhere else.
 */
function classifyText(text: string, concept: string): Omit<ClassifiedRequirement, "evidence"> | null {
  if (GATING_CREDENTIAL.test(text)) {
    return { concept, credentialFamily: credentialFamily(text), requirementClass: "GATING_CREDENTIAL",
             educationField: null, educationLevel: null,
             reason: "names a regulated licence, board certification or qualifying exam" };
  }
  // Constraints are tested before education on purpose. A requirement
  // whose own words say "willingness to travel" is a condition of the
  // job, and no amount of degree language elsewhere changes that.
  if (CONSTRAINT_MARKER.test(text)) {
    return { concept, credentialFamily: null, requirementClass: "CONSTRAINT",
             educationField: null, educationLevel: null,
             reason: "a condition of the job rather than a capability" };
  }
  if (EDUCATION_REQ.test(text)) {
    const field = educationField(text);
    return { concept, credentialFamily: null, requirementClass: "EDUCATION",
             educationField: field, educationLevel: educationLevel(text),
             reason: field ? `degree requirement in ${field}` : "generic degree requirement" };
  }
  if (PURE_GENERIC.has(concept) || GENERIC_BY_SHAPE.some((re) => re.test(concept))) {
    return { concept, credentialFamily: null, requirementClass: "GENERIC",
             educationField: null, educationLevel: null,
             reason: "phrase carries no capability content" };
  }
  if (TRAIT_MARKER.test(text) || SOFT_COMPETENCY_PHRASE.test(text)) {
    return { concept, credentialFamily: null, requirementClass: "TRAIT",
             educationField: null, educationLevel: null, reason: "a personal quality or way of working" };
  }
  return null;
}

/**
 * Decides what KIND of thing a requirement is.
 *
 * Term-primary, with a narrowly scoped contextual fallback.
 *
 * The extractor pulls several requirements out of one sentence, and it
 * gives each of them the SAME raw_text: the whole sentence. Classifying
 * against term-plus-raw_text therefore let any requirement be classified
 * by words that belong to one of its siblings. "Bachelor's degree and
 * willingness to travel" yields two requirements, and the travel one was
 * classified EDUCATION, then satisfied by a verified bachelor's, and
 * counted as a DIRECT match. A travel requirement scored as a
 * qualification he holds.
 *
 * So the normalized term decides. It is the extractor's own statement of
 * what this requirement is, and it belongs to this requirement alone.
 *
 * raw_text is consulted only when BOTH are true:
 *   - the term carries no class-deciding signal at all, and
 *   - the sentence produced no other requirement, so there is no sibling
 *     whose words could be mistaken for this one's.
 *
 * That keeps the legitimate case working. "High school diploma or
 * equivalent (Associate's or Bachelor's degree is a plus)" is a single
 * requirement whose context is genuinely its own.
 *
 * @param siblingTerms normalized terms of OTHER requirements extracted
 *   from the same raw_text. Non-empty means context is not trustworthy.
 */
export function classifyRequirement(
  rawText: string,
  normalizedTerm: string,
  siblingTerms: string[] = [],
  /** job_requirements.kind, when the caller has it. */
  extractedKind: ExtractedKind = null,
): ClassifiedRequirement {
  const concept = toConcept(normalizedTerm || rawText).concept;
  const term = normalizedTerm.trim();

  const contested = siblingTerms.some((t) => t.trim() && t.trim() !== term);

  if (term) {
    const fromTerm = classifyText(term, concept);
    if (fromTerm) {
      // The term decides the CLASS. Level and field are detail, and when
      // the term does not carry them the requirement's own sentence may,
      // under the same no-sibling condition that governs the class
      // fallback. "Advanced degree (e.g., MBA, MHA, MS)" is one
      // requirement whose level is stated only in its context.
      if (fromTerm.requirementClass === "EDUCATION" && !contested) {
        const context = `${term} ${rawText}`;
        if (fromTerm.educationField === null) fromTerm.educationField = educationField(context);
        if (fromTerm.educationLevel === "BACHELOR" && !LEVEL_PATTERNS.some(([, re]) => re.test(term))) {
          fromTerm.educationLevel = educationLevel(context);
        }
        fromTerm.reason = fromTerm.educationField
          ? `degree requirement in ${fromTerm.educationField}` : "generic degree requirement";
      }
      return { ...fromTerm, evidence: "TERM" };
    }
  }
  if (!contested) {
    const fromContext = classifyText(`${term} ${rawText}`, concept);
    // Context may never assign a GATE class.
    //
    // Measured on the live corpus: every one of the 25 requirements that
    // context promoted to EDUCATION was wrong. The terms were skills and
    // traits ("machine learning engineering experience", "construction
    // experience", "technical depth") and the degree language belonged to
    // an alternative the posting offered ("or a PhD in a relevant field")
    // or to a clause the extractor never emitted as its own requirement.
    // The sibling test cannot catch those, because under-extraction
    // leaves no sibling to detect.
    //
    // So context is allowed only to REMOVE a requirement from Fit, as a
    // constraint, trait or generic phrase. It can never resolve one in
    // his favour, which is the direction that manufactures a match.
    if (fromContext && fromContext.requirementClass !== "EDUCATION"
        && fromContext.requirementClass !== "GATING_CREDENTIAL") {
      return { ...fromContext, evidence: "CONTEXT",
               reason: `${fromContext.reason} (from the requirement's own sentence)` };
    }
  }

  // Nothing in the text decided it. The extractor's kind gets the last
  // word, and only in the direction that takes the requirement out of
  // Fit; see FALLBACK_BY_KIND.
  // A TRAIT label is overruled where the term names a workplace
  // responsibility. The extractor's boundary between "what someone is
  // like" and "what someone was accountable for" is loose in one
  // direction only, and this is the correction; see
  // isDemonstrableCompetency. LOGISTICAL is untouched.
  const overruled = extractedKind === "TRAIT" && isDemonstrableCompetency(term || concept);
  const byKind = extractedKind && !overruled ? FALLBACK_BY_KIND[extractedKind] : undefined;
  if (byKind) {
    return { concept, credentialFamily: null, requirementClass: byKind,
             educationField: null, educationLevel: null, evidence: "KIND",
             reason: byKind === "TRAIT"
               ? `a personal quality, which the extractor labelled ${extractedKind}`
               : byKind === "RESPONSIBILITY"
               ? "a duty the role performs; credited only where a verified capability supports it, never a gate"
               : `a condition of the job rather than the person, which the extractor labelled ${extractedKind}` };
  }

  return { concept, credentialFamily: null, requirementClass: "SKILL",
           educationField: null, educationLevel: null, evidence: "TERM",
           reason: "a nameable capability, tool or domain" };
}
