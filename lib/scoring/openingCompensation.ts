import { createHash } from "node:crypto";

/**
 * Choosing which stated compensation governs an opening.
 *
 * The table is append only, so an opening can carry several observations
 * from several sources. Exactly one of them should decide eligibility,
 * and this is where that is decided.
 *
 * Nothing here compares anything to a floor. compareToFloor in
 * salary.ts is the rule and is deliberately untouched: this module only
 * says which numbers it should be given.
 */

/** How a figure became known, strongest last. */
export type CompensationSource = "POSTING_BODY" | "APPLICATION_FORM" | "EMPLOYER_DIRECT";

/**
 * Where a figure was seen, precisely enough to recognise it again.
 *
 * This is what makes a replay distinguishable from a genuinely new
 * sighting. Re-parsing the SAME frozen evidence reproduces all of it, so
 * the fingerprint matches and nothing is inserted. A new form snapshot,
 * a new posting version, or a different field produces a different
 * identity and is recorded even when the money is identical, which it
 * must be: an employer restating the same rate months later is a real
 * observation, not a duplicate.
 */
export interface EvidenceIdentity {
  /** The opening the figure belongs to. */
  openingId: string;
  /**
   * The container the evidence was read from, by content where possible:
   * a form snapshot hash, a job version id, or an equivalent stable
   * reference. Content-addressed beats id-addressed here, because a
   * re-prepared application can reuse an id while the form has changed.
   */
  sourceRef: string;
  /** Where inside the container: a form field key, a section, a locator. */
  sourceLocator: string;
  /** The employer's exact words. Never a summary. */
  sourceText: string;
}

export interface CompensationObservation {
  amountMin: number | null;
  amountMax: number | null;
  currency: string;
  period: string;
  /**
   * Where the employer stated it.
   *
   * Every source denotes the employer as the author. There is
   * deliberately no value for a third-party estimate: this evidence can
   * end a candidacy against a hard floor, and something a salary
   * aggregator guessed must never be able to do that.
   */
  source: CompensationSource;
  /**
   * When the evidence was OBSERVED, not when a script last read it.
   *
   * A frozen form snapshot was captured once; re-parsing it later does
   * not make the sighting newer. Stamping "now" on a re-read would let a
   * rerun outrank a genuinely newer posting purely by running last.
   */
  observedAt: string;
  identity?: EvidenceIdentity;
  sourceDetail?: unknown;
}

/**
 * Source strength.
 *
 * A figure the employer put on their own application form is at least as
 * authoritative as one in the posting body: it is the number attached to
 * the thing being applied for, and the Flexport case is exactly a form
 * stating a rate the posting never mentioned. Something said directly to
 * the user outranks both, because it is the most specific.
 *
 * Equal rank is broken by recency, so a re-posted range supersedes an
 * older one from the same kind of source.
 */
const RANK: Record<CompensationSource, number> = {
  POSTING_BODY: 1,
  APPLICATION_FORM: 2,
  EMPLOYER_DIRECT: 3,
};

/**
 * The observation that should govern, or null.
 *
 * Every observation here is employer-stated by construction, so there is
 * nothing to filter out: the table admits no other kind. What remains is
 * choosing between several things the employer said.
 */
export function governingCompensation(
  observations: CompensationObservation[],
): CompensationObservation | null {
  if (!observations.length) return null;

  return observations.reduce((best, o) => {
    if (RANK[o.source] > RANK[best.source]) return o;
    if (RANK[o.source] < RANK[best.source]) return best;
    return o.observedAt > best.observedAt ? o : best;
  });
}

/**
 * The stable identity of one piece of compensation evidence.
 *
 * Hashed over where it was seen AND what it said. Both halves matter:
 * location alone would collide when an employer edits a rate in place,
 * and value alone would refuse a genuine later restatement of the same
 * pay, which is the bug this replaced.
 *
 * The same string is recomputed by the recorder on every run, so the
 * database can hold a plain unique constraint on it and no caller can
 * create a duplicate by forgetting to check.
 */
