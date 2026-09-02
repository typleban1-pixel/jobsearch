/**
 * One upsert shape per statement.
 *
 *   node scripts/touch-rows-selftest.ts
 *
 * The production failure, exactly: ingest died with
 *
 *   null value in column "status" of relation "jobs" violates not-null
 *   constraint | code: 23502
 *
 * on a job that already existed and was already OPEN. jobs.status is
 * `not null default 'OPEN'`, so an OMITTED column would have been fine.
 * It was not omitted. PostgREST sends a batch as one
 * INSERT ... ON CONFLICT whose column list is the UNION of the keys
 * across its rows, so one reappeared job in the batch put `status` into
 * the statement and every row that lacked it was sent an explicit NULL,
 * which overrides the default. Postgres checks NOT NULL on the proposed
 * tuple before resolving the conflict, so the whole statement died.
 *
 * The invariant these tests hold: within any batch, the union of keys
 * equals the key set of every row in it.
 */
import { touchBatches, batchColumns, openRow, reappearedRow, isReappearing } from "../lib/db/touchRows.ts";
import type { JobWriteInput } from "../lib/db/store.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};

const AT = "2026-09-02T18:15:56.825Z";
const input = (id: string, status: string): JobWriteInput => ({
  companyId: "c1", source: "WORKDAY", runId: "r", fetchId: "f",
  normalized: { sourceJobId: `ext-${id}`, title: `Job ${id}` } as any,
  raw: {}, contentHash: "h", descriptionHash: "d", rawFragmentHash: "rf",
  normalizerVersion: 1, fetcherVersion: 1, fetchedAt: AT,
  existing: { id, status, has_payload: true, current_version_id: "v", current_version_number: 1 } as any,
});

/** Every column the jobs table declares NOT NULL and a touch may send. */
const NOT_NULL = ["company_id", "external_id", "source", "title", "status"];

/** The property the old code violated. */
const homogeneous = (batches: ReturnType<typeof touchBatches>) =>
  batches.every((b) => {
    const union = batchColumns(b).join(",");
    return b.rows.every((r) => Object.keys(r).sort().join(",") === union);
  });
/** No row may send an explicit null for a NOT NULL column. */
const noExplicitNulls = (batches: ReturnType<typeof touchBatches>) =>
  batches.every((b) => b.rows.every((r) =>
    NOT_NULL.every((c) => !(c in r) || (r as any)[c] !== null && (r as any)[c] !== undefined)));

console.log("\n1. only unchanged OPEN jobs:");
{
  const b = touchBatches([input("a", "OPEN"), input("b", "OPEN"), input("c", "OPEN")]);
  check("one batch", b.length === 1, JSON.stringify(b.map((x) => [x.shape, x.rows.length])));
  check("shaped OPEN", b[0]!.shape === "OPEN");
  check("status is not a column at all", !batchColumns(b[0]!).includes("status"), batchColumns(b[0]!).join(","));
  check("so the default applies and nothing is nulled", noExplicitNulls(b));
  check("homogeneous", homogeneous(b));
}

console.log("\n2. only reappeared jobs:");
{
  const b = touchBatches([input("a", "CLOSED"), input("b", "ARCHIVED")]);
  check("one batch", b.length === 1);
  check("shaped REAPPEARED", b[0]!.shape === "REAPPEARED");
  check("every row carries status", b[0]!.rows.every((r: any) => r.status === "OPEN"));
  check("every row carries the change timestamp", b[0]!.rows.every((r: any) => r.status_changed_at === AT));
  check("and the reason", b[0]!.rows.every((r: any) => r.closed_detection_reason === "reappeared on board"));
  check("homogeneous", homogeneous(b));
}

console.log("\n3. THE PRODUCTION FAILURE: unchanged + reappeared in one batch:");
{
  const inputs = [input("open1", "OPEN"), input("back", "CLOSED"), input("open2", "OPEN")];
  const b = touchBatches(inputs);
  check("they are split into two statements", b.length === 2, JSON.stringify(b.map((x) => [x.shape, x.rows.length])));
  check("no batch mixes shapes", homogeneous(b));
  check("no NOT NULL column is ever sent as null", noExplicitNulls(b));
  const openBatch = b.find((x) => x.shape === "OPEN")!;
  check("the OPEN batch has no status column, so no row can be nulled",
    !batchColumns(openBatch).includes("status"), batchColumns(openBatch).join(","));
  check("the OPEN batch holds both unchanged jobs", openBatch.rows.length === 2);
  const reBatch = b.find((x) => x.shape === "REAPPEARED")!;
  check("the reappeared job is alone in its batch", reBatch.rows.length === 1);

  // What the old code did, reproduced, to show the test would have caught it.
  const oldRows = inputs.map((u) => isReappearing(u) ? reappearedRow(u) : openRow(u));
  const oldUnion = [...new Set(oldRows.flatMap((r) => Object.keys(r)))];
  const wouldNull = oldRows.filter((r) => oldUnion.some((c) => NOT_NULL.includes(c) && !(c in r)));
  check("the old single-batch shape would have nulled 2 rows' status",
    oldUnion.includes("status") && wouldNull.length === 2, `${wouldNull.length}`);
}

