/**
 * The candidacy gate, and the cases that shaped it.
 *
 * Each block below is a real corpus case that broke an earlier model.
 * The model is pure, so these run without a database.
 */
import { assessCandidacy, experienceObject, stratumOf, isCoreGap, mayPrepare,
         CANDIDACY_MODEL_VERSION, type RequirementRow } from "../lib/scoring/candidacy.ts";
import type { FitBreakdown, ScorableConcept } from "../lib/scoring/fit.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}\n         ${d}`); }
};
let seq = 0;
const C = (o: Partial<ScorableConcept> & { concept: string }): ScorableConcept => ({
  requirementClass: "SKILL", hardness: "HARD", resolution: "ABSENT", via: null, rationale: "",
  weight: 3, credit: 0, requirementIds: [`r${seq++}`], credentialFamily: null, ...o,
} as ScorableConcept);
const fitOf = (concepts: ScorableConcept[]): FitBreakdown => ({
  concepts, coverage: 0, evidence: 0, creditedCount: 0, achieved: 0, achievable: 0,
  excludedUnknown: 0, excludedByClass: {},
} as FitBreakdown);
const reqs = (...rs: Array<[string, string, string]>): RequirementRow[] =>
  rs.map(([id, kind, term]) => ({ id, kind, normalized_term: term, raw_text: term }));
const NOT_HELD = { CLINICAL: "NOT_HELD", LEGAL: "NOT_HELD", FINANCE: "NOT_HELD", ENGINEERING: "NOT_HELD" };
// Pinned to model 3. This suite is model 3's regression suite: it was
// written against that ladder and every expectation in it is a statement
// about that model, so it keeps testing it after the current version
// moves on. Model 4's own arm is covered by candidacy-model4-selftest.ts.
const run = (concepts: ScorableConcept[], requirements: RequirementRow[], title = "Operations Manager", modelVersion = 3) =>
  assessCandidacy({ jobTitle: title, fit: fitOf(concepts), requirements, credentialDeclarations: NOT_HELD, modelVersion });

// ---- 1. the experience object -----------------------------------------
check("the current model is 6", CANDIDACY_MODEL_VERSION === 6, String(CANDIDACY_MODEL_VERSION));
check("model 3 is still executable, not merely described",
  run([], reqs()).modelVersion === 3);
for (const t of ["fast-paced environment experience", "fast-paced work environment experience", "remote team experience"])
  check(`"${t}" is setting-only`, experienceObject(t) === "SETTING_ONLY", experienceObject(t));
for (const t of ["work experience", "professional experience", "industry experience", "relevant experience"])
  check(`"${t}" is general professional, not a setting`, experienceObject(t) === "GENERAL_PROFESSIONAL", experienceObject(t));
for (const t of ["logistics, supply chain management, consulting", "customer success", "software engineering",
                 "project management experience in a fast-paced environment", "recruiting in high-growth environments",
                 "strategic finance, fp&a, or business finance at high-growth company",
                 "leading complex programs in ambiguous environments", "shipping products in regulated environments",
                 "customer onboarding, implementation", "seo"])
  check(`"${t.slice(0, 46)}" keeps its object`, experienceObject(t) === "OCCUPATIONAL", experienceObject(t));

// ---- 2. stratification -------------------------------------------------
{
  const by = new Map(reqs(["r0", "EXPERIENCE_YEARS", "logistics, supply chain management"],
    ["r1", "EDUCATION", "bachelor's degree"], ["r2", "SKILL", "project management"],
    ["r3", "EXPERIENCE_YEARS", "fast-paced work environment experience"],
    ["r4", "CREDENTIAL", "rn license"]).map((r) => [r.id, r]));
  const s = (id: string, cls = "SKILL") => stratumOf(C({ concept: "x", requirementIds: [id], requirementClass: cls as any }), by);
  check("EXPERIENCE_YEARS naming work is OCCUPATIONAL", s("r0") === "OCCUPATIONAL", s("r0"));
  check("an EDUCATION requirement is BASELINE", s("r1") === "BASELINE", s("r1"));
  check("a SKILL requirement is SUBSTANTIVE", s("r2") === "SUBSTANTIVE", s("r2"));
  check("a setting-only years requirement is NOT occupational", s("r3") === "SUBSTANTIVE", s("r3"));
  check("a gating credential is GATING", s("r4", "GATING_CREDENTIAL") === "GATING", s("r4", "GATING_CREDENTIAL"));
  const compound = stratumOf(C({ concept: "x", requirementIds: ["r0", "r3"] }), by);
  check("a concept backed by real work AND a setting phrase stays occupational", compound === "OCCUPATIONAL", compound);
}

