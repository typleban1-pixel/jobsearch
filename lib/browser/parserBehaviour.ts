/**
 * What an ATS was OBSERVED to do, and what the worker chooses to DO.
 *
 * Two different things, deliberately kept apart. Greenhouse is
 * documented as parsing an uploaded resume and populating fields from
 * it; across three live board forms the upload was acknowledged and not
 * one field was populated. Documentation is not an observation, and
 * three quiet forms are not a provider-wide finding either.
 *
 *   parserMode      observed. UNKNOWN until measured, and it takes real
 *                   evidence to move, in either direction.
 *
 *   uploadOrdering  chosen. May be more conservative than the evidence
 *                   requires, and for Greenhouse it is: reconciling a
 *                   parse that never happens costs nothing, while
 *                   filling before a parse that does happen loses the
 *                   answers.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ParserMode = "PARSER_OVERWRITES" | "PARSER_INERT" | "UNKNOWN";
export type UploadOrdering = "UPLOAD_FIRST" | "UPLOAD_LAST";

/**
 * How many runs seeing no parsing it takes before "inert" is a finding
 * rather than a small sample. Not reached yet for any provider.
 */
export const INERT_EVIDENCE_THRESHOLD = 10;

/** Strategy before the table exists. Nothing here is a measurement. */
const DEFAULT_ORDERING: Record<string, UploadOrdering> = {
  GREENHOUSE: "UPLOAD_FIRST",
  LEVER: "UPLOAD_LAST",
  // Measured: Ashby's resume upload triggers an ASYNC autofill parse that
  // re-initialises the form state and wipes any field the parse did not
  // itself repopulate. Filling last therefore loses the answers to a parse
  // that lands after the post-upload check (Name/LinkedIn survived because
  // the parser refilled them; every other field submitted empty). So upload
  // FIRST, wait for the parse to settle, then fill -- the real applicant flow.
  ASHBY: "UPLOAD_FIRST",
};

export interface Behaviour {
  parserMode: ParserMode;
  uploadOrdering: UploadOrdering;
  observationCount: number;
}

export async function behaviourOf(db: SupabaseClient, provider: string): Promise<Behaviour> {
  const { data } = await db.from("ats_form_behaviour")
    .select("parser_mode,upload_ordering,observation_count").eq("provider", provider).maybeSingle();
  return {
    // Never inferred from anything. Absent row means nobody has measured.
    parserMode: (data?.parser_mode as ParserMode) ?? "UNKNOWN",
    uploadOrdering: (data?.upload_ordering as UploadOrdering) ?? DEFAULT_ORDERING[provider] ?? "UPLOAD_LAST",
    observationCount: data?.observation_count ?? 0,
  };
}

/** Ordering follows the strategy, never the observation. */
export function uploadFirst(b: Behaviour): boolean {
  return b.uploadOrdering === "UPLOAD_FIRST";
}

/**
 * Records one run's evidence.
 *
 * Seeing a field move is conclusive: one observation of overwriting
 * proves the parser overwrites. Seeing nothing move is not, so it
 * accumulates and only becomes PARSER_INERT after enough runs agree.
 * Until then the mode stays UNKNOWN, which is the honest answer.
 */
export async function recordObservation(
  db: SupabaseClient,
  provider: string,
  observed: { fieldsMoved: string[]; fieldsChecked: number },
): Promise<ParserMode> {
  const current = await behaviourOf(db, provider);
  const count = current.observationCount + 1;

  let mode: ParserMode = current.parserMode;
  if (observed.fieldsMoved.length > 0) {
    mode = "PARSER_OVERWRITES";
  } else if (current.parserMode === "UNKNOWN" && count >= INERT_EVIDENCE_THRESHOLD) {
    mode = "PARSER_INERT";
  }

  await db.from("ats_form_behaviour").upsert({
    provider,
    parser_mode: mode,
    // Strategy is not touched by an observation. Changing what we do is
    // a decision, not a side effect of measuring.
    upload_ordering: current.uploadOrdering,
    observation_count: count,
    observed_at: new Date().toISOString(),
    evidence: {
      lastRun: {
        at: new Date().toISOString(),
        fieldsChecked: observed.fieldsChecked,
        fieldsMoved: observed.fieldsMoved,
      },
      runsObserved: count,
      note: observed.fieldsMoved.length > 0
        ? "a field changed after the resume upload; the parser overwrites"
        : `no field moved after the upload (${count} of ${INERT_EVIDENCE_THRESHOLD} runs needed before that is a finding)`,
    } as any,
  }, { onConflict: "provider" });

  return mode;
}
