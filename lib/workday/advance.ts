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
