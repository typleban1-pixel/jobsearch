/**
 * The worker acts on the current verdict, or on none at all.
 *
 *   node scripts/worker-selection-selftest.ts
 *
 * Two defects found by the end-to-end validation run, both in the
 * worker's selection query.
 *
 *   It read job_candidacy without a version predicate and collapsed the
 *   rows by job_id, so the verdict it acted on was whichever row sorted
 *   last by uuid. 1,004 of 1,491 jobs resolved to a stale verdict; 561
 *   came from profile v12.
 *
 *   It read applications without is_test, so a fixture could stand in
 *   for a real application and could be picked up by the
 *   requested-submission path. Nothing was armed on the day it was
 *   found, which is a fact about the data and not about the system.
 *
 * Every assertion here is about selection. Nothing in this file asserts
 * anything about what a verdict MEANS; that is Model 4's business.
 */
import { authoritativeCandidacy, isAuthoritative, productionApplications,
         isProductionApplication, type CandidacyVersionRow, type ScoringVersions } from "../lib/applications/authoritativeCandidacy.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};

const V: ScoringVersions = { profileVersion: 15, formulaVersion: 3, taxonomyVersion: 4, modelVersion: 4 };
const row = (job: string, verdict: string, over: Partial<CandidacyVersionRow> = {}): CandidacyVersionRow =>
  ({ job_id: job, verdict: verdict as any, profile_version: 15, formula_version: 3,
     taxonomy_version: 4, model_version: 4, ...over });

console.log("\n1. multiple rows for one job cannot be selected arbitrarily:");
{
  // The exact live shape: three rows for one job at three states.
  const rows = [
    row("j1", "APPLICATION_CANDIDATE", { model_version: 3 }),
    row("j1", "MANUAL_REVIEW"),
    row("j1", "STRETCH", { model_version: 3, profile_version: 12 }),
  ];
  const got = authoritativeCandidacy(rows, V);
  check("only the authoritative row is kept", got.get("j1") === "MANUAL_REVIEW", JSON.stringify([...got]));
  check("and exactly one entry exists for the job", got.size === 1);
}

console.log("\n2. no order dependence:");
{
  const rows = [
    row("j1", "APPLICATION_CANDIDATE", { model_version: 3 }),
    row("j1", "MANUAL_REVIEW"),
    row("j1", "STRETCH", { profile_version: 12, model_version: 3 }),
    row("j2", "REJECT"),
    row("j2", "STRETCH", { taxonomy_version: 3 }),
  ];
  // Every permutation of the input must give the same answer. The old
  // code passed or failed depending on which row came last.
  const perms: CandidacyVersionRow[][] = [];
  const permute = (a: CandidacyVersionRow[], cur: CandidacyVersionRow[] = []) => {
    if (!a.length) { perms.push(cur); return; }
    a.forEach((x, i) => permute([...a.slice(0, i), ...a.slice(i + 1)], [...cur, x]));
  };
  permute(rows);
  const answers = new Set(perms.map((p) => JSON.stringify([...authoritativeCandidacy(p, V)].sort())));
  check(`all ${perms.length} orderings agree`, answers.size === 1, `${answers.size} distinct answers`);
  check("and the answer is the authoritative one",
    [...answers][0] === JSON.stringify([["j1", "MANUAL_REVIEW"], ["j2", "REJECT"]]), [...answers][0]);
}

console.log("\n3. model 4 wins over model 3:");
{
  const got = authoritativeCandidacy([
    row("j1", "APPLICATION_CANDIDATE", { model_version: 3 }),
    row("j1", "MANUAL_REVIEW", { model_version: 4 }),
  ], V);
  check("the model 4 verdict is the one selected", got.get("j1") === "MANUAL_REVIEW", JSON.stringify([...got]));
  // And with the model 3 row listed second, where it used to win.
  const got2 = authoritativeCandidacy([
    row("j1", "MANUAL_REVIEW", { model_version: 4 }),
    row("j1", "APPLICATION_CANDIDATE", { model_version: 3 }),
  ], V);
  check("still, when the stale row is listed last", got2.get("j1") === "MANUAL_REVIEW", JSON.stringify([...got2]));
}

console.log("\n4. the current profile version wins over stale ones:");
{
  const got = authoritativeCandidacy([
    row("j1", "APPLICATION_CANDIDATE", { profile_version: 12 }),
    row("j1", "REJECT", { profile_version: 14 }),
    row("j1", "STRETCH", { profile_version: 15 }),
  ], V);
  check("v15 is selected", got.get("j1") === "STRETCH", JSON.stringify([...got]));
  check("v12 is not reachable", ![...got.values()].includes("APPLICATION_CANDIDATE" as any));
}

console.log("\n5. every version axis is load-bearing:");
{
  for (const [label, over] of [
    ["profile", { profile_version: 14 }], ["formula", { formula_version: 2 }],
    ["taxonomy", { taxonomy_version: 3 }], ["model", { model_version: 3 }],
  ] as Array<[string, Partial<CandidacyVersionRow>]>) {
    const got = authoritativeCandidacy([row("j1", "APPLICATION_CANDIDATE", over)], V);
    check(`a mismatched ${label} version is not authoritative`, got.size === 0, JSON.stringify([...got]));
    check(`  and isAuthoritative agrees about ${label}`, !isAuthoritative(row("j1", "X", over), V));
  }
}

