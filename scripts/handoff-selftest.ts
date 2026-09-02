/**
 * The four handoff fixes, held in place.
 *
 * All four came out of one real failure. Popl was prepared on Ashby, the
 * portal showed a "Continue on Ashby" card, and the card went to the
 * internal review page instead of to Ashby. Then the system opened the
 * real Ashby form, filled part of it, a person finished and submitted
 * it, and nothing in the database recorded that the form had ever been
 * opened.
 *
 *   1. A button named after the employer goes to the employer.
 *   2. The summary says what is actually true for THIS provider.
 *   3. A fill that touched an employer form is recorded, including what
 *      was uploaded and whether an irreversible submit was attempted.
 *   4. An employer-form handoff is not "cleared" by having no blocked
 *      questions left, because the questions were never what blocked it.
 *
 * These are pure functions, so this needs no database and no browser.
 *
 *   node scripts/handoff-selftest.ts
 */
import { present, type ApplicationFacts } from "../lib/portal/presentationState.ts";
import { firstSentenceOf } from "../lib/portal/applyBoard.ts";
import { staleBlockedStatus, isEmployerFormHandoff } from "../lib/portal/answerCompleteness.ts";
import { startFillRun, fillRunRecord, fillRunEventDetail, fillRunEventName } from "../lib/applications/fillRun.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

const APP = "a5140308-3f1d-42dc-bb20-7d914ecc401f";
const facts = (over: Partial<ApplicationFacts> = {}): ApplicationFacts => ({
  status: "BLOCKED_NEEDS_INPUT",
  humanApproved: true,
  allFieldsConfident: false,
  blockedAnswers: 0,
  submittedAt: null,
  confirmationReceived: false,
  provider: "ASHBY",
  refusals: [],
  handoff: true,
  ...over,
});

// ============================================================
// 1. The employer's button goes to the employer
// ============================================================
console.log("\nfix 1: the action goes where it says it goes");
{
  const url = "https://jobs.ashbyhq.com/popl/some-role/application";
  const p = present(facts({ applyUrl: url }), APP);
  check("a handoff card links to the employer's form", p.action?.href === url, p.action?.href ?? "no action");
  check("and it is not the internal review page",
    !String(p.action?.href ?? "").includes("/review"), p.action?.href ?? "");
  check("the label names the employer's system", /Ashby/.test(p.action?.label ?? ""), p.action?.label ?? "");
}
{
  // The regression this replaced: without a URL there is nothing to link
  // to, and the internal page is the honest fallback rather than a
  // button that lies about where it goes.
  const p = present(facts({ applyUrl: null }), APP);
  check("with no employer URL, the label stops claiming to be the employer",
    !/Continue on/.test(p.action?.label ?? ""), p.action?.label ?? "");
  check("and it falls back to a real internal page",
    String(p.action?.href ?? "").includes(APP), p.action?.href ?? "");
}

// ============================================================
// 2. The summary is true for this provider
// ============================================================
console.log("\nfix 2: the summary says what is actually true");
{
  const reason = "ASHBY_HANDOFF: Ashby's form cannot be read before opening it, so the questions are not known in advance.";
  const p = present(facts({ handoffReason: reason, applyUrl: "https://x.test/a" }), APP);
  check("the provider's own reason leads the summary",
    p.summary.startsWith("ASHBY_HANDOFF") || p.summary.includes("cannot be read"), p.summary);
  check("the summary does not invent blocked questions",
    !/\d+ question/.test(p.summary), p.summary);
}
{
  const p = present(facts({ handoffReason: null, provider: "WORKDAY", applyUrl: "https://x.test/a" }), APP);
  check("with no reason recorded it still names the right system",
    /Workday/.test(p.summary), p.summary);
}

// ============================================================
// 2b. The reason survives contact with the real stored text
// ============================================================
//
// The first version of fix 2 passed its tests and was still wrong on
// every real record, because the tests used a tidy one-line reason and
// prepare-handoff writes a hard-wrapped paragraph. This is the exact
// text stored on the Northern Trust application, newlines and all.
console.log("\nfix 2b: the real, hard-wrapped reason text");
{
  const REAL = `HANDOFF: Workday does not publish its application form, so the questions cannot be read or
answered before a person opens it. Workday's form sits behind an account sign-in.
No questions have been guessed and no answers invented.
Apply at: https://ntrs.wd1.myworkdayjobs.com/northerntrust/job/Chicago-IL/Program-Manager_R159624`;

  const got = firstSentenceOf(REAL);
  check("the sentence is read across the wrapped lines",
    got === "Workday does not publish its application form, so the questions cannot be read or answered before a person opens it.",
    String(got));
  check("it is a whole sentence, not a fragment ending mid-clause",
    got !== null && /[.!?]$/.test(got) && !/\bor$/.test(got), String(got));
  check("the internal HANDOFF prefix never reaches a reader",
    got !== null && !/HANDOFF/i.test(got), String(got));
  check("the apply URL is not dragged into the summary",
    got !== null && !got.includes("http"), String(got));

  // Every prefix prepare-handoff and the providers actually write.
  for (const prefix of ["HANDOFF:", "ASHBY_HANDOFF:", "WORKDAY_HANDOFF:"]) {
    const out = firstSentenceOf(`${prefix} Something is needed. And more.`);
    check(`"${prefix}" is stripped`, out === "Something is needed.", String(out));
  }
  check("a reason with no sentence boundary yields nothing, not a fragment",
    firstSentenceOf("no terminator here") === null,
    String(firstSentenceOf("no terminator here")));

  // The whole card, as it renders for Northern Trust today.
  const p = present(facts({
    status: "AWAITING_REVIEW",
    provider: "WORKDAY",
    handoffReason: firstSentenceOf(REAL),
    applyUrl: "https://ntrs.wd1.myworkdayjobs.com/northerntrust/job/Chicago-IL/Program-Manager_R159624",
  }), APP);
  check("the summary reads as one clean sentence",
    p.summary === "Workday does not publish its application form, so the questions cannot be read or answered before a person opens it.",
    p.summary);
  check("nothing claims progress was saved when nothing was filled",
    !/progress/i.test(p.summary), p.summary);
  check("and the button still goes to Workday",
    p.action?.href.includes("myworkdayjobs.com") === true, p.action?.href ?? "");
}

