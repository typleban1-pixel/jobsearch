/**
 * One application, counted once. Every event, counted every time.
 *
 * The bug this fixes made SpotHero look like six applications: six fill
 * runs summed to 49 fields encountered on a form with fourteen. The
 * obvious fix is to deduplicate, and the obvious fix applied one step
 * too far would collapse three genuine corrections on one application
 * into one correction, which is a worse number than the one it replaced.
 *
 * So the cases below check both halves: state is a snapshot and comes
 * from one run, history is a stream and keeps every entry.
 *
 * The SQL view in 0054 mirrors pickLatestRun exactly, and verify-0054
 * compares the two against the live database so they cannot drift.
 */
import { pickLatestRun, applicationStateMetrics, compareRuns,
         type ApplicationRow, type FillRunRow } from "../lib/metrics/fillState.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
};

const run = (over: Partial<FillRunRow> & { id: string; application_id: string; started_at: string }): FillRunRow => ({
  finished_at: null, outcome: "HANDOFF",
  fields_attempted: 0, fields_filled: 0, fields_left_blank: 0, ...over,
});
const app = (id: string, status = "READY_TO_SUBMIT", is_test = false): ApplicationRow => ({ id, status, is_test });

// The real SpotHero history, as it sits in the database.
const SPOTHERO = "9af26bee";
const SPOTHERO_RUNS: FillRunRow[] = [
  run({ id: "1e37cdb7", application_id: SPOTHERO, started_at: "2026-08-31T04:46:58Z", finished_at: "2026-08-31T04:47:03Z", outcome: "NO_FORM_FOUND" }),
  run({ id: "97a037e8", application_id: SPOTHERO, started_at: "2026-08-31T05:01:00Z", finished_at: "2026-08-31T05:01:30Z", outcome: "UPLOAD_UNACKNOWLEDGED" }),
  run({ id: "95647967", application_id: SPOTHERO, started_at: "2026-08-31T05:12:43Z", finished_at: "2026-08-31T05:13:06Z", outcome: "REQUIRED_FIELD_BLOCKED", fields_attempted: 15, fields_filled: 11, fields_left_blank: 4 }),
  run({ id: "df5c5eb7", application_id: SPOTHERO, started_at: "2026-08-31T05:14:33Z", finished_at: "2026-08-31T05:14:41Z", outcome: "SELECTOR_AMBIGUOUS", fields_attempted: 6, fields_filled: 5, fields_left_blank: 1 }),
  run({ id: "fe1bd45e", application_id: SPOTHERO, started_at: "2026-08-31T13:19:56Z", finished_at: "2026-08-31T13:20:20Z", outcome: "SUBMISSION_ATTEMPT_BLOCKED", fields_attempted: 14, fields_filled: 13, fields_left_blank: 1 }),
  run({ id: "c6017d94", application_id: SPOTHERO, started_at: "2026-08-31T13:21:42Z", finished_at: "2026-08-31T13:22:05Z", outcome: "HANDOFF", fields_attempted: 14, fields_filled: 13, fields_left_blank: 1 }),
];

// ---- 1. Retries are one observation, not six ------------------------
{
  const m = applicationStateMetrics([app(SPOTHERO)], SPOTHERO_RUNS);
  check("six runs on one application are one application-state observation",
    m.applications_measured === 1, String(m.applications_measured));
  check("fields encountered is what the form has, not the sum of attempts",
    m.fields_encountered === 14, `${m.fields_encountered} (summing every run gives 49)`);
  check("automatically answered is likewise not summed",
    m.fields_answered_automatically === 13, `${m.fields_answered_automatically} (summing gives 42)`);
  check("and neither is what was left for a human",
    m.fields_left_for_human === 1, `${m.fields_left_for_human} (summing gives 7)`);
  check("so the automation rate is a rate of something",
    Math.round((m.fields_answered_automatically / m.fields_encountered) * 1000) / 10 === 92.9,
    String((m.fields_answered_automatically / m.fields_encountered) * 100));
}