// ---- 3. the named regression cases -------------------------------------
{
  // Menu Strategy Analyst: three substantive met, one setting-only years
  // requirement absent, one baseline met.
  const r = run([
    C({ concept: "menu strategy", credit: 1, resolution: "DIRECT", requirementIds: ["a"] }),
    C({ concept: "data analysis", credit: 1, resolution: "DIRECT", requirementIds: ["b"] }),
    C({ concept: "process improvement", credit: 1, resolution: "DIRECT", requirementIds: ["c"] }),
    C({ concept: "fast-paced work environment", requirementIds: ["d"] }),
    C({ concept: "bachelor degree", credit: 1, resolution: "DIRECT", requirementClass: "EDUCATION", requirementIds: ["e"] }),
  ], reqs(["a", "SKILL", "menu strategy"], ["b", "SKILL", "data analysis"], ["c", "SKILL", "process improvement"],
    ["d", "EXPERIENCE_YEARS", "fast-paced work environment experience"], ["e", "EDUCATION", "bachelor's degree"]), "Menu Strategy Analyst");
  check("a setting-only years phrase does not block candidacy", r.verdict === "APPLICATION_CANDIDATE", `${r.verdict}: ${r.reason}`);
  check("and the baseline degree is out of the ratio", r.hardTotal === 4 && r.baselineMet === 1, `${r.hardMet}/${r.hardTotal} baseline ${r.baselineMet}`);
}
{
  // Regional Implementation Manager: degree + project management met,
  // four years of logistics absent.
  const r = run([
    C({ concept: "logistics, supply chain management, consulting", requirementIds: ["a"] }),
    C({ concept: "bachelor degree", credit: 1, resolution: "DIRECT", requirementClass: "EDUCATION", requirementIds: ["b"] }),
    C({ concept: "project management", credit: 1, resolution: "DIRECT", requirementIds: ["c"] }),
  ], reqs(["a", "EXPERIENCE_YEARS", "logistics, supply chain management, consulting"],
    ["b", "EDUCATION", "bachelor's degree"], ["c", "SKILL", "project management"]), "Regional Implementation Manager");
  check("an occupational gap caps at STRETCH", r.verdict === "STRETCH", `${r.verdict}: ${r.reason}`);
  check("and the reason names it", r.reasonCodes[0] === "OCCUPATIONAL_GAP", r.reasonCodes.join(","));
  check("baseline inflation is removed: 1/2, not 2/3", r.hardMet === 1 && r.hardTotal === 2, `${r.hardMet}/${r.hardTotal}`);
}
{
  // SpotHero: two title-anchored gaps.
  const r = run([
    C({ concept: "legal operations", requirementIds: ["a"] }),
    C({ concept: "operations", requirementIds: ["b"] }),
    C({ concept: "process improvement", credit: 1, resolution: "DIRECT", requirementIds: ["c"] }),
  ], reqs(["a", "EXPERIENCE_YEARS", "legal operations experience"], ["b", "EXPERIENCE_YEARS", "operations experience"],
    ["c", "SKILL", "process improvement"]), "Legal Operations Specialist");
  check("two role-defining gaps reject", r.verdict === "REJECT" && r.reasonCodes[0] === "MULTIPLE_CORE_GAPS", `${r.verdict}: ${r.reason}`);
}
{
  // Principal Engineer: no occupational requirement at all; only CORE
  // catches it. This is why both mechanisms are kept.
  const r = run([
    C({ concept: "distributed systems", requirementIds: ["a"] }),
    C({ concept: "greenfield development", requirementIds: ["b"] }),
    C({ concept: "mentoring", credit: 1, resolution: "DIRECT", requirementIds: ["c"] }),
    C({ concept: "technical leadership", requirementIds: ["d"] }),
  ], reqs(["a", "SKILL", "distributed systems"], ["b", "SKILL", "greenfield development"],
    ["c", "SKILL", "mentoring"], ["d", "SKILL", "technical leadership"]), "Principal Engineer, Streaming Systems");
  check("CORE rejects a job with no occupational requirements",
    r.verdict === "REJECT" && r.reasonCodes[0] === "CORE_GAP_WITHOUT_SUPPORT", `${r.verdict}: ${r.reason}`);
  check("and it had no occupational requirement to reject on", r.occupational.length === 0, JSON.stringify(r.occupational));
}

