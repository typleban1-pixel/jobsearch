/**
 * Merging the same job across two boards, and refusing to merge two jobs.
 *
 *   node scripts/cross-source-selftest.ts
 *
 * A duplicate costs an inflated count. A wrong merge costs applying to
 * one employer twice for one role, or losing a real second opening, so
 * nearly everything here asserts a refusal.
 */
import { sameOpening, groupDuplicates, preferred, type Candidate } from "../lib/ingest/crossSource.ts";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

const job = (over: Partial<Candidate> = {}): Candidate => ({
  jobId: Math.random().toString(36).slice(2),
  companyId: "acme", source: "GREENHOUSE",
  title: "Marketing Manager", cities: ["chicago"], remote: false,
  postedAt: "2026-09-01T00:00:00Z", contentHash: null, ...over,
});

console.log("the same job on two boards");
{
  const a = job({ source: "GREENHOUSE" });
  const b = job({ source: "WORKDAY" });
  const v = sameOpening(a, b);
  check("merges across sources", v.same, v.because);
}
{
  const a = job({ source: "GREENHOUSE", cities: [], remote: true });
  const b = job({ source: "WORKDAY", cities: [], remote: true });
  check("two remote postings of one role merge", sameOpening(a, b).same);
}
{
  const a = job({ source: "GREENHOUSE", cities: ["boston"], contentHash: "abc" });
  const b = job({ source: "WORKDAY", cities: ["denver"], contentHash: "abc" });
  check("an identical description settles it regardless of city", sameOpening(a, b).same);
}

console.log("\nwhat must never merge");
const refuse: Array<[string, Candidate, Candidate, RegExp]> = [
  ["different employers", job(), job({ companyId: "other", source: "WORKDAY" }), /different employers/],
  ["a seniority difference is a different job",
    job(), job({ source: "WORKDAY", title: "Senior Marketing Manager" }), /different roles/],
  ["a discipline difference",
    job(), job({ source: "WORKDAY", title: "Product Manager" }), /different roles/],
  ["different cities, neither remote",
    job({ cities: ["chicago"] }), job({ source: "WORKDAY", cities: ["austin"] }), /no shared location/],
  ["posted far apart",
    job({ postedAt: "2026-01-01T00:00:00Z" }),
    job({ source: "WORKDAY", postedAt: "2026-09-01T00:00:00Z" }), /days apart/],
  ["neither states a location",
    job({ cities: [] }), job({ source: "WORKDAY", cities: [] }), /cannot be established/],
  ["the same board is left to within-board grouping",
    job(), job({ source: "GREENHOUSE" }), /same board/],
];
for (const [what, a, b, why] of refuse) {
  const v = sameOpening(a, b);
  check(what, !v.same && why.test(v.because), v.because);
}

console.log("\nwhich survivor is kept");
{
  const gh = job({ source: "GREENHOUSE" }), wd = job({ source: "WORKDAY" });
  check("the one that can be applied to wins", preferred([wd, gh]).source === "GREENHOUSE");
  const ash = job({ source: "ASHBY" }), lev = job({ source: "LEVER" });
  check("Lever beats Ashby today", preferred([ash, lev]).source === "LEVER");
  const older = job({ source: "WORKDAY", postedAt: "2026-01-01T00:00:00Z" });
  const newer = job({ source: "WORKDAY", postedAt: "2026-08-01T00:00:00Z" });
  check("ties break to the older record", preferred([newer, older]).postedAt === "2026-01-01T00:00:00Z");
}

console.log("\ngrouping a mixed corpus");
{
  const a = job({ jobId: "a", source: "GREENHOUSE" });
  const b = job({ jobId: "b", source: "WORKDAY" });
  const c = job({ jobId: "c", source: "WORKDAY", title: "Data Analyst" });
  const d = job({ jobId: "d", companyId: "other", source: "WORKDAY" });
  const groups = groupDuplicates([a, b, c, d]);
  check("one duplicate set is found", groups.length === 1, String(groups.length));
  check("it keeps the applicable one", groups[0]?.keep.jobId === "a", groups[0]?.keep.jobId);
  check("and marks exactly one duplicate", groups[0]?.duplicates.length === 1);
  check("the unrelated role is untouched", !groups.some(g => g.duplicates.some(x => x.jobId === "c")));
  check("the other employer is untouched", !groups.some(g => g.duplicates.some(x => x.jobId === "d")));
}

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
