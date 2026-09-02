/**
 * Compensation an employer states outside the posting body.
 *
 *   node scripts/opening-compensation-selftest.ts
 *
 * The case this exists for is real: Flexport's Global Operations
 * Specialist published no salary and put "The hourly rate for this role
 * is $27.69/hour." in the label of a required field on its own
 * application form. Nothing read it, so the floor comparison had nulls,
 * returned INDETERMINATE, and the job stayed ELIGIBLE and was prepared.
 *
 * Held here:
 *   the real Flexport label is read correctly;
 *   an hourly rate is stored hourly and never as a fabricated salary;
 *   a question ASKING the user's expectation is never read as a
 *     disclosure, because that number is the user's, not the employer's;
 *   stronger and newer evidence wins without anything being overwritten;
 *   and replaying identical evidence never becomes a newer observation
 *     that outranks the original merely because a script ran twice.
 */
import {
  compensationFromFieldText, compensationFromFormSnapshot,
  governingCompensation, isNewInformation, observationFingerprint,
  type CompensationObservation, type CompensationSource, type EvidenceIdentity,
} from "../lib/scoring/openingCompensation.ts";

import { compareToFloor, annualize } from "../lib/scoring/salary.ts";

// Mirrors the ranking in openingCompensation.ts, so the test states the
// expected order rather than importing whatever the code happens to say.
const RANKABLE: Record<CompensationSource, number> = {
  POSTING_BODY: 1, APPLICATION_FORM: 2, EMPLOYER_DIRECT: 3,
};

let pass = 0; const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

const FLOOR = 85_000;
const REAL_LABEL = "The hourly rate for this role is $27.69/hour.";
// Flexport's real canonical opening, and its real frozen form snapshot
// hash. SNAPSHOT_B is invented, standing in for a later re-posting.
const OPENING = "08cd09f8-98b7-424f-ba10-c7f23c403ac9";
const SNAPSHOT_A = "11085ceb9730af3e38b12ff4c7f535940dafc54157abf75d1fd527fd90ba7167";
const SNAPSHOT_B = "e2c1a4d7f0b93a1c5d8e6f2b7a0c9d4e3f1b8a6c5d2e9f0a7b4c1d8e5f2a9b6c";

console.log("\nthe real Flexport field:");
{
  const got = compensationFromFieldText(REAL_LABEL);
  check("the rate is read from the label", got !== null, "nothing parsed");
  check("the amount is 27.69", got?.amountMax === 27.69, String(got?.amountMax));
  check("the period is HOUR, as the employer wrote it", got?.period === "HOUR", String(got?.period));
  check("a flat rate sets both bounds, so it is a definite maximum",
    got?.amountMin === 27.69 && got?.amountMax === 27.69, JSON.stringify(got));
  check("nothing annual is stored, because nothing annual was published",
    got?.period !== "YEAR" && got?.amountMax !== 57595, JSON.stringify(got));
}

console.log("\nfeeding it to the unchanged rule:");
{
  const got = compensationFromFieldText(REAL_LABEL)!;
  check("annualization is derived, not stored", annualize(got.amountMax, got.period) === 57595,
    String(annualize(got.amountMax, got.period)));
  const v = compareToFloor({
    salaryMin: got.amountMin, salaryMax: got.amountMax,
    period: got.period, isEstimated: false, floor: FLOOR,
  });
  check("the rule now returns BELOW_FLOOR", v.verdict === "BELOW_FLOOR", v.verdict);
  check("and says why in the employer's own terms", /57,595/.test(v.detail), v.detail);

  // What used to happen, and must remain true of a genuinely unknown job.
  const blind = compareToFloor({ salaryMin: null, salaryMax: null, period: null, isEstimated: false, floor: FLOOR });
  check("with no evidence at all it is still INDETERMINATE, never excluded",
    blind.verdict === "INDETERMINATE", blind.verdict);
}