// ---- 4. the gate conditions --------------------------------------------
{
  const r = run([C({ concept: "operations", credit: 1, resolution: "DIRECT", requirementIds: ["a"] }),
                 C({ concept: "process improvement", credit: 1, resolution: "DIRECT", requirementIds: ["c"] }),
                 C({ concept: "vendor management", credit: 1, resolution: "DIRECT", requirementIds: ["d"] }),
                 C({ concept: "salesforce", hardness: "PREFERRED", weight: 1, requirementIds: ["b"] })],
    reqs(["a", "SKILL", "operations"], ["c", "SKILL", "process improvement"], ["d", "SKILL", "vendor management"], ["b", "TOOL", "salesforce"]));
  check("a missing PREFERRED tool does not block candidacy", r.verdict === "APPLICATION_CANDIDATE", `${r.verdict}: ${r.reason}`);
}
{
  const r = run([C({ concept: "rn license", requirementClass: "GATING_CREDENTIAL", credentialFamily: "CLINICAL", requirementIds: ["a"] }),
                 C({ concept: "patient care", credit: 1, resolution: "DIRECT", requirementIds: ["b"] })],
    reqs(["a", "CREDENTIAL", "rn license"], ["b", "SKILL", "patient care"]), "Registered Nurse");
  check("a NOT_HELD credential rejects", r.verdict === "REJECT" && r.reasonCodes[0] === "DISQUALIFYING_CREDENTIAL", `${r.verdict}: ${r.reason}`);
}
{
  const r = assessCandidacy({ jobTitle: "Widget Inspector",
    fit: fitOf([C({ concept: "widget licence", requirementClass: "GATING_CREDENTIAL", credentialFamily: "OTHER", credit: null, requirementIds: ["a"] }),
                C({ concept: "inspection", credit: 1, resolution: "DIRECT", requirementIds: ["b"] })]),
    requirements: reqs(["a", "CREDENTIAL", "widget licence"], ["b", "SKILL", "inspection"]),
    credentialDeclarations: { OTHER: "UNDECLARED" } });
  check("an UNKNOWN credential is MANUAL_REVIEW, never REJECT",
    r.verdict === "MANUAL_REVIEW" && r.reasonCodes[0] === "UNKNOWN_GATING_CREDENTIAL", `${r.verdict}: ${r.reason}`);
  check("and it is not converted to an absence", r.gatingGaps.length === 0 && r.unknownGates.length === 1, "");
}
{
  // A single transferable match that covers the discriminating substance
  // (hard ratio 1/1, no occupational gap) is now a reasonable-applicant
  // STRETCH, not a reject. The old "transferable-only never survives" rule
  // was too strict for a broad profile applying to adjacent work. This is a
  // candidacy decision only; transferable is NEVER rewritten as direct on the
  // résumé. (Model 4 loosens; model 3 keeps the strict reject.)
  const r = run([C({ concept: "widgets", resolution: "TRANSFERABLE", credit: 0.5, requirementIds: ["a"] })], reqs(["a", "SKILL", "widgets"]), "Widget Operations Analyst", 4);
  check("transferable-only with a full hard ratio is a reasonable STRETCH",
    r.verdict === "STRETCH" && r.reasonCodes[0] === "NO_DIRECT_BUT_TRANSFERABLE", `${r.verdict}: ${r.reason}`);
}
{
  // But transferable on only a FRACTION of the discriminating requirements --
  // a different occupation he cannot do -- still REJECTs.
  const r = run([
    C({ concept: "widgets", resolution: "TRANSFERABLE", credit: 0.5, requirementIds: ["a"] }),
    C({ concept: "gizmos", resolution: "ABSENT", credit: 0, requirementIds: ["b"] }),
    C({ concept: "sprockets", resolution: "ABSENT", credit: 0, requirementIds: ["c"] }),
  ], reqs(["a", "SKILL", "widgets"], ["b", "SKILL", "gizmos"], ["c", "SKILL", "sprockets"]), "Widget Engineer", 4);
  check("transferable on only a fraction of the substance still REJECTs", r.verdict === "REJECT", `${r.verdict}: ${r.reason}`);
}
check("only CANDIDATE and STRETCH may prepare",
  mayPrepare("APPLICATION_CANDIDATE") && mayPrepare("STRETCH") && !mayPrepare("REJECT") && !mayPrepare("MANUAL_REVIEW"));

