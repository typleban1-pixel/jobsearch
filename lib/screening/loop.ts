/**
 * Three gates, in order, with only one of them able to change anything.
 *
 *   1. Truth. Every employer-facing sentence is supported by evidence
 *      that was already there. Failure BLOCKS: there is no revision, no
 *      score, and no document.
 *   2. Structure. The document parses. Handled by the existing ATS
 *      checks and deliberately not merged into this file: a resume can
 *      be perfectly parseable and still say nothing a recruiter needs,
 *      and a resume can read beautifully and confuse a parser.
 *   3. Communication. The strongest truthful evidence is visible. This
 *      is the only gate whose failure produces a rewrite, and even then
 *      the rewrite goes back through gate 1 before it counts.
 *
 * The loop is bounded at two revision passes. Not as a cost control:
 * an unbounded loop against a scoring model converges on whatever that
 * model rewards, and what it rewards is not what is true. Two passes fix
 * an oversight. Ten passes write a different document.
 */
import { checkForGaming, checkStructureUnchanged, type GamingVerdict } from "./gaming.ts";
import { reconcileFindings, type Reconciliation } from "./reconcile.ts";
import type { ScreeningResult } from "./types.ts";
import type { FitBreakdown } from "../scoring/fit.ts";
import type { ResumeDoc } from "../render/resume.ts";

export const LOOP_VERSION = 1;

/** Two passes after the original. Stated as a constant so a test can hold it. */
export const MAX_REVISION_PASSES = 2;

export interface RevisionProposal {
  /** The line being replaced, exactly as it appears now. */
  before: string;
  /** The proposed replacement. */
  after: string;
  /** The finding it answers. */
  becauseOf: string;
}

/**
 * What the caller supplies.
 *
 * `propose` writes replacement lines from evidence that already exists;
 * it is the same grounded generation path the original document used,
 * and it never receives the evaluator's wording as text to copy.
 * `guard` is the existing claim/provenance check, unchanged and
 * authoritative.
 */
export interface LoopHooks {
  evaluate: (doc: ResumeDoc) => Promise<ScreeningResult>;
  propose: (doc: ResumeDoc, gaps: Reconciliation["communicationGaps"]) => Promise<RevisionProposal[]>;
  guard: (doc: ResumeDoc, proposal: RevisionProposal) => Promise<{ ok: boolean; why: string }>;
  apply: (doc: ResumeDoc, accepted: RevisionProposal[]) => ResumeDoc;
}

export interface PassRecord {
  iteration: number;
  score: number;
  findings: number;
  communicationGaps: number;
  realEvidenceGaps: number;
  accepted: RevisionProposal[];
  refused: Array<{ proposal: RevisionProposal; why: string }>;
}

export interface LoopOutcome {
  doc: ResumeDoc;
  passes: PassRecord[];
  /** Gaps the evidence does not support. Recorded, never optimized away. */
  outstandingEvidenceGaps: string[];
  first: ScreeningResult;
  last: ScreeningResult;
  stoppedBecause: string;
}

const structureOf = (doc: ResumeDoc) => ({
  titles: doc.roles.map((r) => r.title),
  employers: doc.roles.map((r) => r.employer),
  dates: doc.roles.map((r) => `${r.start}/${r.end ?? ""}/${r.startPrecision}/${r.endPrecision}`),
  education: doc.education.map((e) => `${e.credential}/${e.field ?? ""}/${e.institution}`),
});

/**
 * Runs the bounded loop.
 *
 * A proposal has to clear three separate things before it lands: the
 * evidence guard, which decides whether the sentence is supported; the
 * gaming check, which decides whether it is the same claim as the one it
 * replaces; and the structural check, which refuses any revision that
 * moved a title, an employer, a date or a credential. All three are
 * refusals, and a refusal is recorded rather than retried with softer
 * wording.
 */