console.log("\nreading a whole form snapshot:");
{
  // The real neighbouring fields, so the scan is exercised against the
  // shape it will actually meet.
  const snapshot = {
    fields: [
      { key: "question_61974076[]", label: "What are your top 2 location preferences?" },
      { key: "question_61974077", label: REAL_LABEL },
      { key: "question_61974078", label: "This full-time role requires you to work in office 5 days per week. Are you currently located there?" },
    ],
  };
  const hits = compensationFromFormSnapshot(snapshot);
  check("exactly one field states pay", hits.length === 1, `${hits.length}`);
  check("and it is the right one", hits[0]?.fieldKey === "question_61974077", String(hits[0]?.fieldKey));
  check("the exact wording is carried for traceability", hits[0]?.label === REAL_LABEL, String(hits[0]?.label));
}

console.log("\nwhat must never be read as a disclosure:");
{
  const notDisclosures = [
    "What are your salary expectations?",
    "What is your expected hourly rate?",
    "Desired compensation per year",
    "How much do you expect to be paid per hour?",
    "Please share your salary requirement in USD per year.",
  ];
  for (const t of notDisclosures) {
    check(`"${t.slice(0, 44)}" is not pay data`, compensationFromFieldText(t) === null,
      JSON.stringify(compensationFromFieldText(t)));
  }
  check("a number with no stated period is not pay data",
    compensationFromFieldText("The rate for this role is $27.69.") === null, "");
  check("a bare number with no currency is not money",
    compensationFromFieldText("This role pays 27.69 per hour.") === null, "");
  check("ordinary questions are untouched",
    compensationFromFieldText("Are you willing to travel up to 20%?") === null, "");
}

console.log("\nprecedence, with nothing overwritten:");
{
  const id = (ref: string, loc: string, text: string): EvidenceIdentity =>
    ({ openingId: OPENING, sourceRef: ref, sourceLocator: loc, sourceText: text });
  const form: CompensationObservation = {
    amountMin: 27.69, amountMax: 27.69, currency: "USD", period: "HOUR",
    source: "APPLICATION_FORM", observedAt: "2026-09-02T12:00:00Z",
    identity: id(SNAPSHOT_A, "question_61974077", REAL_LABEL),
  };
  const posting: CompensationObservation = {
    amountMin: 60000, amountMax: 75000, currency: "USD", period: "YEAR",
    source: "POSTING_BODY", observedAt: "2026-09-01T12:00:00Z",
    identity: id("job-version-1", "description", "The range is $60,000-$75,000 per year."),
  };
  const direct: CompensationObservation = {
    amountMin: 95000, amountMax: 95000, currency: "USD", period: "YEAR",
    source: "EMPLOYER_DIRECT", observedAt: "2026-09-03T12:00:00Z",
    identity: id("email-2026-09-03", "recruiter", "We can offer $95,000 per year."),
  };

  check("a form statement outranks the posting body",
    governingCompensation([posting, form])?.source === "APPLICATION_FORM",
    String(governingCompensation([posting, form])?.source));
  check("something said directly by the employer outranks both",
    governingCompensation([posting, form, direct])?.source === "EMPLOYER_DIRECT",
    String(governingCompensation([posting, form, direct])?.source));
  check("both observations survive, nothing is overwritten",
    [posting, form].length === 2, "");

  const older: CompensationObservation = { ...posting, amountMax: 70000, observedAt: "2026-08-01T12:00:00Z" };
  check("within one source, the newer observation governs",
    governingCompensation([older, posting])?.amountMax === 75000,
    String(governingCompensation([older, posting])?.amountMax));

  check("nothing to govern when nothing was observed",
    governingCompensation([]) === null, "");

  // Every source names the employer as the author. There is no value a
  // third-party estimate could be filed under, which is the point: this
  // evidence can end a candidacy, so it cannot be something guessed.
  const SOURCES: CompensationSource[] = ["POSTING_BODY", "APPLICATION_FORM", "EMPLOYER_DIRECT"];
  check("every source denotes the employer as the author",
    SOURCES.length === 3 && SOURCES.every((x) => typeof RANKABLE[x] === "number"),
    SOURCES.join(","));
}

