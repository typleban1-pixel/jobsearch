/**
 * Deduplication must be exact, or it must not happen.
 *
 *   node scripts/extraction-dedup-selftest.ts
 *
 * The whole justification for sharing an extraction is that the input is
 * byte-identical, so the model could only have returned the same answer.
 * Every assertion here defends that: same hash shares, anything else
 * does not, and a changed description stops reuse.
 */
import { planExtraction, reuseStillValid, dedupSavings, EMPTY_SHA256, type DedupJob } from "../lib/llm/extractionDedup.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};
const j = (id: string, h: string | null): DedupJob => ({ id, descriptionHash: h });

console.log("\n1. identical descriptions share one extraction:");
{
  const p = planExtraction([j("a", "H1"), j("b", "H1"), j("c", "H1")]);
  check("one call, not three", p.leaders.length === 1, JSON.stringify(p.leaders.map((x) => x.id)));
  check("two reuse it", p.reused === 2);
  check("the leader is deterministic", p.leaders[0]!.id === "a");
  check("and the followers are the rest",
    p.followers.get("a")!.map((x) => x.id).join(",") === "b,c");
}

console.log("\n2. different descriptions never share:");
{
  const p = planExtraction([j("a", "H1"), j("b", "H2"), j("c", "H3")]);
  check("three calls", p.leaders.length === 3);
  check("nothing reused", p.reused === 0);
  check("no follower groups", p.followers.size === 0);
}

console.log("\n3. a missing hash is never a follower:");
{
  const p = planExtraction([j("a", null), j("b", null), j("c", "H1")]);
  check("both hashless jobs are extracted separately", p.leaders.length === 3, JSON.stringify(p.leaders.map((x) => x.id)));
  check("absence of a hash is not sameness", p.reused === 0);
}

console.log("\n3b. an EMPTY description is never a group:");
{
  // The live defect: 19 jobs with zero-length descriptions all hashed to
  // sha256("") and were grouped as identical. They are not the same
  // posting; they have no posting.
  const p = planExtraction([j("a", EMPTY_SHA256), j("b", EMPTY_SHA256), j("c", EMPTY_SHA256)]);
  check("three descriptionless jobs are three leaders", p.leaders.length === 3, JSON.stringify(p.leaders.map((x) => x.id)));
  check("none is a follower", p.reused === 0);
  check("an empty hash never forms a follower group", p.followers.size === 0);
  // Mixed with real text.
  const q = planExtraction([j("a", EMPTY_SHA256), j("b", "H1"), j("c", "H1")]);
  check("real duplicates still group alongside empties", q.reused === 1 && q.leaders.length === 2, JSON.stringify(q.leaders.map((x) => x.id)));
  check("reuse recorded against an empty hash is never valid",
    reuseStillValid({ followerHash: EMPTY_SHA256, sourceHash: EMPTY_SHA256, hashAtReuse: EMPTY_SHA256 }) === false);
}

console.log("\n4. ordering does not change the plan:");
{
  const base = [j("c", "H1"), j("a", "H1"), j("b", "H2"), j("d", "H1")];
  const perms: DedupJob[][] = [];
  const permute = (a: DedupJob[], cur: DedupJob[] = []) => {
    if (!a.length) { perms.push(cur); return; }
    a.forEach((x, i) => permute([...a.slice(0, i), ...a.slice(i + 1)], [...cur, x]));
  };
  permute(base);
  const answers = new Set(perms.map((pp) => {
    const p = planExtraction(pp);
    return JSON.stringify([p.leaders.map((x) => x.id).sort(), [...p.followers].map(([k, v]) => [k, v.map((x) => x.id).sort()]).sort()]);
  }));
  check(`all ${perms.length} orderings agree`, answers.size === 1, `${answers.size} distinct plans`);
  check("and 'a' always leads the H1 group", JSON.parse([...answers][0]!)[1][0][0] === "a");
}

console.log("\n5. every job is accounted for exactly once:");
{
  const pool = [j("a", "H1"), j("b", "H1"), j("c", null), j("d", "H2"), j("e", "H2"), j("f", "H2")];
  const p = planExtraction(pool);
  const covered = [...p.leaders.map((x) => x.id), ...[...p.followers.values()].flat().map((x) => x.id)];
  check("no job is lost", covered.length === pool.length, `${covered.length} vs ${pool.length}`);
  check("and none is duplicated", new Set(covered).size === covered.length);
  check("calls = distinct hashes + hashless jobs", p.leaders.length === 3, String(p.leaders.length));
}

console.log("\n6. a changed description stops reuse:");
{
  check("unchanged on both sides is valid",
    reuseStillValid({ followerHash: "H1", sourceHash: "H1", hashAtReuse: "H1" }) === true);
  check("the follower's description changed -> invalid",
    reuseStillValid({ followerHash: "H2", sourceHash: "H1", hashAtReuse: "H1" }) === false);
  check("the SOURCE's description changed -> invalid",
    reuseStillValid({ followerHash: "H1", sourceHash: "H2", hashAtReuse: "H1" }) === false);
  check("a null hash anywhere -> invalid",
    reuseStillValid({ followerHash: null, sourceHash: "H1", hashAtReuse: "H1" }) === false);
  // And the plan re-extracts it, because it no longer groups with the others.
  const p = planExtraction([j("a", "H1"), j("b", "H2")]);
  check("a job whose hash moved is extracted on its own", p.leaders.length === 2 && p.reused === 0);
}

console.log("\n7. the arithmetic of the saving:");
{
  const p = planExtraction([j("a", "H1"), j("b", "H1"), j("c", "H1"), j("d", "H2")]);
  const s = dedupSavings(p, 0.0129);
  check("4 jobs would have cost 4 calls", Math.abs(s.without - 4 * 0.0129) < 1e-9);
  check("dedup makes it 2", Math.abs(s.withDedup - 2 * 0.0129) < 1e-9);
  check("saving is exactly the avoided calls", Math.abs(s.saved - 2 * 0.0129) < 1e-9);
  check("ratio is 0.5", Math.abs(s.ratio - 0.5) < 1e-9);
}

console.log("\n8. degenerate inputs:");
{
  check("an empty pool plans nothing", planExtraction([]).leaders.length === 0);
  const one = planExtraction([j("a", "H1")]);
  check("a single job is a leader with no followers", one.leaders.length === 1 && one.reused === 0);
  check("a group of one creates no follower entry", one.followers.size === 0);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("only byte-identical descriptions share an extraction");
