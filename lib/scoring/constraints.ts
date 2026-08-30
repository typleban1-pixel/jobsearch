/**
 * Deterministic constraint evaluation.
 *
 * LEGAL and LOGISTICAL requirements were deliberately left unresolved
 * through extraction, because resolving "must reside and be based in
 * California" from a regex over free text is exactly the guess the system
 * exists to avoid. They were preserved verbatim, waiting for a VERIFIED
 * profile attribute to compare against.
 *
 * Work authorization is the first such attribute. A posting saying it
 * will not sponsor visas is unambiguous, and against a confirmed US
 * citizen who needs no sponsorship it resolves to SATISFIED with no
 * inference at all. That is the whole intended pattern: a stated fact
 * compared to a verified fact, never a guess bridging the two.
 *
 * Everything else stays UNEVALUATED. Travel percentages, shift patterns,
 * lifting requirements and state residency have no verified attribute to
 * compare against yet, so they keep raising uncertainty rather than
 * quietly resolving in whichever direction is convenient.
 */

export type ConstraintCategory =
  | "SPONSORSHIP" | "WORK_AUTHORIZATION" | "US_RESIDENCY"
  | "RESIDENCY_SPECIFIC" | "TRAVEL" | "SCHEDULE" | "PHYSICAL"
  | "LICENSE" | "SECURITY_CLEARANCE" | "REGULATORY" | "OTHER";

export type ConstraintVerdict = "SATISFIED" | "VIOLATED" | "UNEVALUATED";

export interface ConstraintProfile {
  workAuthorization: string | null;
  requiresSponsorship: boolean | null;
  country: string | null;
}

const PATTERNS: Array<[ConstraintCategory, RegExp]> = [
  ["SPONSORSHIP", /\b(will not sponsor|unable to sponsor|does not sponsor|no sponsorship|without sponsorship|sponsorship is not|not provide sponsorship)\b/i],
  ["SPONSORSHIP", /\b(sponsor|sponsorship|visa|h-?1b|work permit)\b/i],
  ["WORK_AUTHORIZATION", /\b(authorized to work|work authorization|legally authorized|eligible to work|right to work)\b/i],
  ["US_RESIDENCY", /\b(residing|reside|resides|located|based)\s+(?:in|within)\s+the\s+(?:united states|u\.?s\.?a?\.?)\b/i],
  ["SECURITY_CLEARANCE", /\b(security clearance|ts\/sci|secret clearance|public trust|itar)\b/i],
  // Anything naming a SPECIFIC place stays unevaluated on purpose.
  ["RESIDENCY_SPECIFIC", /\b(must (?:reside|live|be based)|reside and be based|based in|located in|relocate to|must live)\b/i],
  ["TRAVEL", /\btravel\b/i],
  ["SCHEDULE", /\b(shift|schedule|weekend|overtime|on-?call|time zone|hours)\b/i],
  ["PHYSICAL", /\b(lift|stand|walk|physically|pounds|lbs)\b/i],
  ["LICENSE", /\b(licen[sc]e|licensed|certification|bar admission|registered)\b/i],
  ["REGULATORY", /\b(hipaa|gdpr|ccpa|sox|pci)\b/i],
];

export function categorize(rawText: string): ConstraintCategory {
  for (const [cat, re] of PATTERNS) if (re.test(rawText)) return cat;
  return "OTHER";
}

export function evaluateConstraint(
  rawText: string,
  profile: ConstraintProfile,
): { category: ConstraintCategory; verdict: ConstraintVerdict; detail: string } {
  const category = categorize(rawText);

  switch (category) {
    case "SPONSORSHIP": {
      if (profile.requiresSponsorship === null) {
        return { category, verdict: "UNEVALUATED", detail: "sponsorship need not confirmed on the profile" };
      }
      if (profile.requiresSponsorship === false) {
        return { category, verdict: "SATISFIED", detail: "candidate requires no sponsorship now or in the future" };
      }
      // The posting refuses to sponsor and the candidate needs it. Only a
      // clear refusal counts; a posting that merely mentions visas does not.
      const refuses = /\b(will not sponsor|unable to sponsor|does not sponsor|no sponsorship|without sponsorship|not provide sponsorship)\b/i.test(rawText);
      return refuses
        ? { category, verdict: "VIOLATED", detail: "posting states it will not sponsor and the candidate requires it" }
        : { category, verdict: "UNEVALUATED", detail: "posting mentions visas without stating a policy" };
    }
    case "WORK_AUTHORIZATION":
    case "US_RESIDENCY": {
      if (!profile.workAuthorization) {
        return { category, verdict: "UNEVALUATED", detail: "work authorization not confirmed on the profile" };
      }
      const usAuthorized = /citizen|permanent resident|green card/i.test(profile.workAuthorization)
        || (profile.country ?? "").toUpperCase() === "US";
      return usAuthorized
        ? { category, verdict: "SATISFIED", detail: `verified: ${profile.workAuthorization}` }
        : { category, verdict: "UNEVALUATED", detail: "authorization basis does not clearly establish US work eligibility" };
    }
    default:
      // No verified attribute exists to compare against. Stays unknown,
      // which is the honest answer and keeps raising uncertainty.
      return { category, verdict: "UNEVALUATED", detail: "no verified profile attribute to compare against yet" };
  }
}
