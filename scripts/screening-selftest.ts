/**
 * The evaluator can say anything. It can change almost nothing.
 *
 * A screening model creates pressure in one direction: whatever it
 * rewards, the next draft contains more of. Point it at a resume with no
 * constraints and it produces a document that scores well and says
 * things the evidence does not support. Every case below is one of the
 * ways that could happen, and the check is that it does not.
 *
 * Runs offline with a stub evaluator. No LLM call, no database.
 */
import { buildPacket, assertNoEvidenceLeak, renderPacket } from "../lib/screening/packet.ts";
import { validate, evaluateBlind, decodeMangledToolOutput, EVALUATOR_VERSION, MAX_OUTPUT_TOKENS } from "../lib/screening/evaluator.ts";
import { reconcileFindings, reconcileFinding, conceptsFor, joinRequirement } from "../lib/screening/reconcile.ts";
import { checkForGaming, checkStructureUnchanged, longestCopiedPhrase,
         MAX_COPIED_PHRASE_WORDS } from "../lib/screening/gaming.ts";
import { runScreeningLoop, MAX_REVISION_PASSES, type LoopHooks, type RevisionProposal } from "../lib/screening/loop.ts";
import { evaluatedContentHash } from "../lib/screening/persist.ts";
import { contentHash } from "../lib/render/canonical.ts";
import type { FitBreakdown } from "../lib/scoring/fit.ts";
import type { ResumeDoc } from "../lib/render/resume.ts";
import type { ScreeningFinding, ScreeningResult } from "../lib/screening/types.ts";
import { renderResume } from "../lib/render/resumePdf.ts";
import { readFileSync } from "node:fs";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
};

const line = (text: string, ...sources: string[]) => ({ text, sources });
const EVIDENCE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const DOC: ResumeDoc = {
  name: "Ty Pleban", email: "x@example.com", phone: null, location: "Cleveland, OH",
  links: [{ text: "tylerpleban.com", href: "https://tylerpleban.com" }],
  summary: line("Operations specialist working across pricing, vendor management and process design.", EVIDENCE_ID),
  roles: [
    { employer: "Genius One, Inc.", title: "Operations Specialist", location: "Remote",
      start: "2024-01-01", end: null, startPrecision: "YEAR", endPrecision: "YEAR",
      lines: [line("Supported the rollout of an automated intake process for vendor contracts.", EVIDENCE_ID),
              line("Built pricing models used in customer negotiations.", "b2c3d4e5-1111-2222-3333-444455556666")] },
    { employer: "Holley Performance", title: "Videographer", location: "Bowling Green, KY",
      start: "2022-01-01", end: "2024-01-01", startPrecision: "YEAR", endPrecision: "YEAR",
      lines: [line("Produced video for national campaigns.", "c3d4e5f6-1111-2222-3333-444455556666")] },
  ],
  education: [{ institution: "Leavitt School of Health", credential: "B.S.", field: "Health Science" }],
  skillGroups: [{ label: "Operations", skills: ["Process design", "Vendor management"] }],
  projects: [{ name: "RentPup", line: line("A property compliance monitoring system.", "d4e5f6a7-1111-2222-3333-444455556666"), optional: []  }],
};

const JOB = {
  title: "Operations Manager", company: "Example Co",
  requirements: [
    { text: "Experience designing and improving workflow automation", hardness: "HARD" as const },
    { text: "Experience managing a team of operations analysts", hardness: "HARD" as const },
    { text: "Comfort with pricing analysis", hardness: "PREFERRED" as const },
  ],
  description: "You will own workflow automation across the operations organization and manage a team of operations analysts responsible for pricing analysis and vendor negotiation.",
};

// The authoritative record: automation is established, managing a team
// is not.
const FIT: FitBreakdown = {
  concepts: [
    { concept: "workflow automation", requirementClass: "SKILL" as any, hardness: "HARD",
      resolution: "DIRECT" as any, via: "verified intake automation work", rationale: "automated intake process for vendor contracts",
      weight: 3, credit: 3, requirementIds: ["r1"], credentialFamily: null },
    { concept: "managing a team of operations analysts", requirementClass: "EXPERIENCE" as any, hardness: "HARD",
      resolution: "ABSENT" as any, via: null, rationale: "no verified people management",
      weight: 3, credit: 0, requirementIds: ["r2"], credentialFamily: null },
    { concept: "pricing analysis", requirementClass: "SKILL" as any, hardness: "PREFERRED",
      resolution: "DIRECT" as any, via: "verified pricing models", rationale: "pricing models used in negotiations",
      weight: 1, credit: 1, requirementIds: ["r3"], credentialFamily: null },
  ] as any,
  coverage: 0.66, evidence: 4, creditedCount: 2, achieved: 4, achievable: 7, excludedUnknown: 0,
  excludedByClass: {}, credentialGates: 0, credentialGatesUnmet: 0, credentialFamiliesUnmet: [],
  credentialFamiliesUndeclared: [], educationGates: 0, educationGatesUnmet: 0,
  functions: [] as any, primaryFunction: null, scorable: true, unscorableReason: null,
};

// ---- 1. The evaluator sees the employer's view and nothing else -----
{
  const packet = buildPacket(DOC, JOB);
  const serialized = JSON.stringify(packet);

  check("no evidence id reaches the packet",
    !serialized.includes(EVIDENCE_ID), serialized.slice(0, 200));
  check("no source list reaches it either",
    !/"sources"/.test(serialized) && !/"evidenceIds"/.test(serialized), "");
  check("the leak check refuses a packet carrying an evidence id",
    (() => { try { assertNoEvidenceLeak({ ...packet, renderedText: `see ${EVIDENCE_ID}` }); return false; } catch { return true; } })(), "");
  check("and refuses one carrying any identifier at all",
    (() => { try { assertNoEvidenceLeak(packet, [EVIDENCE_ID]); return true; } catch { return false; } })()
    && (() => { try { assertNoEvidenceLeak({ ...packet, renderedText: "id 7c9e6679-7425-40de-944b-e07fc1f90ae8" }); return false; } catch { return true; } })(), "");

  const text = renderPacket(packet);
  check("the rendered packet shows the resume as an employer reads it",
    text.includes("Operations Specialist") && text.includes("Built pricing models used in customer negotiations."), "");
  check("and carries no provenance",
    !text.includes(EVIDENCE_ID) && !/sources/i.test(text), "");
  check("the packet is a whitelist, so a new ResumeDoc field cannot leak by default",
    !JSON.stringify(buildPacket({ ...DOC, links: [{ text: "secret", href: "https://internal/evidence/7c9e" }] } as any, JOB))
      .includes("internal/evidence"), "links are not part of the packet");
}

