/**
 * Which control moves to the next page, and which one is never clicked.
 *
 * Advancing and submitting sit next to each other on the last pages of a
 * Workday application, and on Review the only forward control IS submit.
 * So this does not look for "a forward-looking button"; it matches an
 * allow-list exactly, and refuses anything that mentions submitting even
 * if a tenant happens to label its Continue button unusually.
 */
export const ADVANCE_LABELS = [/^save and continue$/i, /^continue$/i, /^next$/i, /^save and next$/i];
const FORBIDDEN = /submit|apply now|finish|send application/i;

export type AdvanceChoice =
  | { click: true; label: string }
  | { click: false; why: string };

export function chooseAdvance(labels: string[]): AdvanceChoice {
  const visible = labels.map((l) => String(l ?? "").trim()).filter(Boolean);
  const forbidden = visible.filter((l) => FORBIDDEN.test(l));
  const allowed = visible.filter((l) => ADVANCE_LABELS.some((re) => re.test(l)) && !FORBIDDEN.test(l));
  if (allowed.length === 1) return { click: true, label: allowed[0]! };
  if (allowed.length > 1) {
    return { click: false, why: `${allowed.length} controls advance (${allowed.join(", ")}); which one is meant is not decidable here` };
  }
  if (forbidden.length) {
    return { click: false, why: `the only forward control is ${JSON.stringify(forbidden[0])}, which is not clicked without approval` };
  }
  return { click: false, why: "no control on this page advances it" };
}

/**
 * Controls that accept something on the person's behalf.
 *
 * A standard application acknowledgment -- the terms, a privacy notice,
 * an applicant certification, an electronic signature -- is part of
 * ordinary applying, and the person has authorised these to be checked
 * for them.
 *
 * What is NOT authorised is a box that makes a factual representation
 * this system cannot ground, or that commits the person to something
 * beyond applying for a job. Those are shown to a person instead,
 * because checking one would be asserting something on their behalf
 * rather than completing a form.
 */
const ACCEPTANCE = [
  /\baccept(?:ance|ing)?\b[^.]{0,40}\b(terms|agreement|conditions|policy|policies)\b/i,
  /\b(terms|agreement|conditions)\b[^.]{0,30}\b(accept|agree|acknowledge)\b/i,
  /\bi (?:accept|agree|acknowledge|consent|certify)\b/i,
  /\backnowledge your acceptance\b/i,
  /\bacceptTermsAndAgreements\b/i,
  /\belectronic signature\b/i,
  /\bconsent to\b[^.]{0,30}\b(terms|processing|agreement)\b/i,
];

/** Obligations that go beyond applying, or facts we cannot stand behind. */
const NEEDS_A_PERSON = [
  { re: /\barbitrat\w*|class[- ]action\b/i, what: "an arbitration or class-action waiver" },
  { re: /\bnon-?compet\w*|\brestrictive covenant\b/i, what: "a non-compete or restrictive covenant" },
  { re: /\bwaive[sd]?\b[^.]{0,30}\b(right|claim)/i, what: "a waiver of rights" },
  { re: /\bindemnif\w*/i, what: "an indemnity" },
  { re: /\bassign\w*\b[^.]{0,30}\b(invention|intellectual property|patent)/i, what: "an assignment of intellectual property" },
  { re: /\b(fee|payment|charge)\b[^.]{0,30}\b(pay|paid|owe)/i, what: "a payment obligation" },
  { re: /\bcredit (?:check|report|history)\b/i, what: "a credit check" },
  // A certification about a specific personal fact, as distinct from
  // certifying that the application itself is accurate.
  { re: /\bi certify\b(?![^.]{0,60}\b(information|application|answers|statements|above|provided)\b)/i,
    what: "a certification about a specific personal fact" },
];

export type AcceptanceVerdict =
  | { kind: "NOT_ACCEPTANCE" }
  | { kind: "STANDARD" }
  | { kind: "NEEDS_A_PERSON"; why: string };

export function classifyAcceptance(labelOrKey: string): AcceptanceVerdict {
  const t = String(labelOrKey ?? "");
  if (!ACCEPTANCE.some((re) => re.test(t))) return { kind: "NOT_ACCEPTANCE" };
  const flagged = NEEDS_A_PERSON.find((r) => r.re.test(t));
  if (flagged) return { kind: "NEEDS_A_PERSON", why: `it carries ${flagged.what}` };
  return { kind: "STANDARD" };
}

/** True for anything that accepts something, standard or not. */
export function isAcceptanceControl(labelOrKey: string): boolean {
  return classifyAcceptance(labelOrKey).kind !== "NOT_ACCEPTANCE";
}