// ============================================================
// 3. A fill that touched a form is recorded
// ============================================================
console.log("\nfix 3: fill provenance, separate from submission_mode");
{
  const run = startFillRun({
    applicationId: APP, provider: "ASHBY", runDir: ".fill-runs/x",
    fillMode: "ASSISTED_MANUAL", formSnapshotHash: null,
  });
  const rec = fillRunRecord(run, {
    outcome: "REQUIRED_FIELD_BLOCKED",
    detail: "A required question had no answer that could be established.",
    filled: [{ field: "name", value: "Ty Pleban" }, { field: "email", value: "x" }],
    leftBlank: [{ field: "why_here", why: "BLOCKED" }],
    artifact: { resumeId: "r1", sha256: "8fba15516fa42b5038caa9ff259d6f4d8f43ccbea7e504ca549279fa9f597cfd", path: ".fill-runs/x/Resume.pdf" },
    submitClickAttempted: false,
  });

  check("the run records who drove the browser", rec.fill_mode === "ASSISTED_MANUAL", rec.fill_mode);
  check("attempted is filled plus left blank", rec.fields_attempted === 3, String(rec.fields_attempted));
  check("filled is counted separately", rec.fields_filled === 2, String(rec.fields_filled));
  check("the exact artifact hash is on the run",
    rec.artifact_sha256?.startsWith("8fba1551") === true, String(rec.artifact_sha256));
  check("the artifact path is recorded with it", !!rec.artifact_path, String(rec.artifact_path));
  check("a partial fill is not an attempted submission",
    rec.submit_click_attempted === false, String(rec.submit_click_attempted));
  check("the outcome comes from the closed set, with no new value invented",
    rec.outcome === "REQUIRED_FIELD_BLOCKED", String(rec.outcome));

  const detail = fillRunEventDetail(rec);
  check("the event says a person took over",
    /a person took over/i.test(detail), detail.slice(0, 90));
  check("the event names what was uploaded", /Uploaded .*sha256/.test(detail), detail.slice(0, 140));
  check("the event states the submit control was not touched",
    /not touched/.test(detail), detail);
  check("the event name marks it as assisted, not automated",
    fillRunEventName(rec) === "ASSISTED_FILL_RECORDED", fillRunEventName(rec));

  // The record must not be readable as a claim about who submitted.
  check("nothing in the record means submitted",
    !JSON.stringify(rec).match(/"(SUBMITTED|SENT|APPLIED)"/), JSON.stringify(rec).slice(0, 120));
}
{
  // A run that uploaded nothing must say so rather than carry a stale hash.
  const run = startFillRun({ applicationId: APP, provider: "GREENHOUSE", runDir: ".fill-runs/y" });
  const rec = fillRunRecord(run, {
    outcome: "NO_FORM_FOUND", detail: "no form", filled: [], leftBlank: [],
  });
  check("a run with no upload records no hash", rec.artifact_sha256 === null, String(rec.artifact_sha256));
  check("and no path either, so the pair is never half-written",
    rec.artifact_path === null, String(rec.artifact_path));
  check("the default fill mode is automated", rec.fill_mode === "AUTOMATED", rec.fill_mode);
  check("the event says nothing was uploaded",
    /Nothing uploaded/.test(fillRunEventDetail(rec)), fillRunEventDetail(rec).slice(0, 100));
}

// ============================================================
// 4. An employer-form handoff is not cleared by answered questions
// ============================================================
console.log("\nfix 4: answering questions does not finish an employer handoff");
{
  check("an ASHBY_HANDOFF reason is recognised as an employer-form handoff",
    isEmployerFormHandoff("ASHBY_HANDOFF: form not readable"), "");
  check("so is a Workday one", isEmployerFormHandoff("WORKDAY_HANDOFF: sign-in required"), "");
  check("an ordinary blocked reason is not",
    !isEmployerFormHandoff("Five questions need answers"), "");
  check("and neither is nothing at all", !isEmployerFormHandoff(null), "");

  check("an employer-form handoff with zero blocked answers stays put",
    staleBlockedStatus("BLOCKED_NEEDS_INPUT", 0, true) === null,
    String(staleBlockedStatus("BLOCKED_NEEDS_INPUT", 0, true)));

  // The behaviour this must not break: a genuinely stale status, where
  // the questions WERE the blocker and have all been answered.
  check("an ordinary blocked status with zero blocked answers is still stale",
    staleBlockedStatus("BLOCKED_NEEDS_INPUT", 0, false) === "AWAITING_REVIEW",
    String(staleBlockedStatus("BLOCKED_NEEDS_INPUT", 0, false)));
  check("and one with questions outstanding is not touched",
    staleBlockedStatus("BLOCKED_NEEDS_INPUT", 3, false) === null, "");
  check("nor is a status that was never blocked",
    staleBlockedStatus("READY_TO_SUBMIT", 0, false) === null, "");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("the four handoff fixes hold");
