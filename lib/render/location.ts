/**
 * What the resume header says about where he is.
 *
 * The problem this solves: a Chicago employer reading "Cleveland, OH"
 * concludes the candidate is out of market, or that any relocation is
 * hypothetical. The verified fact is stronger than that — the move is
 * planned and not contingent on an offer — and saying so is the
 * difference between an out-of-market application and a local one.
 *
 * The line it produces is a fact, not a pitch:
 *
 *     Cleveland, OH · Relocating to Chicago, IL
 *
 * Four things it will not do. It never prints Chicago as the current
 * residence before the move; it never softens a definite relocation to
 * "open to relocation", which is a weaker and different claim; it never
 * states or implies a date, because none is known; and it never suggests
 * relocation assistance is required, because it is not.
 *
 * Whether the line appears at all depends on the posting. A remote role
 * gains nothing from it, so it is omitted rather than added everywhere.
 */

export const LOCATION_VERSION = 1;

export interface ResidenceFacts {
  city: string | null;
  state: string | null;
  /** Where he is moving to, if anywhere. */
  destinationCity?: string | null;
  destinationState?: string | null;
  destinationMetro?: string | null;
  /** Planned and not contingent on an offer. */
  relocationIsDefinite?: boolean | null;
  /** Null means unknown. Nothing may infer one. */
  relocationDate?: string | null;
}

export interface JobGeography {
  /** Where the posting is, as the posting states it. */
  city?: string | null;
  state?: string | null;
  metro?: string | null;
  isRemote?: boolean;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Does this posting sit in the place he is moving to? */
export function postingIsAtDestination(facts: ResidenceFacts, job: JobGeography): boolean {
  const dest = norm(facts.destinationCity);
  const destState = norm(facts.destinationState);
  const metro = norm(facts.destinationMetro);
  if (!dest) return false;
  if (job.isRemote) return false;

  const jobCity = norm(job.city);
  const jobMetro = norm(job.metro);
  if (jobCity && jobCity === dest) return true;
  if (metro && (jobMetro === metro || jobCity === metro)) return true;
  // Same state as the destination is not the same market; a posting in
  // Springfield is not answered by moving to Chicago.
  if (jobCity && destState && norm(job.state) === destState && jobMetro === metro && metro !== "") return true;
  return false;
}

/**
 * The header location line.
 *
 * Returns the residence alone when the relocation says nothing useful
 * to this employer.
 */
export function headerLocation(facts: ResidenceFacts, job: JobGeography): string {
  const residence = [facts.city, facts.state].filter(Boolean).join(", ");

  if (!postingIsAtDestination(facts, job)) return residence;
  if (!facts.relocationIsDefinite) return residence;

  const destination = [facts.destinationCity, facts.destinationState].filter(Boolean).join(", ");
  if (!destination) return residence;

  // "Relocating to", never "open to relocating to": the verified fact is
  // that he is moving. No date appears, because none is known.
  return `${residence} · Relocating to ${destination}`;
}

/**
 * The answers relocation facts can and cannot give.
 *
 * Each application question is answered from the field that actually
 * holds it. Nothing here lets one fact stand in for another: a
 * destination does not answer where he lives, a residence does not
 * answer where he wants to work, and an unknown date stays unknown.
 */
export type RelocationAnswer =
  | { known: true; answer: string; because: string }
  | { known: false; why: string };

export function currentResidence(facts: ResidenceFacts): RelocationAnswer {
  const v = [facts.city, facts.state].filter(Boolean).join(", ");
  return v
    ? { known: true, answer: v, because: "the profile's recorded city and state" }
    : { known: false, why: "the profile records no current city and state" };
}

export function relocationDestination(facts: ResidenceFacts): RelocationAnswer {
  const v = [facts.destinationCity, facts.destinationState].filter(Boolean).join(", ");
  return v
    ? { known: true, answer: v, because: "the confirmed relocation destination" }
    : { known: false, why: "no relocation destination has been confirmed" };
}

export function relocationDate(facts: ResidenceFacts): RelocationAnswer {
  if (facts.relocationDate) {
    return { known: true, answer: facts.relocationDate, because: "the confirmed relocation date" };
  }
  return {
    known: false,
    why: "the relocation date is not known. It is never inferred from the destination, from the move being definite, or from anything else.",
  };
}

export function requiresRelocationAssistance(required: boolean | null | undefined): RelocationAnswer {
  if (required === true) return { known: true, answer: "Yes", because: "relocation_assistance_required is true" };
  if (required === false) {
    // "Not required" is not "would refuse". The answer to the question
    // asked is No; nothing further is claimed.
    return { known: true, answer: "No", because: "relocation assistance is not required; this says nothing about whether it would be accepted if offered" };
  }
  return { known: false, why: "whether relocation assistance is required has not been recorded" };
}