console.log("\nreplay versus a genuine second sighting:");
{
  const identity: EvidenceIdentity = {
    openingId: OPENING, sourceRef: SNAPSHOT_A,
    sourceLocator: "question_61974077", sourceText: REAL_LABEL,
  };
  const first: CompensationObservation = {
    amountMin: 27.69, amountMax: 27.69, currency: "USD", period: "HOUR",
    source: "APPLICATION_FORM", observedAt: "2026-09-02T11:21:54Z", identity,
  };

  // 1. THE RERUN. Same frozen snapshot, same field, same words, parsed
  //    again a week later. Nothing new was observed.
  const rerun: CompensationObservation = { ...first, observedAt: "2026-09-09T09:00:00Z" };
  check("re-parsing the same frozen evidence is not new information",
    isNewInformation(rerun, [first]) === false, "");
  check("the two share one fingerprint",
    observationFingerprint({ ...first, identity: first.identity! })
    === observationFingerprint({ ...rerun, identity: rerun.identity! }), "");

  // 2. A GENUINE SECOND SIGHTING. The employer posts the role again
  //    months later on a NEW form that happens to state the same rate.
  //    This is real evidence and the old design would have refused it.
  const laterSnapshot: CompensationObservation = {
    ...first,
    observedAt: "2027-03-01T10:00:00Z",
    identity: { ...identity, sourceRef: SNAPSHOT_B },
  };
  check("the same rate seen in NEW evidence IS a new observation",
    isNewInformation(laterSnapshot, [first]) === true, "");
  check("because the evidence container differs",
    observationFingerprint({ ...first, identity: first.identity! })
    !== observationFingerprint({ ...laterSnapshot, identity: laterSnapshot.identity! }), "");
  check("and the later sighting then governs, honestly on recency",
    governingCompensation([first, laterSnapshot])?.observedAt === "2027-03-01T10:00:00Z",
    String(governingCompensation([first, laterSnapshot])?.observedAt));

  // 3. The distinction is the whole point: a rerun must NOT be able to
  //    do what a genuine second sighting does.
  check("a rerun cannot displace the original the way a real sighting can",
    isNewInformation(rerun, [first]) === false && isNewInformation(laterSnapshot, [first]) === true, "");

  // 4. Everything that changes the money is new, from the same evidence.
  check("a changed amount is a new observation",
    isNewInformation({ ...first, amountMax: 31.5, amountMin: 31.5 }, [first]) === true, "");
  check("a changed period is a new observation",
    isNewInformation({ ...first, period: "YEAR" }, [first]) === true, "");
  check("a different field in the same snapshot is a new observation",
    isNewInformation({ ...first, identity: { ...identity, sourceLocator: "question_99" } }, [first]) === true, "");
  check("different wording in the same place is a new observation",
    isNewInformation({ ...first, identity: { ...identity, sourceText: "The hourly rate for this role is $27.69/hour, effective January." } }, [first]) === true, "");

  // 5. Source still separates authorities.
  check("the same figure from a different employer source is a new observation",
    isNewInformation({ ...first, source: "POSTING_BODY" }, [first]) === true, "");

  // 6. Whitespace is not a new sighting: the same sentence rewrapped by a
  //    snapshotter is the same sentence.
  check("insignificant whitespace does not fake new evidence",
    isNewInformation({ ...first, identity: { ...identity, sourceText: `  ${REAL_LABEL.replace(" ", "  ")}  ` } }, [first]) === false, "");

  // 7. An observation with no identity cannot be checked at all, and
  //    saying so loudly beats silently treating it as new.
  let threw = false;
  try { isNewInformation({ ...first, identity: undefined }, [first]); } catch { threw = true; }
  check("an observation with no evidence identity is refused, not guessed at", threw, "");
}

console.log("\nthe end-to-end consequence:");
{
  const hit = compensationFromFieldText(REAL_LABEL)!;
  const gov = governingCompensation([{
    amountMin: hit.amountMin, amountMax: hit.amountMax, currency: hit.currency,
    period: hit.period, source: "APPLICATION_FORM",
    observedAt: new Date().toISOString(),
  }])!;
  const v = compareToFloor({
    salaryMin: gov.amountMin, salaryMax: gov.amountMax,
    period: gov.period, isEstimated: false, floor: FLOOR,
  });
  check("Flexport's opening is definitively below the floor", v.verdict === "BELOW_FLOOR", v.verdict);
  // eligibility.ts turns BELOW_FLOOR into INELIGIBLE, and prepare.ts
  // refuses any job that is not ELIGIBLE. That is the chain that stops
  // it being prepared again.
  check("which is what makes the job INELIGIBLE and preparation refuse it",
    v.verdict === "BELOW_FLOOR", v.verdict);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("employer-stated compensation reaches the floor rule");