// ---- 5. the gate is wired into preparation, fail-closed ----------------
{
  const fs = await import("node:fs");
  const src = fs.readFileSync("lib/applications/prepare.ts", "utf8");
  check("preparation checks candidacy before doing anything",
    /const gate = await checkCandidacy\(db, jobId\)/.test(src)
    && src.indexOf("checkCandidacy(db, jobId)") < src.indexOf('from("applications").insert'), "");
  check("a missing verdict refuses", /has never been assessed/.test(src), "");
  check("a stale verdict refuses and names both states", /the candidacy verdict is stale/.test(src), "");
  check("MANUAL_REVIEW refuses", /MANUAL_REVIEW/.test(src) && /needs a human answer/.test(src), "");
  check("staleness is version equality, not a timestamp",
    /profile_version === prof\?\.profile_version/.test(src) && /model_version === CANDIDACY_MODEL_VERSION/.test(src), "");
  check("an override is opt-in and never a default", /if \(!options\.override\) return/.test(src), "");
  check("and it is recorded before any work happens",
    src.indexOf('from("candidacy_overrides").insert') < src.indexOf('from("resumes").insert'), "");
  check("the override records who and why",
    /invoked_by: options\.override\.invokedBy/.test(src) && /reason: options\.override\.reason/.test(src), "");
  check("and what the verdict actually was", /overridden_verdict: gate\.verdict/.test(src), "");
}

// hard_total = 0 must never satisfy the hard-requirement gate.
//
// A posting whose only HARD requirement is a baseline degree has an
// empty ratio set. The gate read that missing denominator as a cleared
// bar and stamped MEETS_HARD_REQUIREMENTS on 17 postings it had tested
// against nothing. Distinct from POSTING_NOT_ASSESSED: here extraction
// succeeded and requirements exist, but none of them discriminate.
{
  const r = run([C({ concept: "bachelor degree", credit: 1, resolution: "DIRECT", isBaseline: true, requirementIds: ["a"] }),
                 C({ concept: "transgenic mouse colony", credit: 0, resolution: "ABSENT", hardness: "PREFERRED", requirementIds: ["b"] })],
    reqs(["a", "EDUCATION", "bachelor degree"], ["b", "SKILL", "transgenic mouse colony"]), "Research Technician");
  check("a baseline-degree-only posting is not a candidate",
    r.verdict !== "APPLICATION_CANDIDATE", `got ${r.verdict}`);
  check("it is routed to a person",
    r.verdict === "MANUAL_REVIEW" && r.reasonCodes[0] === "NO_DISCRIMINATING_REQUIREMENTS", `${r.verdict}/${r.reasonCodes[0]}`);
  check("and it reports an empty hard set rather than a met one",
    r.hardTotal === 0 && r.hardMet === 0, `${r.hardMet}/${r.hardTotal}`);
}

