/**
 * How much of an application the system filled, counted once.
 *
 * A fill can be run again. SpotHero was run six times: two runs found no
 * form to observe, three stopped part way, and the sixth reached
 * HANDOFF. Summing the runs said 49 fields encountered and 42 filled for
 * an application that has fourteen fields, and the automation rate
 * computed from it was not a rate of anything.
 *
 * So application-state metrics ask one question per application: what
 * does the form look like now, and how much of it did the system
 * answer. Historical runs are untouched and still readable; they simply
 * stop multiplying the denominator.
 *
 * This is the reference implementation, and the view in migration 0054
 * mirrors it exactly. verify-0054 recomputes the numbers here from the
 * raw rows and compares them against what the view reports, so the two
 * cannot drift apart quietly.
 */

export const FILL_STATE_VERSION = 1;

export interface FillRunRow {
  id: string;
  application_id: string;
  started_at: string;
  finished_at: string | null;
  outcome: string;
  fields_attempted: number;
  fields_filled: number;
  fields_left_blank: number;
}

export interface ApplicationRow {
  id: string;
  status: string;
  is_test: boolean;
}

/**
 * Which run describes an application's current fill state.
 *
 * A run that observed no form observed nothing: reporting its zero as
 * the application's field count would say a filled form has no fields.
 * So a run that saw the form wins over one that did not, and among
 * those, the most recent one wins, because a form that changed between
 * attempts is described by the attempt that saw it last.
 *
 * Ordering is total and never relies on row order: started_at, then
 * finished_at with an unfinished run sorting last, then the run id.
 */
export function pickLatestRun(runs: FillRunRow[]): FillRunRow | null {
  if (!runs.length) return null;
  return [...runs].sort(compareRuns)[0]!;
}

export function compareRuns(a: FillRunRow, b: FillRunRow): number {
  const observed = (r: FillRunRow) => (r.fields_attempted > 0 ? 1 : 0);
  if (observed(a) !== observed(b)) return observed(b) - observed(a);
  if (a.started_at !== b.started_at) return a.started_at < b.started_at ? 1 : -1;
  const fa = a.finished_at ?? "", fb = b.finished_at ?? "";
  if (fa !== fb) return fa < fb ? 1 : -1;
  // Equal ids are the same run. Returning a non-zero value here would
  // make this not a total order, and a sort given one is free to do
  // anything at all.
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

export interface ApplicationStateMetrics {
  applications_measured: number;
  applications_without_a_fill_run: number;
  applications_abandoned: number;
  fields_encountered: number;
  fields_answered_automatically: number;
  fields_left_for_human: number;
}

/**
 * The application-state totals.
 *
 * Test applications are excluded outright: they exist to prove what the
 * database refuses and describe nothing about how well the system fills
 * real forms.
 *
 * Abandoned and withdrawn applications are NOT excluded. How much of a
 * form the system managed to fill stayed true when the application was
 * later dropped, and removing those rows would shrink the denominator in
 * exactly the direction that flatters the automation rate.
 *
 * An application with no run contributes no fields. It is counted
 * separately so that an empty denominator is visible rather than
 * mistaken for perfect automation.
 */
export function applicationStateMetrics(
  apps: ApplicationRow[], runs: FillRunRow[],
): ApplicationStateMetrics {
  const real = apps.filter((a) => !a.is_test);
  const byApp = new Map<string, FillRunRow[]>();
  for (const r of runs) {
    if (!real.some((a) => a.id === r.application_id)) continue;
    byApp.set(r.application_id, [...(byApp.get(r.application_id) ?? []), r]);
  }

  const latest = real
    .map((a) => pickLatestRun(byApp.get(a.id) ?? []))
    .filter((r): r is FillRunRow => r !== null);

  return {
    applications_measured: latest.length,
    applications_without_a_fill_run: real.length - latest.length,
    applications_abandoned: real.filter((a) => a.status === "ABANDONED" || a.status === "WITHDRAWN").length,
    fields_encountered: latest.reduce((n, r) => n + r.fields_attempted, 0),
    fields_answered_automatically: latest.reduce((n, r) => n + r.fields_filled, 0),
    fields_left_for_human: latest.reduce((n, r) => n + r.fields_left_blank, 0),
  };
}
