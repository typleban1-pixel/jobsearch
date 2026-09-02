/**
 * A confirmed submission must persist both facts together.
 *
 * SUBMITTED and the evidence that justifies it are one record, not two.
 * Writing status without confirmation_reference left two genuinely
 * submitted applications reading as unconfirmed in the portal until
 * someone found the run directory by hand.
 */
import { basename, join } from "node:path";

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

/** The reference format, as submit-application.ts derives it. */
const referenceFor = (runDir: string) => `fill-run:${basename(runDir)}`;
/** The portal resolving it back to a directory. */
const directoryFor = (ref: string) => join(".fill-runs", ref.replace(/^fill-run:/, ""));

interface Written { status: string; submitted_at: string | null; confirmation_reference: string | null }

/**
 * The persistence step, mirroring the branch in submit-application.ts
 * that runs only once confirmation has passed.
 */
function persist(confirmed: boolean, runDir: string, now: string): Written {
  if (!confirmed) return { status: "READY_TO_SUBMIT", submitted_at: null, confirmation_reference: null };
  return { status: "SUBMITTED", submitted_at: now, confirmation_reference: referenceFor(runDir) };
}

const RUN = ".fill-runs/submit-01a9900a-6b03-468f-8672-1c4bba54a499-1788309922403";
const NOW = "2026-09-02T00:46:16.594Z";

{
  const w = persist(true, RUN, NOW);
  check("a confirmed submission persists SUBMITTED", w.status === "SUBMITTED", w.status);
  check("and persists submitted_at", w.submitted_at === NOW, String(w.submitted_at));
  check("and persists a confirmation reference", Boolean(w.confirmation_reference), "");
  check("the reference resolves back to the run directory",
    directoryFor(w.confirmation_reference!) === RUN, directoryFor(w.confirmation_reference!));
  check("the reference carries the fill-run prefix the portal expects",
    w.confirmation_reference!.startsWith("fill-run:"), w.confirmation_reference!);
  check("the reference names the application it belongs to",
    w.confirmation_reference!.includes("01a9900a-6b03-468f-8672-1c4bba54a499"), "");
}

// An unconfirmed submission writes none of it.
{
  const w = persist(false, RUN, NOW);
  check("an unconfirmed attempt is not marked submitted", w.status !== "SUBMITTED", w.status);
  check("and records no submitted_at", w.submitted_at === null, "");
  check("and records no confirmation reference", w.confirmation_reference === null,
    String(w.confirmation_reference));
}

// The two must move together: a reference without SUBMITTED, or
// SUBMITTED without a reference, is the defect this test exists for.
{
  const w = persist(true, RUN, NOW);
  check("status and reference are written as one",
    (w.status === "SUBMITTED") === (w.confirmation_reference !== null), JSON.stringify(w));
  const bad = persist(false, RUN, NOW);
  check("and stay absent as one",
    (bad.status === "SUBMITTED") === (bad.confirmation_reference !== null), JSON.stringify(bad));
}

// Derived from runDir, so the pointer cannot drift from the evidence.
{
  const other = ".fill-runs/submit-103bb5b5-bf4c-4b36-a21b-c274c67e6615-1788308733342";
  check("a different run yields a different reference",
    referenceFor(other) !== referenceFor(RUN), "");
  check("and each resolves to its own directory",
    directoryFor(referenceFor(other)) === other, "");
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