// The 50% threshold itself is untouched.
{
  const r = run([C({ concept: "supply chain", credit: 1, resolution: "DIRECT", requirementIds: ["a"] }),
                 C({ concept: "logistics", credit: 1, resolution: "DIRECT", requirementIds: ["b"] }),
                 C({ concept: "process improvement", credit: 1, resolution: "DIRECT", requirementIds: ["c"] })],
    reqs(["a", "DOMAIN", "supply chain"], ["b", "DOMAIN", "logistics"], ["c", "SKILL", "process improvement"]), "Operations Manager");
  check("a posting with real hard requirements met still passes",
    r.hardTotal > 0 && r.verdict === "APPLICATION_CANDIDATE", `${r.verdict} ${r.hardMet}/${r.hardTotal}`);
}

// An un-extracted posting must never be reported as REJECT.
//
// Empty concepts means no comparison happened. Recording that as a
// rejection asserts a judgment nobody made, and hid 788 unassessed jobs
// inside a REJECT total that read as considered and declined.
{
  const r = run([], []);
  check("an un-extracted posting is not rejected",
    r.verdict === "MANUAL_REVIEW", `got ${r.verdict}`);
  check("and it says why it was not assessed",
    r.reasonCodes[0] === "POSTING_NOT_ASSESSED", r.reasonCodes.join(","));
  check("and it claims no evidence comparison",
    r.directMatches === 0 && r.hardTotal === 0, `${r.directMatches}/${r.hardTotal}`);
}


// ---- evidence sufficiency (model 5): thin extraction must not manufacture
//      autonomous confidence, and must never become a REJECT ------------
{
  // 2 discriminating hard requirements, one met -> would be 1/2 = 0.5.
  // Model 5 routes it to MANUAL_REVIEW (too thin), not APPLICATION_CANDIDATE.
  const thin = [C({ concept: "excel", credit: 1, resolution: "DIRECT", requirementIds: ["a"] }),
                C({ concept: "microsoft word", requirementIds: ["b"] })];
  const rs = reqs(["a", "TOOL", "excel"], ["b", "TOOL", "microsoft word"]);
  const r = run(thin, rs, "Capital Markets Internship", 5);
  check("a thin would-be candidate (2 hard, 1 met) is MANUAL_REVIEW, not APPLICATION_CANDIDATE",
    r.verdict === "MANUAL_REVIEW" && r.reasonCodes[0] === "INSUFFICIENT_EVIDENCE", `${r.verdict}/${r.reasonCodes[0]}`);
  check("and thin extraction never becomes a REJECT", r.verdict !== "REJECT", r.verdict);
  // Frozen model 4 is unchanged: the guard is model 5 only.
  const m4 = assessCandidacy({ jobTitle: "Capital Markets Internship", fit: fitOf(thin), requirements: rs, credentialDeclarations: {}, modelVersion: 4 });
  check("frozen model 4 still calls the same thin posting a candidate", m4.verdict === "APPLICATION_CANDIDATE", m4.verdict);
  // Three discriminating hard requirements, >=50% met -> still a candidate.
  const rich = [C({ concept: "excel", credit: 1, resolution: "DIRECT", requirementIds: ["a"] }),
                C({ concept: "process improvement", credit: 1, resolution: "DIRECT", requirementIds: ["b"] }),
                C({ concept: "salesforce", requirementIds: ["c"] })];
  const rr = reqs(["a", "TOOL", "excel"], ["b", "SKILL", "process improvement"], ["c", "TOOL", "salesforce"]);
  const r2 = run(rich, rr, "Operations Analyst", 5);
  check("a sufficiently-rich posting (3 hard, 2 met) is still APPLICATION_CANDIDATE",
    r2.verdict === "APPLICATION_CANDIDATE", `${r2.verdict} ${r2.hardMet}/${r2.hardTotal}`);
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }

console.log("all passed");