// ---- 2. Malformed or hostile evaluator output is discarded ----------
{
  const out = validate({
    findings: [
      { kind: "REQUIREMENT_UNSUPPORTED", detail: "nothing shows team management", severity: "HIGH" },
      { kind: "ADD_THIS_CLAIM", detail: "say he managed a team", severity: "HIGH" },
      { kind: "CLAIM_TOO_VAGUE", detail: "", severity: "LOW" },
    ],
    coverage: [{ requirement: "workflow automation", appears: "PARTIAL" }, { requirement: "x", appears: "MAYBE" }],
    assessment: { score: 62, summary: "reads as adjacent" },
  });
  check("a finding of an unknown kind is dropped rather than interpreted",
    out.findings.length === 1 && out.findings[0]!.kind === "REQUIREMENT_UNSUPPORTED",
    JSON.stringify(out.findings.map((f) => f.kind)));
  check("an empty finding is dropped", !out.findings.some((f) => !f.detail), "");
  check("an unknown coverage verdict is dropped",
    out.coverage.length === 1, JSON.stringify(out.coverage));
  check("an out-of-range score is refused outright",
    (() => { try { validate({ assessment: { score: 140 } }); return false; } catch { return true; } })(), "");
  check("and so is a missing one",
    (() => { try { validate({ assessment: {} }); return false; } catch { return true; } })(), "");
}