export function observationFingerprint(input: {
  identity: EvidenceIdentity;
  source: CompensationSource;
  period: string;
  currency: string;
  amountMin: number | null;
  amountMax: number | null;
}): string {
  // Field order is fixed and the separator cannot appear in a hash or a
  // source key, so two different inputs cannot serialise the same way.
  const canonical = JSON.stringify([
    input.identity.openingId,
    input.source,
    input.identity.sourceRef,
    input.identity.sourceLocator,
    input.identity.sourceText.replace(/\s+/g, " ").trim(),
    input.period,
    input.currency,
    input.amountMin,
    input.amountMax,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Whether this is evidence we have not already recorded.
 *
 * Compared on the evidence FINGERPRINT, not on the money. The recorder
 * re-reads frozen snapshots, so every run meets the same sentence again
 * and must not insert it twice. But an employer restating the same rate
 * in a new posting version or a new form is a genuine second sighting
 * and has to be recordable, which a value-based check would have
 * refused. The same rule is a unique constraint in migration 0078, so a
 * caller that forgets to ask cannot create the duplicate either.
 */
export function isNewInformation(
  candidate: CompensationObservation,
  existing: CompensationObservation[],
): boolean {
  if (!candidate.identity) {
    throw new Error("an observation without an evidence identity cannot be checked for replay");
  }
  const fp = observationFingerprint({
    identity: candidate.identity, source: candidate.source,
    period: candidate.period, currency: candidate.currency,
    amountMin: candidate.amountMin, amountMax: candidate.amountMax,
  });
  return !existing.some((o) => o.identity && observationFingerprint({
    identity: o.identity, source: o.source, period: o.period,
    currency: o.currency, amountMin: o.amountMin, amountMax: o.amountMax,
  }) === fp);
}

/**
 * Compensation stated in the text of an employer's form field.
 *
 * Deliberately narrow. It reads a figure only from an unambiguous
 * statement of pay FOR THIS ROLE, and returns null for anything it is
 * not sure about, because a wrong number here excludes a job the user
 * would have wanted.
 *
 * What it will not do:
 *   guess a period that is not written down;
 *   read a number out of a question ASKING for the user's expectation;
 *   treat a bare number with no currency as money.
 */
export function compensationFromFieldText(text: string): {
  amountMin: number;
  amountMax: number;
  currency: string;
  period: string;
} | null {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;

  // A question asking the user what they want is not a disclosure. These
  // are the wordings that mean "tell us", and they disqualify the whole
  // field however much it looks like a statement afterwards.
  if (/\b(your|expected|desired|requirement|what (are|is) you|salary expectation|compensation expectation|how much)\b/i.test(t)) {
    return null;
  }

  // The period has to be written. "$27.69/hour", "$27.69 per hour".
  const period = /\b(per hour|\/ ?hour|\/ ?hr|hourly|an hour)\b/i.test(t) ? "HOUR"
    : /\b(per month|\/ ?month|monthly|a month)\b/i.test(t) ? "MONTH"
      : /\b(per year|\/ ?year|per annum|annually|annualized|a year|\/ ?yr)\b/i.test(t) ? "YEAR"
        : null;
  if (!period) return null;

  // Currency has to be explicit. A bare number is not money.
  const amounts = [...t.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)]
    .map((m) => Number(m[1]!.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!amounts.length) return null;

  // A range states two numbers; a flat rate states one and is a definite
  // figure, so both bounds are that figure.
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  return { amountMin: min, amountMax: max, currency: "USD", period };
}

/**
 * Every compensation statement in a frozen form snapshot.
 *
 * Field labels are where this hides: the employer writes the rate into
 * the label of the control that asks you to acknowledge it.
 */
export function compensationFromFormSnapshot(
  snapshot: { fields?: Array<{ key?: string; label?: string }> } | null | undefined,
): Array<{ fieldKey: string; label: string; amountMin: number; amountMax: number; currency: string; period: string }> {
  const out: Array<{ fieldKey: string; label: string; amountMin: number; amountMax: number; currency: string; period: string }> = [];
  for (const f of snapshot?.fields ?? []) {
    const found = compensationFromFieldText(String(f.label ?? ""));
    if (found) out.push({ fieldKey: String(f.key ?? ""), label: String(f.label ?? ""), ...found });
  }
  return out;
}

/**
 * Employer-stated compensation, by opening.
 *
 * Lives here rather than in each caller because it was duplicated once
 * and the copies diverged immediately: the base eligibility pass learned
 * about compensation and the extraction-informed refresh did not, so the
 * refresh overwrote the base pass's correct verdict and Flexport went
 * back to ELIGIBLE. One implementation, used by both.
 *
 * A missing table is not an error. The migration may not be applied yet,
 * and eligibility must behave exactly as it did before rather than fail.
 */
export async function loadCompensationByOpening(
  db: { from: (t: string) => any },
  onNotice?: (message: string) => void,
): Promise<Map<string, CompensationObservation[]>> {
  const byOpening = new Map<string, CompensationObservation[]>();
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("opening_compensation")
      .select("canonical_opening_id,amount_min,amount_max,currency,period,source,observed_at,source_ref,source_locator,source_text")
      .order("id", { ascending: true }).range(from, from + 999);
    if (error) { onNotice?.(`opening_compensation not readable: ${error.message}`); return byOpening; }
    rows.push(...data);
    if (data.length < 1000) break;
  }
  for (const r of rows) {
    const arr = byOpening.get(r.canonical_opening_id) ?? [];
    arr.push({
      amountMin: r.amount_min === null ? null : Number(r.amount_min),
      amountMax: r.amount_max === null ? null : Number(r.amount_max),
      currency: r.currency, period: r.period, source: r.source,
      observedAt: r.observed_at,
      identity: {
        openingId: r.canonical_opening_id, sourceRef: r.source_ref,
        sourceLocator: r.source_locator, sourceText: r.source_text,
      },
    });
    byOpening.set(r.canonical_opening_id, arr);
  }
  return byOpening;
}

/**
 * The salary figures the floor rule should see for one job.
 *
 * What the employer stated for the opening outranks the posting's own
 * structured columns, which are frequently null. Returns the job's own
 * values untouched when nothing was stated.
 */
export function salaryInputForJob(
  job: Record<string, any>,
  byOpening: Map<string, CompensationObservation[]>,
): { salaryMin: number | null; salaryMax: number | null; salaryPeriod: string | null; salaryIsEstimated: boolean } {
  const governing = governingCompensation(byOpening.get(job.canonical_opening_id ?? "") ?? []);
  if (!governing) {
    return {
      salaryMin: job.salary_min ?? null, salaryMax: job.salary_max ?? null,
      salaryPeriod: job.salary_period ?? null, salaryIsEstimated: Boolean(job.salary_is_estimated),
    };
  }
  // Stored in the employer's own period. compareToFloor annualizes; this
  // never multiplies anything out itself.
  return {
    salaryMin: governing.amountMin, salaryMax: governing.amountMax,
    salaryPeriod: governing.period, salaryIsEstimated: false,
  };
}

/** True when the employer stated pay for this opening. */
export function hasStatedCompensation(
  job: Record<string, any>,
  byOpening: Map<string, CompensationObservation[]>,
): boolean {
  return (byOpening.get(job.canonical_opening_id ?? "") ?? []).length > 0;
}