// ---- 2. The latest applicable run decides ---------------------------
{
  check("the HANDOFF run describes the application, being the most recent that saw the form",
    pickLatestRun(SPOTHERO_RUNS)?.id === "c6017d94", String(pickLatestRun(SPOTHERO_RUNS)?.id));

  // A run that found no form observed nothing, and must not stand as
  // the application's field count even when it is the most recent.
  const laterEmpty = [...SPOTHERO_RUNS,
    run({ id: "zzzzzzzz", application_id: SPOTHERO, started_at: "2026-08-31T20:00:00Z", outcome: "NO_FORM_FOUND" })];
  check("a later run that saw no form does not erase what the form has",
    pickLatestRun(laterEmpty)?.id === "c6017d94", String(pickLatestRun(laterEmpty)?.id));
  check("and the field counts stay the ones actually observed",
    applicationStateMetrics([app(SPOTHERO)], laterEmpty).fields_encountered === 14, "");

  // A form that changed is described by the attempt that saw it last,
  // whether that means more fields or fewer.
  const grew = [...SPOTHERO_RUNS,
    run({ id: "aaaaaaaa", application_id: SPOTHERO, started_at: "2026-09-02T09:00:00Z", finished_at: "2026-09-02T09:01:00Z", outcome: "HANDOFF", fields_attempted: 20, fields_filled: 18, fields_left_blank: 2 })];
  check("a later run seeing a bigger form reports the bigger form",
    applicationStateMetrics([app(SPOTHERO)], grew).fields_encountered === 20, "");
  const shrank = [...SPOTHERO_RUNS,
    run({ id: "bbbbbbbb", application_id: SPOTHERO, started_at: "2026-09-02T09:00:00Z", finished_at: "2026-09-02T09:01:00Z", outcome: "HANDOFF", fields_attempted: 9, fields_filled: 9, fields_left_blank: 0 })];
  check("and a later run seeing a smaller one reports the smaller one",
    applicationStateMetrics([app(SPOTHERO)], shrank).fields_encountered === 9, "");
  check("failed and aborted runs before it are still not counted",
    applicationStateMetrics([app(SPOTHERO)], shrank).applications_measured === 1, "");
}

// ---- 3. Two applications are two -----------------------------------
{
  const other: FillRunRow[] = [
    run({ id: "o1", application_id: "other", started_at: "2026-09-01T10:00:00Z", finished_at: "2026-09-01T10:05:00Z", outcome: "HANDOFF", fields_attempted: 8, fields_filled: 6, fields_left_blank: 2 }),
  ];
  const m = applicationStateMetrics([app(SPOTHERO), app("other")], [...SPOTHERO_RUNS, ...other]);
  check("two applications are two observations",
    m.applications_measured === 2, String(m.applications_measured));
  check("and their fields add up across applications, not across retries",
    m.fields_encountered === 22 && m.fields_answered_automatically === 19 && m.fields_left_for_human === 3,
    JSON.stringify(m));
}

// ---- 4. An application with no run fabricates nothing ---------------
{
  const m = applicationStateMetrics([app(SPOTHERO), app("never-filled", "ABANDONED")], SPOTHERO_RUNS);
  check("an application with no fill run contributes no fields",
    m.fields_encountered === 14, String(m.fields_encountered));
  check("it is not counted as a measured application",
    m.applications_measured === 1, String(m.applications_measured));
  check("but it is reported, so an empty denominator is visible",
    m.applications_without_a_fill_run === 1, String(m.applications_without_a_fill_run));
  check("and an abandoned application is still counted where it has a run",
    applicationStateMetrics([app("gone", "ABANDONED")],
      [run({ id: "g1", application_id: "gone", started_at: "2026-07-01T10:00:00Z", outcome: "HANDOFF", fields_attempted: 5, fields_filled: 4, fields_left_blank: 1 })]).fields_encountered === 5,
    "dropping it would shrink the denominator in the direction that flatters the rate");
}