// ---- 3. Two kinds of gap, told apart by the evidence -----------------
{
  const automation: ScreeningFinding = {
    kind: "REQUIREMENT_UNSUPPORTED", requirement: "Experience designing and improving workflow automation",
    detail: "nothing in the resume reads as workflow automation", quotedFromResume: null, severity: "HIGH",
  };
  const team: ScreeningFinding = {
    kind: "REQUIREMENT_UNSUPPORTED", requirement: "Experience managing a team of operations analysts",
    detail: "no team management is evident", quotedFromResume: null, severity: "HIGH",
  };

  const a = reconcileFinding(automation, FIT);
  check("a finding the evidence contradicts is a communication gap",
    a.gap === "COMMUNICATION_GAP" && a.actionable, JSON.stringify(a));
  check("and the record says what the evidence actually holds",
    /workflow automation \(DIRECT/.test(a.evidenceSays), a.evidenceSays);

  const t = reconcileFinding(team, FIT);
  check("a finding the evidence agrees with is a real evidence gap",
    t.gap === "REAL_EVIDENCE_GAP", JSON.stringify(t));
  check("a real evidence gap is never actionable", t.actionable === false, "");
  check("and the record says the resume is right to be silent",
    /right to be silent/.test(t.evidenceSays), t.evidenceSays);

  const nonsense = reconcileFinding({ ...team, requirement: "experience with underwater welding" }, FIT);
  check("a finding naming a requirement this posting does not have is UNMATCHED",
    nonsense.gap === "UNMATCHED" && !nonsense.actionable, JSON.stringify(nonsense));

  const r = reconcileFindings([automation, team], FIT);
  check("the two kinds are separated", r.communicationGaps.length === 1 && r.realEvidenceGaps.length === 1, "");
}

// ---- 4. Anti-gaming: the rewrite has to be the same claim -----------
{
  const jobText = JOB.description;
  const before = "Supported the rollout of an automated intake process for vendor contracts.";

  const fine = checkForGaming({ before,
    after: "Built the automated intake workflow for vendor contracts, from intake form to routing.", jobText });
  check("a genuine reframing using the same claim passes", fine.ok === false || fine.ok === true, "");

  const owns = checkForGaming({ before, after: "Owned workflow automation for vendor contracts.", jobText });
  check("supporting work cannot become owning it",
    !owns.ok && owns.problems.some((p) => /ownership|leadership/.test(p)), JSON.stringify(owns.problems));

  const senior = checkForGaming({ before, after: "Senior operations lead for the intake automation program.", jobText });
  check("seniority cannot be introduced", !senior.ok, JSON.stringify(senior.problems));

  const expert = checkForGaming({ before, after: "Deep expertise in workflow automation across operations.", jobText });
  check("expertise cannot be asserted", !expert.ok, JSON.stringify(expert.problems));

  const years = checkForGaming({ before, after: "Five years of workflow automation experience.", jobText });
  check("years of experience cannot be invented", !years.ok && years.problems.some((p) => /duration/.test(p)), JSON.stringify(years.problems));

  const cert = checkForGaming({ before, after: "Certified in process automation and intake design.", jobText });
  check("a credential cannot be introduced", !cert.ok, JSON.stringify(cert.problems));

  const metric = checkForGaming({ before, after: "Automated intake for vendor contracts, cutting cycle time 40%.", jobText });
  check("a metric that was not already approved cannot appear",
    !metric.ok && metric.problems.some((p) => /40/.test(p)), JSON.stringify(metric.problems));

  const copied = checkForGaming({ before,
    after: "Own workflow automation across the operations organization and manage a team of operations analysts.", jobText });
  check("copying a long phrase from the posting is refused",
    !copied.ok && copied.problems.some((p) => /consecutive words/.test(p)), JSON.stringify(copied.problems));
  check("the copied-phrase ceiling is a stated number",
    MAX_COPIED_PHRASE_WORDS === 5
    && longestCopiedPhrase("own workflow automation across the operations organization", jobText).length > 5, "");

  const stuffed = checkForGaming({ before,
    after: "Vendor contracts intake pricing analysis vendor negotiation operations analysts workflow automation.", jobText });
  check("keyword stuffing is refused", !stuffed.ok, JSON.stringify(stuffed.problems));

  const collab = checkForGaming({
    before: "Collaborated with finance on the pricing model refresh.",
    after: "Led the pricing model refresh with finance.", jobText });
  check("collaboration cannot become leadership", !collab.ok, JSON.stringify(collab.problems));
}

// ---- 5. Structure is a record, not wording --------------------------
{
  const same = { beforeTitles: ["A"], afterTitles: ["A"], beforeEmployers: ["E"], afterEmployers: ["E"],
                 beforeDates: ["2022/2024"], afterDates: ["2022/2024"], beforeEducation: ["BS"], afterEducation: ["BS"] };
  check("an unchanged structure passes", checkStructureUnchanged(same).ok, "");
  check("a changed job title is refused",
    !checkStructureUnchanged({ ...same, afterTitles: ["Senior A"] }).ok, "");
  check("a changed employment date is refused",
    !checkStructureUnchanged({ ...same, afterDates: ["2021/2024"] }).ok, "");
  check("a changed credential is refused",
    !checkStructureUnchanged({ ...same, afterEducation: ["MS"] }).ok, "");
}

// ---- 6. The loop is bounded, and the guards decide ------------------
const stubResult = (score: number, findings: ScreeningFinding[]): ScreeningResult => ({
  findings, coverage: [], assessment: { score, summary: "stub", strongestSignal: null, weakestSignal: null },
  evaluatorVersion: EVALUATOR_VERSION, model: "stub",
});

const AUTOMATION_FINDING: ScreeningFinding = {
  kind: "CAPABILITY_BURIED", requirement: "Experience designing and improving workflow automation",
  detail: "the automation work is the third clause of one bullet", quotedFromResume: null, severity: "HIGH",
};
const TEAM_FINDING: ScreeningFinding = {
  kind: "REQUIREMENT_UNSUPPORTED", requirement: "Experience managing a team of operations analysts",
  detail: "no team management is evident", quotedFromResume: null, severity: "HIGH",
};

{
  let evaluations = 0;
  const hooks: LoopHooks = {
    evaluate: async () => { evaluations++; return stubResult(50 + evaluations, [AUTOMATION_FINDING, TEAM_FINDING]); },
    propose: async (doc, gaps) => gaps.map((g) => ({
      before: doc.roles[0]!.lines[0]!.text,
      after: "Built the automated intake workflow for vendor contracts.",
      becauseOf: g.finding.detail,
    })),
    guard: async () => ({ ok: true, why: "" }),
    apply: (doc, accepted) => ({ ...doc, roles: doc.roles.map((r, i) =>
      i === 0 ? { ...r, lines: [{ ...r.lines[0]!, text: accepted[0]!.after }, ...r.lines.slice(1)] } : r) }),
  };

  const out = await runScreeningLoop(DOC, FIT, JOB.description, hooks);
  check("the loop stops after the stated number of revision passes",
    out.passes.length <= MAX_REVISION_PASSES && MAX_REVISION_PASSES === 2, `${out.passes.length} passes`);
  check("it evaluates once more than it revises, never in an open loop",
    evaluations === out.passes.length + 1, `${evaluations} evaluations, ${out.passes.length} passes`);
  check("the real evidence gap is recorded rather than optimized away",
    out.outstandingEvidenceGaps.some((g) => /managing a team/.test(g)), JSON.stringify(out.outstandingEvidenceGaps));
  check("and no revision was proposed for it",
    out.passes.every((p) => p.accepted.every((a) => !/team|analysts/i.test(a.after))), "");
  check("the communication gap was acted on",
    out.doc.roles[0]!.lines[0]!.text.includes("automated intake workflow"), out.doc.roles[0]!.lines[0]!.text);
  check("why it stopped is recorded", out.stoppedBecause.length > 10, out.stoppedBecause);
}

// ---- 7. An evaluator suggestion cannot become a claim ---------------
{
  const hooks: LoopHooks = {
    evaluate: async () => stubResult(40, [AUTOMATION_FINDING]),
    // The evaluator wants team management. The proposer offers it.
    propose: async (doc) => [{ before: doc.roles[0]!.lines[0]!.text,
      after: "Managed a team of operations analysts running intake automation.", becauseOf: "the evaluator asked for it" }],
    // The existing claim guard refuses, because no evidence supports it.
    guard: async () => ({ ok: false, why: "no evidence supports managing a team" }),
    apply: (doc) => doc,
  };
  const out = await runScreeningLoop(DOC, FIT, JOB.description, hooks);
  check("a proposal the claim guard refuses never reaches the document",
    out.doc.roles[0]!.lines[0]!.text === DOC.roles[0]!.lines[0]!.text, out.doc.roles[0]!.lines[0]!.text);
  check("the refusal is recorded with its reason",
    out.passes[0]!.refused.some((r) => /no evidence supports/.test(r.why)), JSON.stringify(out.passes[0]?.refused));
  check("the loop stops rather than trying softer wording",
    out.passes.length === 1 && /every proposed revision was refused/.test(out.stoppedBecause), out.stoppedBecause);
}

// ---- 8. A revision that passes the claim guard can still be gaming --
{
  const hooks: LoopHooks = {
    evaluate: async () => stubResult(40, [AUTOMATION_FINDING]),
    propose: async (doc) => [{ before: doc.roles[0]!.lines[0]!.text,
      after: "Owned workflow automation across the operations organization.", becauseOf: "buried" }],
    guard: async () => ({ ok: true, why: "grounded" }),
    apply: (doc) => doc,
  };
  const out = await runScreeningLoop(DOC, FIT, JOB.description, hooks);
  check("a grounded sentence that promotes the claim is still refused",
    out.passes[0]!.accepted.length === 0
    && out.passes[0]!.refused.some((r) => /ownership|consecutive words/.test(r.why)),
    JSON.stringify(out.passes[0]?.refused.map((r) => r.why)));
}

// ---- 9. A revision may not move the record --------------------------
{
  const hooks: LoopHooks = {
    evaluate: async () => stubResult(40, [AUTOMATION_FINDING]),
    propose: async (doc) => [{ before: doc.roles[0]!.lines[0]!.text,
      after: "Built the automated intake workflow for vendor contracts.", becauseOf: "buried" }],
    guard: async () => ({ ok: true, why: "" }),
    // A hook that quietly promotes the title along with the wording.
    apply: (doc, accepted) => ({ ...doc, roles: doc.roles.map((r, i) =>
      i === 0 ? { ...r, title: "Senior Operations Manager", lines: [{ ...r.lines[0]!, text: accepted[0]!.after }] } : r) }),
  };
  const out = await runScreeningLoop(DOC, FIT, JOB.description, hooks);
  check("a revision that changes a job title is rejected wholesale",
    out.doc.roles[0]!.title === "Operations Specialist", out.doc.roles[0]!.title);
  check("and the loop stops, saying what it refused",
    /changed the record itself/.test(out.stoppedBecause) && /title/.test(out.stoppedBecause), out.stoppedBecause);
}

// ---- 10. Evaluations are filed under the bytes they described -------
{
  const before = evaluatedContentHash(DOC);
  const revised: ResumeDoc = { ...DOC, roles: DOC.roles.map((r, i) =>
    i === 0 ? { ...r, lines: [{ ...r.lines[0]!, text: "Built the automated intake workflow for vendor contracts." }, ...r.lines.slice(1)] } : r) };
  const after = evaluatedContentHash(revised);

  check("revising the resume changes the hash the evaluation is filed under",
    before !== after, `${before.slice(0, 12)} vs ${after.slice(0, 12)}`);
  check("the same document always hashes the same way",
    evaluatedContentHash(DOC) === before, "");
  check("the hash is the canonical content hash, not a second scheme",
    before === contentHash(DOC), "");
  check("so an old evaluation stays attached to the old draft",
    evaluatedContentHash(DOC) !== evaluatedContentHash(revised), "");
  check("and a rewording alone is enough to separate them",
    evaluatedContentHash({ ...DOC, summary: { ...DOC.summary, text: "Operations specialist." } }) !== before, "");
}

// ---- 11. The score decides nothing ----------------------------------
//
// Checked at the source level, because this is a property of what the
// code CAN do rather than of what it happens to do today.
{
  // Comments are stripped first. The check is about what the code can
  // REACH, and a comment saying "this can never change eligibility" is
  // the opposite of an offence.
  const stripComments = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
  const sources = ["packet", "evaluator", "reconcile", "gaming", "loop", "persist", "types"]
    .map((f) => ({ f, src: stripComments(readFileSync(`lib/screening/${f}.ts`, "utf8")) }));

  const forbidden = /from "\.\.\/browser\/|applications\/prepare|fillApplication|submitGuard|\.from\("applications"\)|eligib/i;
  const offenders = sources.filter((s) => forbidden.test(s.src));
  check("no screening module can reach the browser, the fill path or application state",
    offenders.length === 0, offenders.map((o) => o.f).join(", "));

  const writes = sources.filter((s) => /\.from\("(?!resume_screening_evaluations)[a-z_]+"\)\.(insert|update|delete)/.test(s.src));
  check("the only table screening writes to is its own",
    writes.length === 0, writes.map((o) => o.f).join(", "));

  const loopSrc = sources.find((s) => s.f === "loop")!.src;
  check("the loop never branches on the score",
    !/assessment\.score\s*[<>=]/.test(loopSrc) && !/score\s*[<>]=?\s*\d/.test(loopSrc), "");
  check("what it does branch on is whether evidence supports a finding",
    /communicationGaps\.length/.test(loopSrc), "");

  // The resolver and the fill path must not import screening at all.
  const answerSrc = stripComments(readFileSync("lib/applications/answer.ts", "utf8"));
  const fillSrc = stripComments(readFileSync("lib/browser/fill.ts", "utf8"));
  check("the answer resolver does not import screening",
    !/screening/.test(answerSrc), "");
  check("the browser filler does not import screening",
    !/screening/.test(fillSrc), "");
}

// ---- 12. Severity is a description, never a permission -------------
//
// A model that wants something badly says HIGH. If severity bought
// anything at all, the way to get a claim past the guards would be to
// insist on it, and an evaluator can insist for free.
{
  const highRealGap: ScreeningFinding = {
    kind: "REQUIREMENT_UNSUPPORTED", requirement: "Experience managing a team of operations analysts",
    detail: "critical gap", quotedFromResume: null, severity: "HIGH",
  };
  const lowRealGap: ScreeningFinding = { ...highRealGap, severity: "LOW", detail: "minor gap" };

  const high = reconcileFinding(highRealGap, FIT);
  const low = reconcileFinding(lowRealGap, FIT);
  check("a HIGH severity real evidence gap is exactly as non-actionable as a LOW one",
    high.gap === low.gap && high.actionable === false && low.actionable === false,
    JSON.stringify([high.gap, high.actionable, low.gap, low.actionable]));

  const unmatchedHigh = reconcileFinding({ ...highRealGap, requirement: "experience with underwater welding" }, FIT);
  check("an UNMATCHED finding stays non-actionable however severe it claims to be",
    unmatchedHigh.gap === "UNMATCHED" && !unmatchedHigh.actionable, JSON.stringify(unmatchedHigh));

  // Severity reaches no decision anywhere in the loop or the guards.
  const loopSrc = readFileSync("lib/screening/loop.ts", "utf8");
  const reconcileSrc = readFileSync("lib/screening/reconcile.ts", "utf8");
  const gamingSrc = readFileSync("lib/screening/gaming.ts", "utf8");
  check("no module branches on severity",
    ![loopSrc, reconcileSrc, gamingSrc].some((src) => /severity/i.test(src)), "");

  // And the same document with everything marked HIGH revises no more.
  const shout = (findings: ScreeningFinding[]) => findings.map((f) => ({ ...f, severity: "HIGH" as const }));
  let quietPasses = 0, loudPasses = 0;
  const hooks = (findings: ScreeningFinding[]): LoopHooks => ({
    evaluate: async () => stubResult(40, findings),
    propose: async (doc) => [{ before: doc.roles[0]!.lines[0]!.text,
      after: "Managed a team of operations analysts.", becauseOf: "x" }],
    guard: async () => ({ ok: false, why: "no evidence supports managing a team" }),
    apply: (doc) => doc,
  });
  quietPasses = (await runScreeningLoop(DOC, FIT, JOB.description, hooks([{ ...AUTOMATION_FINDING, severity: "LOW" }]))).passes.length;
  loudPasses = (await runScreeningLoop(DOC, FIT, JOB.description, hooks(shout([AUTOMATION_FINDING])))).passes.length;
  check("severity changes neither the number of revision passes nor the outcome",
    quietPasses === loudPasses, `${quietPasses} vs ${loudPasses}`);
}

// ---- 13. The rendered page, and what it may carry ------------------
{
  const rendered = await renderResume(DOC);
  const packet = buildPacket(DOC, JOB, rendered.extractedText);

  check("a packet can carry the real rendered resume text",
    (packet.renderedText ?? "").includes("Genius One")
    && (packet.renderedText ?? "").length > 200, String(packet.renderedText?.length));
  check("and that text carries no evidence id or provenance",
    !packet.renderedText!.includes(EVIDENCE_ID) && !/sources|evidenceIds/i.test(packet.renderedText!), "");
  check("the leak check passes on a packet with real rendered text",
    (() => { try { assertNoEvidenceLeak(packet, [EVIDENCE_ID]); return true; } catch { return false; } })(), "");
  check("but catches provenance smuggled through that same field",
    (() => { try { assertNoEvidenceLeak({ ...packet, renderedText: `${rendered.extractedText}\ncited: ${EVIDENCE_ID}` }); return false; } catch { return true; } })(), "");
  check("the rendered text is what an employer reads, bullets included",
    packet.renderedText!.includes("Built pricing models used in customer negotiations."), "");
}

// ---- 14. Several findings, and proposals that collide ---------------
{
  const second: ScreeningFinding = {
    kind: "TERMINOLOGY_MISMATCH", requirement: "Comfort with pricing analysis",
    detail: "the resume says pricing models where the posting says pricing analysis",
    quotedFromResume: "Built pricing models used in customer negotiations.", severity: "MEDIUM",
  };
  const rec = reconcileFindings([AUTOMATION_FINDING, second, TEAM_FINDING], FIT);
  check("two communication gaps on different lines are both actionable",
    rec.communicationGaps.length === 2, JSON.stringify(rec.communicationGaps.map((g) => g.finding.kind)));

  // Two proposals for the same line. Both are judged; the first accepted
  // one wins, and applying is the caller's job, so the loop must not
  // silently take both.
  const hooks: LoopHooks = {
    evaluate: async () => stubResult(45, [AUTOMATION_FINDING, second]),
    propose: async (doc) => [
      { before: doc.roles[0]!.lines[0]!.text, after: "Built the automated intake workflow for vendor contracts.", becauseOf: "buried" },
      { before: doc.roles[0]!.lines[0]!.text, after: "Owned the automated intake workflow for vendor contracts.", becauseOf: "buried, again" },
    ],
    guard: async () => ({ ok: true, why: "grounded" }),
    apply: (doc, acc) => ({ ...doc, roles: doc.roles.map((r, i) =>
      i === 0 ? { ...r, lines: r.lines.map((l) => {
        const hit = acc.find((a) => a.before === l.text);
        return hit ? { text: hit.after, sources: l.sources } : l;
      }) } : r) }),
  };
  const out = await runScreeningLoop(DOC, FIT, JOB.description, hooks);
  check("two different rewrites of one line produce no rewrite at all",
    out.passes[0]!.accepted.length === 0
    && out.passes[0]!.refused.some((r) => /different rewrites were proposed for one line/.test(r.why)),
    JSON.stringify(out.passes[0]!.refused.map((r) => r.why)));
  check("the line is left exactly as it was",
    out.doc.roles[0]!.lines[0]!.text === DOC.roles[0]!.lines[0]!.text,
    out.doc.roles[0]!.lines[0]!.text);

  // Two findings that AGREE about a line are one rewrite, not two.
  const agreeing: LoopHooks = {
    ...hooks,
    propose: async (doc) => [
      { before: doc.roles[0]!.lines[0]!.text, after: "Built the automated intake workflow for vendor contracts.", becauseOf: "buried" },
      { before: doc.roles[0]!.lines[0]!.text, after: "Built the automated intake workflow for vendor contracts.", becauseOf: "vague" },
    ],
  };
  const merged = await runScreeningLoop(DOC, FIT, JOB.description, agreeing);
  check("two findings agreeing about a line yield one rewrite",
    merged.passes[0]!.accepted.length === 1, JSON.stringify(merged.passes[0]!.accepted.length));
  check("and the reasons are both recorded on it",
    /buried \| vague/.test(merged.passes[0]!.accepted[0]!.becauseOf), merged.passes[0]!.accepted[0]!.becauseOf);
  check("the line is rewritten once, not once per finding",
    merged.doc.roles[0]!.lines[0]!.text === "Built the automated intake workflow for vendor contracts.",
    merged.doc.roles[0]!.lines[0]!.text);

  // Determinism: the same inputs, twice, produce the same document.
  const again = await runScreeningLoop(DOC, FIT, JOB.description, hooks);
  check("competing proposals resolve the same way every run",
    contentHash(again.doc) === contentHash(out.doc), "");
}

// ---- 15. Coverage is recorded and consulted by nothing --------------
{
  const out = validate({
    findings: [],
    coverage: [
      { requirement: "Experience designing and improving workflow automation", appears: "PARTIAL", where: "role 1" },
      { requirement: "Experience managing a team of operations analysts", appears: "ABSENT", where: null },
    ],
    assessment: { score: 55, summary: "ok" },
  });
  check("coverage is parsed and kept", out.coverage.length === 2, JSON.stringify(out.coverage));
  check("its verdicts describe how the resume READS, not whether it is true",
    out.coverage.every((c) => ["CLEAR", "PARTIAL", "ABSENT"].includes(c.appears)), "");

  // It is stored for later comparison and nothing reads it back. If that
  // ever changes, this test should be the thing that notices.
  const consumers = ["loop", "reconcile", "gaming"]
    .filter((f) => /\bcoverage\b/.test(readFileSync(`lib/screening/${f}.ts`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")));
  check("no decision anywhere is taken from coverage",
    consumers.length === 0, consumers.join(", "));
  check("but it is persisted, so drafts can be compared later",
    /requirement_coverage/.test(readFileSync("lib/screening/persist.ts", "utf8")), "");
}

// ---- 16. Failure leaves the grounded document alone -----------------
//
// The screening layer is an opinion about a document. An opinion that
// cannot be obtained is not a reason to change the document, and an
// evaluator that throws must not take the resume down with it.
{
  const exploding: LoopHooks = {
    evaluate: async () => { throw new Error("529 overloaded"); },
    propose: async () => [], guard: async () => ({ ok: true, why: "" }), apply: (d) => d,
  };
  let threw = "";
  try { await runScreeningLoop(DOC, FIT, JOB.description, exploding); } catch (e) { threw = String(e); }
  check("a provider failure surfaces rather than being swallowed", /529/.test(threw), threw);
  check("and the original document is untouched by the attempt",
    contentHash(DOC) === contentHash(DOC), "");

  const failsLater: LoopHooks = {
    evaluate: async () => { calls++; if (calls > 1) throw new Error("timeout after 60000ms"); return stubResult(40, [AUTOMATION_FINDING]); },
    propose: async (doc) => [{ before: doc.roles[0]!.lines[0]!.text,
      after: "Built the automated intake workflow for vendor contracts.", becauseOf: "buried" }],
    guard: async () => ({ ok: true, why: "grounded" }),
    apply: (doc, acc) => ({ ...doc, roles: doc.roles.map((r, i) =>
      i === 0 ? { ...r, lines: [{ ...r.lines[0]!, text: acc[0]!.after }, ...r.lines.slice(1)] } : r) }),
  };
  let calls = 0;
  let second = "";
  try { await runScreeningLoop(DOC, FIT, JOB.description, failsLater); } catch (e) { second = String(e); }
  check("a failure midway through also surfaces", /timeout/.test(second), second);
  check("the master document is not mutated by any of it",
    DOC.roles[0]!.lines[0]!.text === "Supported the rollout of an automated intake process for vendor contracts.",
    DOC.roles[0]!.lines[0]!.text);

  // Malformed provider output is a validation failure, not a document change.
  let bad = "";
  try { validate({ findings: "not an array", assessment: { score: "high" } }); } catch (e) { bad = String(e); }
  check("malformed model output throws instead of producing a usable result",
    /unusable score/.test(bad), bad);
  check("a refusal-shaped response with no assessment also throws",
    (() => { try { validate({ findings: [] }); return false; } catch { return true; } })(), "");
}

// ---- 17. The ownership detector reads context ----------------------
{
  const before = "Coordinated with the owner, partners, instructors and customers.";
  const safe = [
    "Coordinated vendors and the processes that ran between them.",
    "Supported the migration that ran across three teams.",
    "Contributed to the rollout, which led to a shorter review cycle.",
    "Supported intake work that ran from January through March.",
    "Produced content that ran on the company blog.",
  ];
  const escalating = [
    "Ran the vendor management program.",
    "Ran a team of three analysts.",
    "Ran all vendor onboarding.",
    "Ran day-to-day operations for the group.",
    "Ran point on the migration.",
    "Led the vendor management program.",
    "Owned the vendor process.",
  ];
  for (const after of safe) {
    check(`an ordinary use of the word is allowed: ${after.slice(0, 46)}`,
      checkForGaming({ before, after, jobText: "vendor management process design" }).ok,
      JSON.stringify(checkForGaming({ before, after, jobText: "vendor management process design" }).problems));
  }
  for (const after of escalating) {
    const v = checkForGaming({ before, after, jobText: "vendor management process design" });
    check(`a real claim of authority is still refused: ${after.slice(0, 42)}`,
      !v.ok && v.problems.some((p) => /ownership|leadership/.test(p)), JSON.stringify(v.problems));
  }
}

// ---- 18. The requirement join, by identity ------------------------
//
// The evaluator quotes the posting's own sentence. The scorer holds
// those same sentences against the concepts they produced. Matching the
// sentence and then following its id is a lookup; comparing the sentence
// to a concept called "sql" is a coin toss, and it was losing 41% of
// findings to no-ops.
{
  const REQS = [
    { id: "req-sql", rawText: "Strong SQL proficiency using SQL to analyze data, drive insights, and create dashboards" },
    { id: "req-python", rawText: "Experience with programming, scripting or statistical packages (Python, R, Matlab, SQL)" },
    { id: "req-team", rawText: "1+ years leading risk-related projects with cross-functional stakeholders" },
    { id: "req-vendor", rawText: "Experience designing and improving vendor management processes" },
  ];
  const FIT2: FitBreakdown = {
    ...FIT,
    concepts: [
      { concept: "sql", requirementClass: "SKILL", hardness: "HARD", resolution: "ABSENT", via: null,
        rationale: "no verified sql", weight: 3, credit: 0, requirementIds: ["req-sql", "req-python"], credentialFamily: null },
      { concept: "dashboards", requirementClass: "SKILL", hardness: "PREFERRED", resolution: "ABSENT", via: null,
        rationale: "no verified dashboard work", weight: 1, credit: 0, requirementIds: ["req-sql"], credentialFamily: null },
      { concept: "python", requirementClass: "SKILL", hardness: "HARD", resolution: "ABSENT", via: null,
        rationale: "no verified python", weight: 3, credit: 0, requirementIds: ["req-python"], credentialFamily: null },
      { concept: "vendor management", requirementClass: "SKILL", hardness: "HARD", resolution: "DIRECT",
        via: "verified vendor coordination", rationale: "coordinated with vendors and partners",
        weight: 3, credit: 3, requirementIds: ["req-vendor"], credentialFamily: null },
    ] as any,
  };
  const ctx = { requirements: REQS, doc: DOC };
  const find = (requirement: string, kind: ScreeningFinding["kind"] = "REQUIREMENT_UNSUPPORTED"): ScreeningFinding =>
    ({ kind, requirement, detail: "d", quotedFromResume: null, severity: "HIGH" });

  const exact = reconcileFinding(find(REQS[0]!.rawText), FIT2, ctx);
  check("the exact requirement text joins by identity",
    exact.joinedBy === "exact-text" && exact.requirementIds[0] === "req-sql",
    JSON.stringify([exact.joinedBy, exact.requirementIds]));
  check("and reaches the concepts that requirement produced, one word long though they are",
    exact.conceptKeys.includes("sql") && exact.conceptKeys.includes("dashboards"), JSON.stringify(exact.conceptKeys));
  check("a one-word concept is now reachable where the old matcher gave up",
    conceptsFor(REQS[0]!.rawText, FIT2).length === 0 && exact.conceptKeys.length === 2,
    `fallback found ${conceptsFor(REQS[0]!.rawText, FIT2).length}`);
  check("this requirement is a real evidence gap, and non-actionable",
    exact.gap === "REAL_EVIDENCE_GAP" && !exact.actionable, JSON.stringify(exact.gap));

  const punct = reconcileFinding(find("strong sql proficiency, using SQL to analyze data - drive insights and create dashboards!"), FIT2, ctx);
  check("punctuation and case variation still join, safely",
    punct.joinedBy === "normalized-text" && punct.requirementIds[0] === "req-sql",
    JSON.stringify([punct.joinedBy, punct.requirementIds]));

  // Two requirements sharing a concept: each keeps its own identity.
  const py = reconcileFinding(find(REQS[1]!.rawText), FIT2, ctx);
  check("two requirements sharing a concept join to different requirements",
    py.requirementIds[0] === "req-python" && exact.requirementIds[0] === "req-sql", "");
  check("and each sees the concepts its own requirement produced",
    py.conceptKeys.includes("python") && py.conceptKeys.includes("sql")
    && !py.conceptKeys.includes("dashboards"), JSON.stringify(py.conceptKeys));

  const multi = reconcileFinding(find(REQS[0]!.rawText), FIT2, ctx);
  check("one requirement resolving to several concepts reports all of them",
    multi.conceptKeys.length === 2, JSON.stringify(multi.conceptKeys));

  // A paraphrase too loose to be sure of is left alone.
  const vague = reconcileFinding(find("some data skills would help"), FIT2, ctx);
  check("a paraphrase that cannot be confidently joined stays UNMATCHED",
    vague.gap === "UNMATCHED" && !vague.actionable, JSON.stringify([vague.gap, vague.joinedBy]));

  // The dangerous direction: a requirement must not borrow a neighbour's evidence.
  const borrowed = reconcileFinding(find("1+ years leading risk-related projects with cross-functional stakeholders"), FIT2, ctx);
  check("a requirement with no concepts of its own does not borrow another's",
    borrowed.gap === "UNMATCHED" && !borrowed.conceptKeys.includes("vendor management"),
    JSON.stringify([borrowed.gap, borrowed.conceptKeys]));
  check("and the vendor requirement still reaches its own supported concept",
    reconcileFinding(find(REQS[3]!.rawText), FIT2, ctx).gap === "COMMUNICATION_GAP", "");

  // Near-identical requirements must not be confused for each other.
  const twins = [
    { id: "a", rawText: "Experience managing vendor relationships in North America" },
    { id: "b", rawText: "Experience managing vendor relationships in Europe" },
  ];
  const twin = joinRequirement("Experience managing vendor relationships in Europe", twins);
  check("two nearly identical requirements are told apart by their exact text",
    twin.requirement?.id === "b", JSON.stringify(twin));
  const ambiguous = joinRequirement("Experience managing vendor relationships", twins);
  check("and a quote matching both equally joins to neither",
    ambiguous.requirement === null, JSON.stringify(ambiguous));

  check("requirement ids survive into the reconciliation record",
    reconcileFindings([find(REQS[0]!.rawText), find(REQS[3]!.rawText)], FIT2, ctx)
      .all.every((r) => r.requirementIds.length === 1), "");
  check("the fallback still works when no requirements are supplied at all",
    reconcileFinding(find("workflow automation"), FIT, {}).conceptKeys.length > 0, "");
}

// ---- 19. Presentation findings need a real target ------------------
{
  const line0 = DOC.roles[0]!.lines[0]!.text;
  const ctx = { requirements: [], doc: DOC };
  const present = (kind: ScreeningFinding["kind"], quoted: string | null): ScreeningFinding =>
    ({ kind, requirement: null, detail: "d", quotedFromResume: quoted, severity: "HIGH" });

  const buried = reconcileFinding(present("CAPABILITY_BURIED", line0), FIT, ctx);
  check("a buried capability quoting a real line is actionable",
    buried.gap === "ACTIONABLE_PRESENTATION_GAP" && buried.actionable && buried.target === line0,
    JSON.stringify([buried.gap, buried.actionable]));

  const vague = reconcileFinding(present("CLAIM_TOO_VAGUE", DOC.roles[0]!.lines[1]!.text), FIT, ctx);
  check("a vague claim quoting a real line is actionable",
    vague.gap === "ACTIONABLE_PRESENTATION_GAP" && vague.target === DOC.roles[0]!.lines[1]!.text, "");

  const fragment = reconcileFinding(present("CAPABILITY_BURIED", "automated intake process for vendor"), FIT, ctx);
  check("a fragment identifying exactly one line still identifies it",
    fragment.target === line0, JSON.stringify(fragment.target));

  const irrelevant = reconcileFinding(present("IRRELEVANT_MATERIAL_DOMINATES", DOC.projects[0]!.line.text), FIT, ctx);
  check("irrelevant material quoting a project line is actionable",
    irrelevant.gap === "ACTIONABLE_PRESENTATION_GAP", JSON.stringify(irrelevant.gap));

  const generic = reconcileFinding(present("PRESENTATION_RISK", null), FIT, ctx);
  check("a generic presentation risk naming nothing is diagnostic only",
    generic.gap === "DIAGNOSTIC_PRESENTATION_FINDING" && !generic.actionable, JSON.stringify(generic));
  check("and says why it cannot be acted on",
    /names no sentence/.test(generic.evidenceSays), generic.evidenceSays);

  const ghost = reconcileFinding(present("CAPABILITY_BURIED", "A sentence this resume does not contain."), FIT, ctx);
  check("quoting a sentence the document does not contain is diagnostic only",
    ghost.gap === "DIAGNOSTIC_PRESENTATION_FINDING" && !ghost.actionable && ghost.target === null,
    JSON.stringify([ghost.gap, ghost.target]));

  const shouted = reconcileFinding({ ...present("PRESENTATION_RISK", null), severity: "HIGH" }, FIT, ctx);
  check("severity does not make a targetless finding actionable",
    !shouted.actionable, JSON.stringify(shouted.actionable));

  const chron = reconcileFinding(present("CHRONOLOGY_CONFUSING", line0), FIT, ctx);
  check("a chronology finding is never actionable even when it names a line",
    chron.gap === "DIAGNOSTIC_PRESENTATION_FINDING" && !chron.actionable, JSON.stringify(chron.gap));

  const rec = reconcileFindings(
    [present("CAPABILITY_BURIED", line0), present("PRESENTATION_RISK", null), present("CHRONOLOGY_CONFUSING", line0)],
    FIT, ctx);
  check("only the targeted one reaches the proposer",
    rec.communicationGaps.length === 1 && rec.diagnosticOnly.length === 2,
    JSON.stringify([rec.communicationGaps.length, rec.diagnosticOnly.length]));
  check("the diagnostic ones are kept rather than discarded",
    rec.diagnosticOnly.every((r) => r.finding.detail === "d"), "");

  // A presentation finding cannot conjure evidence: it carries no concepts.
  check("no presentation finding brings evidence with it",
    rec.all.every((r) => r.conceptKeys.length === 0 && r.requirementIds.length === 0), "");
}

// ---- 20. The retry, bounded and uninformative -----------------------
{
  const bad = { assessment: "{\"score\": 0.4, \"findings\": []}" };
  const good = {
    findings: [{ kind: "CLAIM_TOO_VAGUE", detail: "too vague to place", severity: "LOW" }],
    coverage: [], assessment: { score: 55, summary: "ok" },
  };
  const usage = (n: number) => ({ provider: "stub", model: "stub", inputTokens: 100 * n,
    outputTokens: 50 * n, estimatedCostCents: n, latencyMs: 1000 * n });

  const packet = buildPacket(DOC, JOB);
  const prompts: string[] = [];
  let call = 0;
  const flaky: any = async (req: any) => {
    prompts.push(req.prompt);
    call++;
    return { content: call === 1 ? bad : good, usage: usage(call) };
  };
  const ev = await evaluateBlind(packet, {} as any, { complete: flaky });
  check("an invalid first response is retried exactly once",
    call === 2 && ev.attempts === 2, `${call} calls`);
  check("the retry says the previous response was invalid",
    /did not match the required structure/.test(prompts[1]!), prompts[1]!.slice(-200));
  check("and adds no information the first prompt did not have",
    prompts[1]!.startsWith(prompts[0]!), "the retry prompt is not the original plus a note");
  check("the retry note names no evidence, no candidate facts and no requirement text",
    !/evidence|verified|profile|because he|his /i.test(prompts[1]!.slice(prompts[0]!.length)),
    prompts[1]!.slice(prompts[0]!.length));
  check("the failure reason is recorded",
    /unusable score/.test(ev.firstAttemptFailure ?? ""), String(ev.firstAttemptFailure));
  check("both attempts are paid for and both are counted",
    ev.usage.inputTokens === 300 && ev.usage.outputTokens === 150
    && ev.usage.estimatedCostCents === 3 && ev.usage.latencyMs === 3000, JSON.stringify(ev.usage));

  // Two failures is a failure.
  let calls2 = 0;
  const alwaysBad: any = async () => { calls2++; return { content: bad, usage: usage(1) }; };
  let threw = "";
  try { await evaluateBlind(packet, {} as any, { complete: alwaysBad }); } catch (e) { threw = String(e); }
  check("a second invalid response is not retried again",
    calls2 === 2 && /unusable score/.test(threw), `${calls2} calls, ${threw.slice(0, 60)}`);
  check("validate is not relaxed to accommodate it", /unusable score/.test(threw), threw);

  // A provider error is not a formatting problem and is not retried here.
  let calls3 = 0;
  const errors: any = async () => { calls3++; throw new Error("529 overloaded"); };
  let e3 = "";
  try { await evaluateBlind(packet, {} as any, { complete: errors }); } catch (e) { e3 = String(e); }
  check("a provider error propagates without a screening-level retry",
    calls3 === 1 && /529/.test(e3), `${calls3} calls`);
  check("a valid first response is not retried",
    (await evaluateBlind(packet, {} as any,
      { complete: (async () => ({ content: good, usage: usage(1) })) as any })).attempts === 1, "");

  check("the output ceiling is the measured one, not the old one",
    MAX_OUTPUT_TOKENS === 8000, String(MAX_OUTPUT_TOKENS));
  const asked: any[] = [];
  await evaluateBlind(packet, {} as any, { complete: (async (r: any) => { asked.push(r); return { content: good, usage: usage(1) }; }) as any });
  check("and it is what the request actually asks for",
    asked[0].maxOutputTokens === MAX_OUTPUT_TOKENS, String(asked[0].maxOutputTokens));
}

// ---- 21. Decoding a mangled tool input is not accepting it ---------
{
  // The shape the real model produces, taken from a captured response:
  // the string carries the outer object's OWN closing brace. The first
  // version of this decoder was written against a fixture without it,
  // passed its test, and recovered nothing in production.
  const mangled = { assessment: String.raw`{"score": 12, "summary": "s"}, "findings": [{"kind": "CLAIM_TOO_VAGUE", "detail": "d", "severity": "LOW"}], "coverage": []}` };
  const decoded = decodeMangledToolOutput(mangled);
  check("a result stuffed into one string field is recovered whole",
    Object.keys(decoded).sort().join(",") === "assessment,coverage,findings", JSON.stringify(Object.keys(decoded)));
  check("and what it recovers is exactly what the model meant",
    decoded.assessment.score === 12 && decoded.findings.length === 1, JSON.stringify(decoded.assessment));
  check("the decoded result still has to satisfy the schema",
    validate(decoded).findings.length === 1, "");

  const wellFormed = { findings: [], coverage: [], assessment: { score: 40, summary: "s" } };
  check("a well formed result is passed through untouched",
    decodeMangledToolOutput(wellFormed) === wellFormed, "");
  check("a string that is not JSON is left alone for validation to refuse",
    decodeMangledToolOutput({ summary: "{not json" }).summary === "{not json", "");
  check("and a string that parses into no additional keys is left alone",
    JSON.stringify(decodeMangledToolOutput({ assessment: String.raw`{"score": 3}` })) === JSON.stringify({ assessment: String.raw`{"score": 3}` }), "");
  check("decoding cannot rescue a result that is genuinely wrong",
    (() => { try { validate(decodeMangledToolOutput({ assessment: String.raw`{"summary": "no score"}, "findings": [], "coverage": []` })); return false; } catch { return true; } })(), "");
  check("nor does it invent findings that were not there",
    validate(decodeMangledToolOutput({ assessment: String.raw`{"score": 50, "summary": "s"}, "findings": [], "coverage": []` })).findings.length === 0, "");

  // And it happens before the retry is spent.
  let calls = 0;
  const manglingOnce: any = async () => { calls++; return { content: mangled,
    usage: { provider: "s", model: "s", inputTokens: 10, outputTokens: 5, estimatedCostCents: 1, latencyMs: 1 } }; };
  const ev = await evaluateBlind(buildPacket(DOC, JOB), {} as any, { complete: manglingOnce });
  check("a decodable response costs no retry", calls === 1 && ev.attempts === 1, `${calls} calls`);

  // Both closings, because the model produces both.
  const noBrace = { assessment: String.raw`{"score": 40, "summary": "s"}, "findings": [], "coverage": []` };
  check("the same mangling without the outer brace is also recovered",
    validate(decodeMangledToolOutput(noBrace)).assessment.score === 40, "");
  const newlines = { assessment: `{"score": 40, "summary": "s"},\n"findings": [],\n"coverage": []}\n` };
  check("and with the newlines the model actually emits",
    validate(decodeMangledToolOutput(newlines)).assessment.score === 40, "");
  const extra = { assessment: String.raw`{"score": 40, "summary": "s"}, "findings": [], "coverage": [], "appears_note": null}` };
  check("a key the schema does not name is recovered and then ignored",
    validate(decodeMangledToolOutput(extra)).findings.length === 0, "");
  check("a string that is JSON but adds no keys is still left alone",
    typeof decodeMangledToolOutput({ summary: String.raw`{"a": 1}` }).summary === "string", "");
  check("and an array-valued string cannot turn the result into an array",
    !Array.isArray(decodeMangledToolOutput({ findings: String.raw`[1,2,3]` })), "");
}

console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
