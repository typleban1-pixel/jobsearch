/**
 * A crash must never buy the same batch twice.
 *
 *   node scripts/batch-state-selftest.ts
 *
 * The Message Batches create endpoint has no client-supplied idempotency
 * key. Every assertion here defends the consequence: an unknown create
 * outcome is a state we can represent and refuse to act on, not one we
 * guess our way out of.
 */
import { maySubmit, needsHuman, isTerminal, resolveStalled, identityKey, customIdFor,
         intentKeyFor, planAgainstLive, fromProviderStatus, couldBeOrphan,
         BATCH_STATES, type BatchState, type RequestIdentity } from "../lib/llm/batchState.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};
const id = (o: Partial<RequestIdentity> = {}): RequestIdentity =>
  ({ jobId: "j1", descriptionHash: "H1", extractionVersion: 4, schemaVersion: 1, attempt: 1, ...o });

console.log("\n1. only a PLANNED batch may be submitted unattended:");
{
  check("PLANNED may submit", maySubmit("PLANNED"));
  for (const s of BATCH_STATES.filter((x) => x !== "PLANNED")) {
    check(`  ${s} may NOT`, !maySubmit(s as BatchState));
  }
}

console.log("\n2. the ambiguous window:");
{
  // The exact sequence: intent written, create sent, process dies.
  const r = resolveStalled("SUBMITTING");
  check("a stalled SUBMITTING becomes AMBIGUOUS", r?.status === "AMBIGUOUS", JSON.stringify(r));
  check("with a reason naming the missing idempotency key",
    /idempotency key/.test(r?.reason ?? ""), r?.reason ?? "");
  check("AMBIGUOUS needs a human", needsHuman("AMBIGUOUS"));
  check("and may not be resubmitted automatically", !maySubmit("AMBIGUOUS"));
  check("it is NOT terminal, because the work may still be owed", !isTerminal("AMBIGUOUS"));
  check("nothing else stalls into AMBIGUOUS", resolveStalled("PLANNED") === null && resolveStalled("SUBMITTED") === null);
  // The failure this whole design exists to prevent.
  check("a null provider id is never treated as proof of non-submission",
    !maySubmit("SUBMITTING") && !maySubmit("AMBIGUOUS"));
}

console.log("\n3. request identity is durable across batches:");
{
  check("the same job+hash+versions+attempt is one identity",
    identityKey(id()) === identityKey(id()));
  check("a different job is a different identity",
    identityKey(id()) !== identityKey(id({ jobId: "j2" })));
  check("the SAME text on a different job is a different identity",
    identityKey(id({ jobId: "j1" })) !== identityKey(id({ jobId: "j2" })));
  check("a new extraction version is a different identity",
    identityKey(id()) !== identityKey(id({ extractionVersion: 5 })));
  check("a new schema version is a different identity",
    identityKey(id()) !== identityKey(id({ schemaVersion: 2 })));
  check("a retry is a different identity",
    identityKey(id()) !== identityKey(id({ attempt: 2 })));
  // The provider's constraint: 64 chars of [a-zA-Z0-9_-].
  const cid = customIdFor(id());
  check("custom_id fits the API limit", cid.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(cid), cid);
  check("and is deterministic", cid === customIdFor(id()));
  check("distinct identities give distinct custom_ids", customIdFor(id()) !== customIdFor(id({ attempt: 2 })));
}

console.log("\n4. work already in flight is never planned again:");
{
  const wanted = [id({ jobId: "a" }), id({ jobId: "b" }), id({ jobId: "c" })];
  const live = [{ identity: id({ jobId: "b" }), status: "PENDING" }];
  const { plan, heldBack } = planAgainstLive(wanted, live);
  check("the live one is held back", heldBack.length === 1 && heldBack[0]!.jobId === "b");
  check("the others are planned", plan.length === 2);
  check("nothing is both planned and held back",
    !plan.some((p) => heldBack.some((h) => identityKey(p) === identityKey(h))));
}

console.log("\n5. a terminal request may be retried, but only as a new attempt:");
{
  const wanted = [id({ jobId: "a" })];
  for (const st of ["FAILED", "EXPIRED", "CANCELLED", "SUCCEEDED"]) {
    const { plan } = planAgainstLive(wanted, [{ identity: id({ jobId: "a" }), status: st }]);
    check(`a ${st} request does not block re-planning`, plan.length === 1, st);
  }
  // But the same attempt number is the same identity, so a retry must
  // increment it -- that is what makes the retry visible.
  const retry = id({ jobId: "a", attempt: 2 });
  check("the retry is a distinct identity", identityKey(retry) !== identityKey(id({ jobId: "a" })));
  const { heldBack } = planAgainstLive([id({ jobId: "a" })], [{ identity: id({ jobId: "a" }), status: "PENDING" }]);
  check("and a PENDING one still blocks", heldBack.length === 1);
}

console.log("\n6. the intent key is deterministic and order-independent:");
{
  const a = [id({ jobId: "x" }), id({ jobId: "y" })];
  const b = [id({ jobId: "y" }), id({ jobId: "x" })];
  check("the same set in any order is the same key", intentKeyFor(a) === intentKeyFor(b));
  check("a different set is a different key", intentKeyFor(a) !== intentKeyFor([id({ jobId: "x" })]));
  check("re-planning the same work yields the same key, so it is refused as a duplicate",
    intentKeyFor(a) === intentKeyFor([...a]));
}

console.log("\n7. provider status mapping:");
{
  check("in_progress -> PROCESSING", fromProviderStatus("in_progress", false) === "PROCESSING");
  check("canceling -> PROCESSING, not CANCELLED", fromProviderStatus("canceling", false) === "PROCESSING");
  check("ended with results reconciled -> COMPLETED", fromProviderStatus("ended", true) === "COMPLETED");
  check("ended before reconciliation stays PROCESSING", fromProviderStatus("ended", false) === "PROCESSING");
}

console.log("\n8. orphan matching is evidence, never a decision:");
{
  const intent = { requestCount: 20, submittingAt: "2026-09-02T12:00:00Z" };
  const counts = (processing: number) => ({ processing, succeeded: 0, errored: 0, canceled: 0, expired: 0 });
  check("same size, same minute -> a candidate",
    couldBeOrphan(intent, { created_at: "2026-09-02T12:00:30Z", request_counts: counts(20) }));
  check("a different request count is not this batch",
    !couldBeOrphan(intent, { created_at: "2026-09-02T12:00:30Z", request_counts: counts(19) }));
  check("far outside the window is not a candidate",
    !couldBeOrphan(intent, { created_at: "2026-09-02T14:00:00Z", request_counts: counts(20) }));
  check("a batch created just BEFORE the attempt is still considered",
    couldBeOrphan(intent, { created_at: "2026-09-02T11:59:30Z", request_counts: counts(20) }));
  // Two batches of the same size in the window are indistinguishable,
  // which is precisely why this cannot decide.
  const a = couldBeOrphan(intent, { created_at: "2026-09-02T12:00:10Z", request_counts: counts(20) });
  const b = couldBeOrphan(intent, { created_at: "2026-09-02T12:00:20Z", request_counts: counts(20) });
  check("two same-size batches both match, so a person must choose", a && b);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("an unknown create outcome stops; it is never guessed");