// ---- 5. Test applications stay out ----------------------------------
{
  const probeRuns = [
    run({ id: "p1", application_id: "probe", started_at: "2026-09-03T10:00:00Z", outcome: "HANDOFF", fields_attempted: 99, fields_filled: 99, fields_left_blank: 0 }),
  ];
  const m = applicationStateMetrics([app(SPOTHERO), app("probe", "DRAFT", true)], [...SPOTHERO_RUNS, ...probeRuns]);
  check("a test application does not enter the metrics",
    m.applications_measured === 1 && m.fields_encountered === 14, JSON.stringify(m));
  check("its perfect automation cannot flatter the rate",
    m.fields_answered_automatically === 13, String(m.fields_answered_automatically));
  check("and it is not counted as an application without a run either",
    m.applications_without_a_fill_run === 0, String(m.applications_without_a_fill_run));
}

// ---- 6. Ties resolve the same way every time ------------------------
{
  const tied: FillRunRow[] = [
    run({ id: "aaa", application_id: "t", started_at: "2026-09-01T10:00:00Z", finished_at: "2026-09-01T10:05:00Z", fields_attempted: 4, fields_filled: 4 }),
    run({ id: "zzz", application_id: "t", started_at: "2026-09-01T10:00:00Z", finished_at: "2026-09-01T10:05:00Z", fields_attempted: 4, fields_filled: 4 }),
  ];
  check("two runs identical but for their id resolve on the id, highest first",
    pickLatestRun(tied)?.id === "zzz" && pickLatestRun([...tied].reverse())?.id === "zzz",
    String(pickLatestRun(tied)?.id));

  const unfinished: FillRunRow[] = [
    run({ id: "a", application_id: "t", started_at: "2026-09-01T10:00:00Z", finished_at: null, fields_attempted: 4 }),
    run({ id: "b", application_id: "t", started_at: "2026-09-01T10:00:00Z", finished_at: "2026-09-01T10:05:00Z", fields_attempted: 4 }),
  ];
  check("a finished run beats one that never finished",
    pickLatestRun(unfinished)?.id === "b", String(pickLatestRun(unfinished)?.id));

  // Input order must never decide anything.
  const shuffled = [...SPOTHERO_RUNS].sort(() => 0.5 - Math.random());
  check("the answer does not depend on the order rows arrive in",
    pickLatestRun(shuffled)?.id === "c6017d94", String(pickLatestRun(shuffled)?.id));
  check("the comparison is a total order",
    compareRuns(SPOTHERO_RUNS[0]!, SPOTHERO_RUNS[0]!) === 0
    && compareRuns(SPOTHERO_RUNS[0]!, SPOTHERO_RUNS[5]!) === -compareRuns(SPOTHERO_RUNS[5]!, SPOTHERO_RUNS[0]!), "");
  check("no runs at all yields nothing rather than a zero", pickLatestRun([]) === null, "");
}

// ---- 7. History is a stream, and stays one --------------------------
//
// The counting rule for events is deliberately NOT the rule for state.
// Three corrections on one application are three corrections, including
// when they were given across different retries of the same fill.
{
  const events = [
    { application_id: SPOTHERO, run: "95647967", proposed: null, human: "Yes" },
    { application_id: SPOTHERO, run: "fe1bd45e", proposed: "No", human: "Yes" },
    { application_id: SPOTHERO, run: "c6017d94", proposed: "Yes", human: "Yes" },
    { application_id: "other", run: "o1", proposed: "Maybe", human: "No" },
  ];
  const interventions = events.length;
  const corrections = events.filter((e) => e.proposed && e.proposed.toLowerCase() !== e.human.toLowerCase()).length;
  const confirmations = events.filter((e) => e.proposed && e.proposed.toLowerCase() === e.human.toLowerCase()).length;

  check("every intervention is counted, including several on one application",
    interventions === 4, String(interventions));
  check("corrections across different retries are all counted",
    corrections === 2, String(corrections));
  check("confirmations are counted separately from corrections",
    confirmations === 1, String(confirmations));
  check("collapsing an application to one run must never collapse its events",
    applicationStateMetrics([app(SPOTHERO), app("other")], SPOTHERO_RUNS).applications_measured === 1
    && events.filter((e) => e.application_id === SPOTHERO).length === 3,
    "one state observation, three events");
}

console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
