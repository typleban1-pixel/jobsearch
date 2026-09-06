/**
 * Whether a job is worth applying to.
 *
 * Fit answers "how much of this posting does the evidence cover". That
 * is a number, and a number cannot tell a realistic stretch from a job
 * in the wrong occupation: Principal Engineer, Streaming Systems reached
 * 0.250 on genuine transferable concepts and is not an engineering
 * candidate. Candidacy reads the SHAPE of what is missing instead.
 *
 * Four things it is deliberately not:
 *
 *   not a Fit threshold      Fit is an input; no rule here compares it
 *                            to a cutoff.
 *   not a corpus ranking     being the best job in a weak corpus does
 *                            not make a job appropriate, so nothing here
 *                            reads rank or percentile.
 *   not a title blocklist    an operations role and a software role at
 *                            the same company are judged by their
 *                            requirements, not their names.
 *   not a duration model     years reasoning is informational and
 *                            deliberately absent; see docs/TECH_DEBT.md.
 */
import type { FitBreakdown, ScorableConcept } from "./fit.ts";

export const CANDIDACY_MODEL_VERSION = 6;

/**
 * What each model version decides, so a stored verdict can be read back.
 *
 *   3  the ladder below, with unresolved requirements excluded from the
 *      hard-requirement denominator entirely.
 *   4  identical to 3, plus one arm: an unresolved role-defining or
 *      occupational HARD requirement routes to MANUAL_REVIEW instead of
 *      letting the remaining known requirements stand in for it.
 *   5  identical to 4, plus an evidence-sufficiency guard: a would-be
 *      APPLICATION_CANDIDATE resting on fewer than three discriminating
 *      hard requirements routes to MANUAL_REVIEW (thin extraction must not
 *      manufacture autonomous confidence). Never affects REJECT/STRETCH.
 *   6  identical to 5, plus a zero-adjacency guard: a posting rich enough
 *      to judge whose discriminating requirements are affirmatively unmet
 *      with NO direct discriminating match and NO transferable adjacency
 *      anywhere becomes REJECT instead of a STRETCH resting on a bare
 *      baseline degree. Since STRETCH is an autonomous submission tier, a
 *      genuine occupational mismatch (an algorithmic trader, a specialist
 *      SWE) must not sit in it. Recall is preserved: unknown, missing
 *      extraction and ANY transferable foothold all keep a job out of this
 *      arm, and thin postings (< 3 discriminating requirements) can never
 *      reach it.
 *
 * Passing modelVersion: 3 reproduces model 3 exactly, which is how the
 * historical behavior stays executable rather than merely described.
 */
export const CANDIDACY_MODEL_VERSIONS = [3, 4, 5, 6] as const;

export type Verdict = "APPLICATION_CANDIDATE" | "STRETCH" | "REJECT" | "MANUAL_REVIEW";

export type ReasonCode =
  | "DISQUALIFYING_CREDENTIAL"
  | "UNKNOWN_GATING_CREDENTIAL"
  | "MULTIPLE_CORE_GAPS"
  | "CORE_GAP_WITHOUT_SUPPORT"
  | "NO_DIRECT_EVIDENCE"
  | "POSTING_NOT_ASSESSED"
  | "NO_DISCRIMINATING_REQUIREMENTS"
  | "OCCUPATIONAL_GAP"
  | "LOW_HARD_RATIO"
  | "MEETS_HARD_REQUIREMENTS"
  | "UNRESOLVED_ROLE_DEFINING_REQUIREMENT"
  | "NO_DIRECT_BUT_TRANSFERABLE"
  | "OCCUPATIONAL_ADJACENT_ONLY"
  | "ZERO_ADJACENCY_MISMATCH"
  | "INSUFFICIENT_EVIDENCE";

/**
 * What kind of demand a HARD requirement is.
 *
 * Measured, not assumed: counting HARD requirements as interchangeable
 * votes let a generic bachelor's degree stand in for four years of
 * logistics experience on Regional Implementation Manager, which reached
 * APPLICATION_CANDIDATE at 2/3. Of the jobs surviving that model, 56%
 * had their ratio lifted by a baseline requirement.
 */
export type Stratum = "GATING" | "BASELINE" | "OCCUPATIONAL" | "SUBSTANTIVE";

