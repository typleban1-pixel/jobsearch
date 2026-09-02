/**
 * The Jobs feed's default view, and what it is allowed to hide.
 *
 * Candidacy exists to shrink the pile. A REJECT shown beside the jobs
 * still needing a decision spends attention on work already done. These
 * pin the presentation rules without touching a verdict.
 */
import { applyFilters, DEFAULT_FILTERS, type Filters } from "../lib/portal/present.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

const card = (id: string, verdict: string | null, interest: "SAVED" | "NOT_INTERESTED" | null = null): any => ({
  id, title: `job ${id}`, company: "Co", locations: [], creditedCount: 9,
  uncertainty: 0, salaryMin: 100, salaryMax: 200, recommendation: "STRETCH",
  activeInterest: interest,
  candidacy: verdict ? { verdict, label: verdict === "REJECT" ? "NOT A CANDIDATE" : verdict } : null,
});

const cards = [
  card("cand", "APPLICATION_CANDIDATE"),
  card("stretch", "STRETCH"),
  card("review", "MANUAL_REVIEW"),
  card("reject1", "REJECT"),
  card("reject2", "REJECT"),
  card("unscored", null),
];
const f = (over: Partial<Filters>): Filters => ({ ...DEFAULT_FILTERS, ...over });
const ids = (rows: any[]) => rows.map((r) => r.id).sort().join(",");

check("the default feed hides REJECT",
  ids(applyFilters(cards, DEFAULT_FILTERS)) === "cand,review,stretch,unscored",
  ids(applyFilters(cards, DEFAULT_FILTERS)));

check("the default keeps Candidate, Stretch and Manual Review",
  ["cand", "stretch", "review"].every((id) => applyFilters(cards, DEFAULT_FILTERS).some((c) => c.id === id)), "");

// Unscored is not rejected. Hiding it would bury the jobs most in need
// of a decision.
check("a job with no candidacy row stays visible by default",
  applyFilters(cards, DEFAULT_FILTERS).some((c) => c.id === "unscored"), "");

check("the skipped view shows only REJECT",
  ids(applyFilters(cards, f({ candidacy: "skipped" }))) === "reject1,reject2",
  ids(applyFilters(cards, f({ candidacy: "skipped" }))));

check("the everything view shows all six",
  applyFilters(cards, f({ candidacy: "all" })).length === 6, "");

// The model's decision and Ty's decision are different facts.
{
  const mixed = [card("systemSkip", "REJECT"), card("mine", "STRETCH", "NOT_INTERESTED")];
  const skipped = applyFilters(mixed, f({ candidacy: "skipped", interest: "all" }));
  check("\"skipped by system\" does not include a job Ty marked not interested",
    ids(skipped) === "systemSkip", ids(skipped));
  const dismissed = applyFilters(mixed, f({ interest: "dismissed", candidacy: "all" }));
  check("\"not interested\" does not include a job the model skipped",
    ids(dismissed) === "mine", ids(dismissed));
}

// Counts drive pagination, so the filtered length is the number that matters.
check("the filtered count excludes hidden REJECTs",
  applyFilters(cards, DEFAULT_FILTERS).length === 4,
  String(applyFilters(cards, DEFAULT_FILTERS).length));

// Presentation only: the stored verdict is untouched.
check("the stored verdict is still REJECT behind the label",
  cards.find((c) => c.id === "reject1")!.candidacy.verdict === "REJECT", "");
check("and the badge shown reads NOT A CANDIDATE",
  cards.find((c) => c.id === "reject1")!.candidacy.label === "NOT A CANDIDATE", "");

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