export async function runScreeningLoop(
  doc: ResumeDoc, fit: FitBreakdown, jobText: string, hooks: LoopHooks,
): Promise<LoopOutcome> {
  const passes: PassRecord[] = [];
  let current = doc;

  const first = await hooks.evaluate(current);
  let last = first;
  let stoppedBecause = `the loop's ceiling of ${MAX_REVISION_PASSES} revision passes was reached`;
  const outstanding = new Set<string>();

  for (let iteration = 1; iteration <= MAX_REVISION_PASSES; iteration++) {
    const reconciliation = reconcileFindings(last.findings, fit);
    for (const g of reconciliation.realEvidenceGaps) {
      outstanding.add(g.finding.requirement ?? g.finding.detail);
    }

    if (!reconciliation.communicationGaps.length) {
      stoppedBecause = iteration === 1
        ? "the first evaluation found nothing the evidence could fix"
        : "no communication gap remained that verified evidence could answer";
      break;
    }

    const raw = await hooks.propose(current, reconciliation.communicationGaps);
    const accepted: RevisionProposal[] = [];
    const refused: PassRecord["refused"] = [];

    // One line, one rewrite.
    //
    // Three findings pointed at the same bullet on a live run and it was
    // rewritten three times in sequence, each rewrite taking the last
    // one's output as its input. That is not three improvements, it is a
    // sentence drifting away from its evidence one step at a time. So
    // findings that agree about a line collapse to a single proposal,
    // and findings that disagree about it produce none: two different
    // rewrites of one sentence is a question about which is right, and
    // guessing is the wrong way to answer it.
    const byLine = new Map<string, RevisionProposal[]>();
    for (const p of raw) byLine.set(p.before, [...(byLine.get(p.before) ?? []), p]);

    const proposals: RevisionProposal[] = [];
    for (const [line, group] of byLine) {
      const distinct = [...new Set(group.map((g) => g.after))];
      if (distinct.length === 1) {
        proposals.push({ ...group[0]!,
          becauseOf: group.map((g) => g.becauseOf).join(" | ") });
        continue;
      }
      refused.push({ proposal: group[0]!,
        why: `${distinct.length} different rewrites were proposed for one line, so none was applied: `
          + "findings that disagree about a sentence are reconciled by a person, not by picking one" });
      void line;
    }

    for (const p of proposals) {
      // 1. Is the sentence supported at all? The existing guard decides,
      //    and nothing here can overrule it.
      const guarded = await hooks.guard(current, p);
      if (!guarded.ok) { refused.push({ proposal: p, why: guarded.why }); continue; }

      // 2. Is it the same claim as the one it replaces?
      const gaming: GamingVerdict = checkForGaming({ before: p.before, after: p.after, jobText });
      if (!gaming.ok) { refused.push({ proposal: p, why: gaming.problems.join("; ") }); continue; }

      accepted.push(p);
    }

    const next = accepted.length ? hooks.apply(current, accepted) : current;

    // 3. Nothing structural may have moved, whatever the proposals said.
    const b = structureOf(current), a = structureOf(next);
    const structural = checkStructureUnchanged({
      beforeTitles: b.titles, afterTitles: a.titles,
      beforeEmployers: b.employers, afterEmployers: a.employers,
      beforeDates: b.dates, afterDates: a.dates,
      beforeEducation: b.education, afterEducation: a.education,
    });
    if (!structural.ok) {
      passes.push({ iteration, score: last.assessment.score, findings: last.findings.length,
        communicationGaps: reconciliation.communicationGaps.length,
        realEvidenceGaps: reconciliation.realEvidenceGaps.length,
        accepted: [], refused: accepted.map((p) => ({ proposal: p, why: structural.problems.join("; ") })) });
      stoppedBecause = `a revision would have changed the record itself: ${structural.problems.join("; ")}`;
      break;
    }

    passes.push({ iteration, score: last.assessment.score, findings: last.findings.length,
      communicationGaps: reconciliation.communicationGaps.length,
      realEvidenceGaps: reconciliation.realEvidenceGaps.length, accepted, refused });

    if (!accepted.length) {
      stoppedBecause = "every proposed revision was refused, so the document stands as it was";
      break;
    }

    current = next;
    last = await hooks.evaluate(current);
  }

  // A last reconciliation, so gaps found by the final evaluation are
  // recorded too rather than lost at the loop's edge.
  for (const g of reconcileFindings(last.findings, fit).realEvidenceGaps) {
    outstanding.add(g.finding.requirement ?? g.finding.detail);
  }

  return {
    doc: current, passes, first, last, stoppedBecause,
    outstandingEvidenceGaps: [...outstanding],
  };
}