/** The extractor's own label, as job_requirements.kind stores it. */
export interface RequirementRow { id: string; kind: string | null; normalized_term: string | null; raw_text: string | null }

/**
 * Clauses naming the SETTING work happened in rather than the work.
 *
 * "2+ years in a fast-paced environment" states a workplace temperament,
 * not a body of experience, and treating it as occupational substance
 * cost the strongest job in the corpus its candidacy.
 */
const SETTING = /\b(?:in|at|within|for|inside)?\s*(?:a|an|the)?\s*(?:fast[- ]paced|high[- ]growth|hyper[- ]growth|fast[- ]changing|fast[- ]moving|rapidly changing|dynamic|ambiguous|matrixed|remote|hybrid|distributed|start[- ]?up|scale[- ]?up|agile|regulated|deadline[- ]driven|high[- ]volume|high[- ]pressure)\s*(?:work\s*)?(?:environment|setting|culture|company|organi[sz]ation|team|atmosphere|workplace|pace|context)s?\b/gi;

/** Grammar and the word "experience" itself, which name nothing. */
const FILLER = /\b(?:experience|years?|work(?:ing)?|professional|relevant|overall|environment|setting|culture|pace|in|at|a|an|the|and|or|of|with|combined)\b/gi;

/**
 * Undifferentiated experience: real, but naming no occupation.
 *
 * Kept separate from setting-only phrases because they are different
 * things. "5+ years of professional experience" is a duration demand
 * about a career; "2+ years in a fast-paced environment" is about
 * temperament. Neither is occupational substance, and conflating them
 * would hide the distinction if they ever diverge in treatment.
 */
const GENERAL_PROFESSIONAL = /^(?:general |overall |total |combined )?(?:work|professional|industry|relevant|full[- ]time)\s+experience$/i;

export type ExperienceObject = "OCCUPATIONAL" | "SETTING_ONLY" | "GENERAL_PROFESSIONAL";

/**
 * What an EXPERIENCE_YEARS or DOMAIN requirement is actually about.
 *
 * Operates on the OBJECT of the demand, not on whether a disposition
 * word appears anywhere in it. "5 years of project management in a
 * fast-paced environment" keeps its object; "2 years in a fast-paced
 * environment" has none once the setting is removed.
 *
 * The taxonomy-4 disposition veto was measured here and is not reused:
 * it fired on six requirements, all six false positives (it removes
 * "customer onboarding, implementation" for containing "onboard"), and
 * caught none of the sixteen setting phrases.
 */