console.log("\n6. a missing authoritative row fails closed:");
{
  const got = authoritativeCandidacy([row("j1", "APPLICATION_CANDIDATE", { model_version: 3 })], V);
  check("the job is absent from the map", !got.has("j1"), JSON.stringify([...got]));
  check("reading it yields undefined, not a stale verdict", got.get("j1") === undefined);
  // The worker turns that into `candidacy: null`, which decide() refuses.
  check("and null is what a caller must pass on", (got.get("j1") ?? null) === null);
}

console.log("\n7. two authoritative rows disagreeing is an error, not a coin flip:");
{
  let threw = false;
  try { authoritativeCandidacy([row("j1", "STRETCH"), row("j1", "REJECT")], V); }
  catch (e) { threw = true; check("the message names the job", /j1/.test(String(e)), String(e)); }
  check("it throws rather than choosing", threw);
  // Identical duplicates are harmless and must not throw.
  let ok = true;
  try { authoritativeCandidacy([row("j1", "STRETCH"), row("j1", "STRETCH")], V); } catch { ok = false; }
  check("identical duplicate rows are accepted", ok);
}

console.log("\n8. SpotHero, the live case:");
{
  // The three rows that actually exist for job a3529df5.
  const spot = [
    row("a3529df5", "REJECT", { profile_version: 12, model_version: 3 }),
    row("a3529df5", "APPLICATION_CANDIDATE", { model_version: 3 }),
    row("a3529df5", "MANUAL_REVIEW", { model_version: 4 }),
  ];
  const got = authoritativeCandidacy(spot, V);
  check("SpotHero reads MANUAL_REVIEW", got.get("a3529df5") === "MANUAL_REVIEW", String(got.get("a3529df5")));
  check("not the stale model 3 APPLICATION_CANDIDATE", got.get("a3529df5") !== "APPLICATION_CANDIDATE");
}

console.log("\n9. test applications are not applications:");
{
  const apps = [
    { id: "real1", job_id: "j1", is_test: false, human_approved: false },
    { id: "fixture", job_id: "j2", is_test: true, human_approved: true },
    { id: "real2", job_id: "j3", is_test: null, human_approved: true },
  ];
  const prod = productionApplications(apps);
  check("a test row is excluded", !prod.some((a) => a.id === "fixture"), JSON.stringify(prod.map((a) => a.id)));
  check("is_test false is production", prod.some((a) => a.id === "real1"));
  check("is_test null is production, not excluded by accident", prod.some((a) => a.id === "real2"));
  check("exactly the real ones survive", prod.length === 2);
}

console.log("\n10. a fixture cannot suppress a real application:");
{
  // appByJob is what tells the worker an application already exists. A
  // fixture on a real job made the worker skip preparing the real one.
  const apps = [{ id: "fixture", job_id: "j1", is_test: true, human_approved: true }];
  const appByJob = new Map(productionApplications(apps).map((a) => [a.job_id, a]));
  check("the job looks unprepared, so a real application gets created",
    appByJob.get("j1") === undefined, JSON.stringify([...appByJob]));
}

console.log("\n11. a fixture cannot be selected for requested submission:");
{
  // The requested path needs only submit_requested_at + human_approved +
  // all_fields_confident. This is the fixture that would have been sent.
  const apps = [
    { id: "fixture", job_id: "j1", is_test: true, human_approved: true,
      all_fields_confident: true, submit_requested_at: "2026-09-02T00:00:00Z", submitted_at: null },
    { id: "real", job_id: "j2", is_test: false, human_approved: true,
      all_fields_confident: true, submit_requested_at: "2026-09-02T00:00:00Z", submitted_at: null },
  ];
  const requested = new Set(productionApplications(apps)
    .filter((a) => a.submit_requested_at && !a.submitted_at).map((a) => a.id));
  check("the armed fixture is not in the requested set", !requested.has("fixture"), JSON.stringify([...requested]));
  check("the real armed application still is", requested.has("real"));
  check("isolation holds even when the fixture is fully armed",
    !isProductionApplication(apps[0]!) && isProductionApplication(apps[1]!));
}

console.log("\n12. human-approved fixtures are inert:");
{
  // Thirteen of these exist. Approval on a fixture must mean nothing.
  const fixtures = Array.from({ length: 13 }, (_, i) => ({
    id: `f${i}`, job_id: `j${i}`, is_test: true, human_approved: true,
    all_fields_confident: true, submit_requested_at: "2026-09-02T00:00:00Z", submitted_at: null,
  }));
  check("none reach the production set", productionApplications(fixtures).length === 0);
  check("none reach the requested set",
    productionApplications(fixtures).filter((a) => a.submit_requested_at).length === 0);
  check("none contribute an already-applied opening",
    productionApplications(fixtures).length === 0);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("the worker acts on the current verdict, and never on a fixture");