console.log("\n4. across the 500-row slicing boundary:");
{
  // 501 unchanged with a reappearance in the middle: the mixed case AND
  // the chunk boundary at once.
  const inputs = [
    ...Array.from({ length: 250 }, (_, i) => input(`o${i}`, "OPEN")),
    input("back", "CLOSED"),
    ...Array.from({ length: 251 }, (_, i) => input(`p${i}`, "OPEN")),
  ];
  const b = touchBatches(inputs);
  check("501 open rows split into two batches plus one reappeared batch",
    b.length === 3, JSON.stringify(b.map((x) => [x.shape, x.rows.length])));
  check("no batch exceeds 500 rows", b.every((x) => x.rows.length <= 500));
  check("every batch is homogeneous", homogeneous(b));
  check("no NOT NULL column is sent as null anywhere", noExplicitNulls(b));
  check("every input is written exactly once",
    b.reduce((n, x) => n + x.rows.length, 0) === 502);
  const ids = b.flatMap((x) => x.rows.map((r: any) => r.id));
  check("and no id appears twice", new Set(ids).size === ids.length);
  // Exactly one reappearance, wherever it sat in the input.
  const withStatus = b.flatMap((x) => x.rows).filter((r: any) => "status" in r);
  check("exactly one row carries status", withStatus.length === 1 && (withStatus[0] as any).id === "back");
}

console.log("\n5. an unchanged OPEN job keeps its status metadata:");
{
  const [b] = touchBatches([input("a", "OPEN")]);
  const r = b!.rows[0] as any;
  check("status is not resent", !("status" in r));
  check("status_changed_at is not manufactured", !("status_changed_at" in r), JSON.stringify(r));
  check("closed_detection_reason is not rewritten", !("closed_detection_reason" in r));
  check("but last_seen_at is refreshed", r.last_seen_at === AT);
  check("and the missing-check counter is reset", r.consecutive_missing_checks === 0);
}

console.log("\n6. a reappeared job transitions properly:");
{
  const [b] = touchBatches([input("a", "CLOSED")]);
  const r = b!.rows[0] as any;
  check("it becomes OPEN", r.status === "OPEN");
  check("with the fetch time as the change time", r.status_changed_at === AT);
  check("and a reason naming the reappearance", r.closed_detection_reason === "reappeared on board");
}

console.log("\n7. posting data is not rewritten beyond identity and freshness:");
{
  const [b] = touchBatches([input("a", "OPEN")]);
  const keys = Object.keys(b!.rows[0]!).sort();
  check("only identity and freshness columns are written",
    keys.join(",") === ["company_id", "consecutive_missing_checks", "external_id", "id",
                        "last_seen_at", "last_seen_open_at", "source", "title"].join(","), keys.join(","));
  check("no description, salary, location or eligibility column is touched",
    !keys.some((k) => /descri|salary|location|eligib|remote|seniority|extracted/.test(k)));
}

console.log("\n8. idempotence:");
{
  const inputs = [input("a", "OPEN"), input("back", "CLOSED"), input("b", "OPEN")];
  const first = JSON.stringify(touchBatches(inputs));
  const again = JSON.stringify(touchBatches(inputs));
  check("the same inputs produce the same batches", first === again);
  // The second real run sees the reappeared job as OPEN, because the
  // first run set it. It must then take the ordinary path.
  const afterFirstRun = [input("a", "OPEN"), input("back", "OPEN"), input("b", "OPEN")];
  const b2 = touchBatches(afterFirstRun);
  check("on the next run the reappeared job is an ordinary touch",
    b2.length === 1 && b2[0]!.shape === "OPEN", JSON.stringify(b2.map((x) => x.shape)));
  check("so it is not given a second status_changed_at",
    b2[0]!.rows.every((r: any) => !("status_changed_at" in r)));
}

console.log("\n9. an empty input writes nothing:");
check("no batches at all", touchBatches([]).length === 0);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("one shape per statement; no required column can be nulled");