export function experienceObject(term: string): ExperienceObject {
  const t = String(term ?? "").toLowerCase().trim();
  if (!t) return "GENERAL_PROFESSIONAL";
  if (GENERAL_PROFESSIONAL.test(t)) return "GENERAL_PROFESSIONAL";
  SETTING.lastIndex = 0;
  const residue = t.replace(SETTING, " ").replace(FILLER, " ").replace(/[^a-z0-9+#]+/g, " ").trim();
  return residue ? "OCCUPATIONAL" : "SETTING_ONLY";
}

/**
 * A requirement that names an intended junior LEVEL -- "early-career",
 * "recent graduate", "entry-level", "0-2 years" -- is a seniority/positioning
 * signal, not an occupational capability. Someone with MORE experience is not
 * missing a capability; at worst they are over-qualified, which is a
 * desirability/positioning concern, never an absent-skill REJECT. Such a
 * requirement is therefore excluded from the discriminating set and the
 * occupational-gap set (it is neither met nor absent as a capability).
 */
const JUNIOR_SENIORITY = /\b(early[- ]?career|recent grad(?:uate)?|new grad|entry[- ]?level|junior|intern(?:ship)?|0[- ]?(?:to[- ]?)?2 years?|1[- ]?2 years?|up to (?:two|2) years?)\b/i;
export function isJuniorSeniorityTarget(concept: string): boolean {
  return JUNIOR_SENIORITY.test(String(concept ?? ""));
}

export function stratumOf(c: ScorableConcept, reqById: Map<string, RequirementRow>): Stratum {
  if (c.requirementClass === "GATING_CREDENTIAL") return "GATING";
  // A degree requirement is a FLOOR only when it names no field.
  // "Bachelor's degree" is a box to tick; "bachelor degree in actuarial
  // science" discriminates and is the substance of the job, which is the
  // same distinction Fit's own isBaseline draws. Treating every
  // EDUCATION concept as baseline silently removed field-specific degree
  // requirements from the role-defining set on two corpus jobs.
  const isEducation = c.requirementClass === "EDUCATION"
    || (c.requirementIds ?? []).some((id) => reqById.get(id)?.kind === "EDUCATION");
  if (isEducation) return c.educationField ? "SUBSTANTIVE" : "BASELINE";
  const reqs = (c.requirementIds ?? []).map((id) => reqById.get(id)).filter(Boolean) as RequirementRow[];
  const occ = reqs.filter((r) => r.kind === "EXPERIENCE_YEARS" || r.kind === "DOMAIN");
  // One requirement naming real work is enough: a concept backed by both
  // "5 years of supply chain" and "in a fast-paced environment" is
  // occupational.
  if (occ.some((r) => experienceObject(String(r.normalized_term ?? r.raw_text ?? "")) === "OCCUPATIONAL")) return "OCCUPATIONAL";
  return "SUBSTANTIVE";
}

const STOP = new Set(["and","or","the","a","an","of","in","to","for","with","senior","staff","principal","lead","director",
  "manager","specialist","associate","analyst","coordinator","ii","iii","iv","sr","jr","experience","years","strong",
  "ability","skills","knowledge","i","new","team"]);
const tokens = (s: string) => new Set(String(s ?? "").toLowerCase().match(/[a-z0-9+#.-]+/g)
  ?.map((w) => w.replace(/^[.-]+|[.-]+$/g, "")).filter((w) => w.length > 2 && !STOP.has(w)) ?? []);

/**
 * A requirement the posting says the job IS.
 *
 * Unchanged from the validated model. Two signals, both from the
 * posting's own structure: the concept is named in the title, or the
 * posting states it in three or more separate requirements. It catches
 * what the stratification cannot -- Principal Engineer states everything
 * as SKILL-kind and has no occupational requirement at all, and is
 * rejected only by title anchoring.
 */
export function isCoreGap(c: ScorableConcept, title: string): boolean {
  if ((c.credit ?? 0) > 0 || c.isBaseline) return false;
  const t = tokens(title);
  return [...tokens(c.concept)].some((w) => t.has(w)) || (c.requirementIds?.length ?? 0) >= 3;
}

export interface CandidacyInput {
  jobTitle: string;
  normalizedTitle?: string | null;
  fit: FitBreakdown;
  requirements: RequirementRow[];
  /** family -> HELD | NOT_HELD | UNDECLARED. Absent families are UNKNOWN. */
  credentialDeclarations: Record<string, string>;
  /** Defaults to the current model. 3 reproduces the frozen behavior. */
  modelVersion?: number;
}

export interface CandidacyResult {
  verdict: Verdict;
  reasonCodes: ReasonCode[];
  reason: string;
  hardMet: number;
  hardTotal: number;
  directMatches: number;
  transferableMatches: number;
  occupational: Array<{ concept: string; resolution: string; met: boolean }>;
  coreGaps: string[];
  gatingGaps: string[];
  unknownGates: string[];
  /**
   * Role-defining or occupational HARD requirements left unresolved.
   * Always computed; only acted on from model 4.
   */
  unresolvedCore: string[];
  baselineMet: number;
  modelVersion: number;
}

export function assessCandidacy(input: CandidacyInput): CandidacyResult {
  const model = input.modelVersion ?? CANDIDACY_MODEL_VERSION;
  const reqById = new Map(input.requirements.map((r) => [r.id, r]));
  const concepts = input.fit.concepts as ScorableConcept[];
  const scored = concepts.filter((c) => c.weight > 0 && c.credit !== null);
  const title = `${input.jobTitle} ${input.normalizedTitle ?? ""}`;

  const directMatches = scored.filter((c) => c.resolution === "DIRECT").length;
  const transferableMatches = scored.filter((c) => c.resolution === "TRANSFERABLE").length;
  const hardAll = scored.filter((c) => c.hardness === "HARD");
  const strata = new Map(hardAll.map((c) => [c, stratumOf(c, reqById)]));

  // A baseline requirement neither helps nor hurts: a degree he holds
  // says nothing about whether he can do the job.
  // Junior-seniority targets are positioning, not capability: out of the set.
  const ratioSet = hardAll.filter((c) => strata.get(c) !== "BASELINE" && !c.isBaseline && !isJuniorSeniorityTarget(c.concept));
  const overqualifiedFor = hardAll.filter((c) => isJuniorSeniorityTarget(c.concept)).map((c) => c.concept);
  const hardMet = ratioSet.filter((c) => (c.credit ?? 0) > 0).length;
  const hardTotal = ratioSet.length;
  const baselineMet = hardAll.filter((c) => strata.get(c) === "BASELINE" && (c.credit ?? 0) > 0).length;

  const occConcepts = hardAll.filter((c) => strata.get(c) === "OCCUPATIONAL" && !isJuniorSeniorityTarget(c.concept));
  const occupational = occConcepts.map((c) => ({ concept: c.concept, resolution: c.resolution, met: (c.credit ?? 0) > 0 }));
  const occAbsent = occConcepts.filter((c) => (c.credit ?? 0) === 0);
  const coreGaps = ratioSet.filter((c) => isCoreGap(c, title)).map((c) => c.concept);

  // A declared NOT_HELD credential. Nothing adjacent substitutes.
  const gatingGaps = scored.filter((c) => c.requirementClass === "GATING_CREDENTIAL" && (c.credit ?? 0) === 0
    && c.credentialFamily && input.credentialDeclarations[c.credentialFamily] === "NOT_HELD").map((c) => c.concept);
  // UNKNOWN stays UNKNOWN. An undeclared family is a question for a
  // person, and inferring absence from silence is the failure this
  // whole profile is built to avoid.
  const unknownGates = concepts.filter((c) => c.credit === null && c.requirementClass === "GATING_CREDENTIAL").map((c) => c.concept);

  // Unknown evidence must not improve candidacy by disappearing.
  //
  // `scored` drops every concept whose credit is null, which is right:
  // an unresolved requirement is not a failed one and must not be
  // counted against him. But it also leaves the DENOMINATOR, and that is
  // only harmless while unresolved requirements are incidental.
  //
  // They are not any more. The evidence layer can now resolve a central
  // requirement to UNKNOWN on purpose, and SpotHero showed what that
  // does: "3+ years of legal operations experience or 5+ years of
  // operations experience" resolved UNKNOWN, left the denominator, and
  // the hard ratio became 1/1. The model then reported that he meets the
  // hard requirements of a job whose defining requirement it had not
  // established at all.
  //
  // The answer is not to give it credit, and not to score it as zero.
  // Both would assert something the evidence does not say. Material
  // uncertainty about the substance of the role is a question for a
  // person, which is what MANUAL_REVIEW means, and it is the same
  // judgement already made for an unresolved gating credential.
  //
  // Scope is deliberately narrow: HARD, not baseline, not a credential
  // gate (arm 3 owns those), and either role-defining by the same test
  // coreGaps uses or occupational by stratum. An unresolved PREFERRED
  // requirement, or an unresolved incidental one, changes nothing.
  const unresolvedCore = concepts.filter((c) =>
    c.weight > 0
    && c.credit === null
    && c.hardness === "HARD"
    && !c.isBaseline
    && c.requirementClass !== "GATING_CREDENTIAL"
    && (isCoreGap(c, title) || stratumOf(c, reqById) === "OCCUPATIONAL")).map((c) => c.concept);

  const base = { hardMet, hardTotal, directMatches, transferableMatches, occupational, coreGaps,
    gatingGaps, unknownGates, unresolvedCore, baselineMet, modelVersion: model };

  // Model 4's single addition. Placed so that it can only ever replace a
  // STRETCH or an APPLICATION_CANDIDATE: every REJECT arm above still
  // fires first, and both MANUAL_REVIEW arms above are unchanged. The
  // new model is therefore conservative by construction, not by
  // observation.
  const unresolvedBlocks = model >= 4 && unresolvedCore.length > 0;
  const unresolvedOut = () => out("MANUAL_REVIEW", "UNRESOLVED_ROLE_DEFINING_REQUIREMENT",
    `the substance of the role is unresolved rather than met or missing: ${unresolvedCore.join(", ")}. `
    + "It is excluded from the hard-requirement ratio, so the remaining requirements would otherwise "
    + "stand in for it; a person has to answer it instead.");
  const out = (verdict: Verdict, code: ReasonCode, reason: string): CandidacyResult =>
    ({ ...base, verdict, reasonCodes: [code], reason });

  // Nothing to assess is not the same as assessed and found wanting.
  //
  // A posting whose requirements were never extracted arrives here with
  // an empty concept set: hardTotal 0, directMatches 0, no core gaps. It
  // then fell straight through to the directMatches === 0 arm and was
  // recorded as REJECT / NO_DIRECT_EVIDENCE, which reads as "we compared
  // this against the profile and it failed." We never compared it. On
  // the last full run that mislabeled 788 of 1,436 eligible jobs, every
  // one of them un-extracted.
  //
  // This does not lower any bar. It refuses to assert a judgment that
  // was never made, and routes the job to a person instead.
  if (concepts.length === 0) return out("MANUAL_REVIEW", "POSTING_NOT_ASSESSED",
    "the posting's requirements have not been extracted, so no comparison against the profile has happened");

  if (gatingGaps.length) return out("REJECT", "DISQUALIFYING_CREDENTIAL",
    `a required credential is declared NOT_HELD: ${gatingGaps.join(", ")}`);
  if (unknownGates.length) return out("MANUAL_REVIEW", "UNKNOWN_GATING_CREDENTIAL",
    `an unresolved gating credential a person must answer: ${unknownGates.join(", ")}`);
  if (coreGaps.length >= 2) return out("REJECT", "MULTIPLE_CORE_GAPS",
    `${coreGaps.length} role-defining requirements unmet: ${coreGaps.join(", ")}`);
  if (coreGaps.length === 1) {
    const supported = hardTotal > 0 && hardMet / hardTotal >= 0.5 && directMatches >= 2;
    if (!supported) return out("REJECT", "CORE_GAP_WITHOUT_SUPPORT",
      `role-defining gap (${coreGaps[0]}) with only ${hardMet}/${hardTotal} hard met and ${directMatches} direct match(es)`);
    // A gap AND an unresolved role-defining requirement is not a stretch
    // anyone can assess from here.
    if (unresolvedBlocks) return unresolvedOut();
    return out("STRETCH", "CORE_GAP_WITHOUT_SUPPORT",
      `one role-defining gap (${coreGaps[0]}) against ${hardMet}/${hardTotal} hard requirements met`);
  }
  // No discriminating hard requirement means there is nothing to reject
  // ON. A posting whose only extracted substance is a degree checkbox, a
  // responsibility, or a preferred nice-to-have arrives here with
  // hardTotal 0. That is a thin or incomplete posting, not a candidate
  // found wanting -- routing it to a confident REJECT would let sparse
  // extraction masquerade as a qualification gap, which is the exact
  // failure Part A forbids. It goes to a person instead. Checked BEFORE
  // the direct-evidence arm so a job with no denominator can never be
  // rejected for a ratio it does not have.
  // No discriminating hard requirement means there is usually nothing to
  // reject ON -- but "nothing to test" and "affirmative evidence of a
  // different occupation" are not the same posting, and must not share a
  // verdict.
  //
  //   THIN: a posting whose extraction produced too little to judge (a
  //   lone responsibility, a degree checkbox, a program blurb). Routed to
  //   a person, never rejected, because sparse extraction is not a
  //   qualification gap (Part A).
  //
  //   AFFIRMATIVE MISMATCH: a posting rich enough to judge (scorable),
  //   whose many stated concepts all resolve ABSENT with nothing
  //   credited -- ten unmet software-engineering concepts, say, that the
  //   extractor happened to label PREFERRED. That is "very low
  //   substantive capability overlap", which IS a REJECT. It falls
  //   through to the direct-evidence arm below.
  if (hardTotal === 0) {
    const credited = scored.filter((c) => (c.credit ?? 0) > 0).length;
    const absent = scored.filter((c) => (c.credit ?? 0) === 0).length;
    // Affirmative mismatch: the posting is rich enough to judge, states
    // several concepts, and the profile covers almost none of them with
    // no direct match anywhere. A couple of incidental transferable hits
    // among many absent concepts do not rescue it (a compliance software
    // role Ty cannot do); a lone adjacent concept with nothing absent is
    // thin, not a mismatch, and still goes to a person.
    const evaluable = credited + absent;
    const affirmativeMismatch = input.fit.scorable && directMatches === 0
      && absent >= 3 && evaluable > 0 && (credited / evaluable) < 0.34;
    if (!affirmativeMismatch) return out("MANUAL_REVIEW", "NO_DISCRIMINATING_REQUIREMENTS",
      "the posting states no hard requirement that discriminates, so there was nothing to test against");
  }

  // No DIRECT title/label match is a weak signal, not a verdict. For a broad
  // profile, verified TRANSFERABLE coverage of the substance, with NO defining
  // occupational gap and no role-defining gap, is a reasonable stretch a
  // recruiter could consider -- the "reasonable applicant" test -- so it
  // becomes STRETCH (which routes to review, never auto-submit), NOT a reject.
  // Without a transferable foothold, or with a real occupational/role-defining
  // gap, it stays REJECT: less evidence is never a route to surviving, and a
  // job whose DEFINING discipline he lacks (its occupational SKILL requirement
  // resolves ABSENT) still fails the occAbsent/coreGaps guards below and here.
  if (directMatches === 0) {
    // A reasonable applicant must also clear the SAME discriminating-
    // requirement bar a candidate does: meeting at least half the HARD
    // requirements. Without this, a role whose real substance he lacks (a
    // DevOps intern at 1/8, a data engineer at 1/7) slipped through on a
    // single incidental transferable match ("git", "project management")
    // and no OCCUPATIONAL-labelled gap. The ratio is what separates a
    // genuine adjacent stretch (Instawork product-ops at 1/1) from a
    // different occupation he simply cannot do.
    const reasonableApplicant = transferableMatches >= 1 && occAbsent.length === 0
      && coreGaps.length === 0 && hardTotal > 0 && !unresolvedBlocks
      && (hardMet / hardTotal) >= 0.5;
    if (!reasonableApplicant) return out("REJECT", "NO_DIRECT_EVIDENCE",
      `no direct evidence for anything the posting asks (${transferableMatches} transferable only)`);
    return out("STRETCH", "NO_DIRECT_BUT_TRANSFERABLE",
      `no direct-title match, but ${transferableMatches} transferable capability match(es) and no defining occupational gap`
      + (overqualifiedFor.length ? `; note: targets a more junior level (${overqualifiedFor.join(", ")})` : ""));
  }
  if (unresolvedBlocks) return unresolvedOut();

  // Zero-adjacency occupational mismatch (model >= 6). STRETCH is an
  // AUTONOMOUS submission tier, so it must not hold a role whose defining
  // substance is affirmatively absent with nothing to lean on. This fires
  // ONLY when the posting is rich enough to judge -- scorable, with at least
  // MIN_DISCRIMINATING discriminating hard requirements -- AND the profile
  // meets none of them (hardMet 0), has no DIRECT discriminating match
  // (a bare baseline degree does not count; hardDirectMet excludes baseline),
  // has no TRANSFERABLE adjacency anywhere, and several requirements resolve
  // affirmatively ABSENT rather than UNKNOWN. Recall is deliberately
  // preserved: an unknown requirement (already routed to MANUAL_REVIEW by the
  // unresolved-core arm above), a thin posting (< MIN_DISCRIMINATING), or any
  // single transferable foothold all keep a job OUT of this arm and in
  // STRETCH. Material uncertainty is a person's call, not a reject; only
  // affirmative, adjacency-free absence rejects here.
  const MIN_DISCRIMINATING = 3;
  const hardDirectMet = ratioSet.filter((c) => c.resolution === "DIRECT" && (c.credit ?? 0) > 0).length;
  const affirmativelyAbsent = ratioSet.filter((c) => c.resolution === "ABSENT").length;
  if (model >= 6 && input.fit.scorable && hardTotal >= MIN_DISCRIMINATING
      && hardMet === 0 && hardDirectMet === 0 && transferableMatches === 0
      && affirmativelyAbsent >= MIN_DISCRIMINATING) {
    return out("REJECT", "ZERO_ADJACENCY_MISMATCH",
      `the role's discriminating requirements are affirmatively unmet with no direct or transferable adjacency: `
      + `0/${hardTotal} hard requirements met, ${transferableMatches} transferable, `
      + `${affirmativelyAbsent} requirement(s) absent (${occAbsent.map((c) => c.concept).slice(0, 4).join(", ") || "no occupational overlap"})`);
  }

  if (occAbsent.length) return out("STRETCH", "OCCUPATIONAL_GAP",
    `the occupational substance is not established: ${occAbsent.map((c) => c.concept).join(", ")}`);

  // Occupational substance carried ONLY by adjacency is a stretch, not an
  // autonomous candidate.
  //
  // A composite ("product operations" from a product category and an
  // operations category) or a related-term match shows the work is
  // adjacent to the profile. That is real evidence and the right reason
  // to preserve a job for review -- it is not the direct establishment of
  // the discipline that an UNATTENDED application has to rest on. So when
  // every occupational concept is met only transferably, with no direct
  // occupational match anywhere, the job is STRETCH. This is the guard
  // that keeps recall expansion flowing to STRETCH rather than lowering
  // the APPLICATION_CANDIDATE bar; a job with no occupational concept at
  // all is unaffected and still judged on its hard ratio below.
  const occDirect = occConcepts.some((c) => c.resolution === "DIRECT" && (c.credit ?? 0) > 0);
  if (occConcepts.length > 0 && !occDirect)
    return out("STRETCH", "OCCUPATIONAL_ADJACENT_ONLY",
      "the occupational substance is adjacent (transferable) rather than directly established: "
      + occConcepts.map((c) => c.concept).join(", "));
  // Evidence sufficiency for autonomous confidence.
  //
  // A posting that states only one or two DISCRIMINATING hard requirements
  // has not given enough to be confident, however well that handful maps.
  // A capital-markets internship whose real substance (current-student
  // status, the finance discipline) never survived extraction reduced to
  // "Microsoft Word and Excel"; matching Excel made it 1/2 and a strong
  // candidate. Thin extraction must not manufacture confidence.
  //
  // Too-thin evidence is INSUFFICIENT, not disqualifying: it routes to
  // MANUAL_REVIEW (a person decides), never to REJECT. MANUAL_REVIEW is
  // the honest destination because, under the autonomous policy, both
  // APPLICATION_CANDIDATE and STRETCH are submission-eligible -- so a
  // stretch would auto-apply, and "we cannot confidently auto-apply on
  // this little" is exactly what MANUAL_REVIEW means. A genuine adjacent
  // STRETCH (reached through a gap or a low ratio below) is unaffected;
  // this guards only the would-be top of the ladder.
  const hardDirect = ratioSet.filter((c) => c.resolution === "DIRECT" && (c.credit ?? 0) > 0).length;
  // model >= 5 only: frozen model 3 and 4 read-back is unchanged.
  if (model >= 5 && hardMet / hardTotal >= 0.5 && hardTotal < MIN_DISCRIMINATING) {
    return out("MANUAL_REVIEW", "INSUFFICIENT_EVIDENCE",
      `meets ${hardMet}/${hardTotal} hard requirement(s), but the posting states too few discriminating `
      + `requirements (${hardTotal} < ${MIN_DISCRIMINATING}) to establish qualification confidently; a person decides `
      + "rather than an autonomous application resting on so little.");
  }

  return hardMet / hardTotal >= 0.5
    ? out("APPLICATION_CANDIDATE", "MEETS_HARD_REQUIREMENTS", `no role-defining or occupational gap; ${hardMet}/${hardTotal} hard requirements met (${hardDirect} direct)`)
    : out("STRETCH", "LOW_HARD_RATIO", `no role-defining or occupational gap, but only ${hardMet}/${hardTotal} hard requirements met`);
}

/** May a job in this state be prepared as an application? */
export const mayPrepare = (v: Verdict) => v === "APPLICATION_CANDIDATE" || v === "STRETCH";
