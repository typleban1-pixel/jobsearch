/**
 * Which findings are writing problems, and which are facts.
 *
 * The evaluator cannot tell these apart, by design: it says "nothing
 * here shows SQL", and that sentence is equally true when the skill is
 * missing and when it is present but unmentioned. Only the evidence
 * system knows which.
 *
 * The difference decides everything that happens next. A communication
 * gap may be rewritten, using evidence that already exists. A real
 * evidence gap is left exactly as it is: the resume is right to be
 * silent about something the candidate has not done, and the only ways
 * to close it are the ways this system exists to prevent.
 *
 * The join is on requirement IDENTITY rather than on word similarity.
 * The evaluator quotes the posting's own sentence, because that is what
 * the packet showed it, and the scored requirements hold those same
 * sentences. Matching the sentence to the requirement and then following
 * the requirement to its concepts is a lookup. The earlier version
 * compared the quoted sentence against concept NAMES instead, and a
 * fifteen-word requirement could not share two words with a concept
 * called "sql": 41% of findings reconciled to nothing for that reason
 * alone.
 */
import type { FitBreakdown, ScorableConcept } from "../scoring/fit.ts";
import { COMMUNICATION_KINDS, type GapKind, type ReconciledFinding, type ScreeningFinding } from "./types.ts";
import type { ResumeDoc } from "../render/resume.ts";

export const RECONCILE_VERSION = 2;

/** A scored requirement, as the posting worded it. */
export interface ScoredRequirement {
  id: string;
  rawText: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Words too common to establish that two demands are the same demand. */
const STOP = new Set(["and", "or", "the", "a", "an", "of", "in", "to", "for", "with", "on", "at",
  "experience", "years", "strong", "excellent", "ability", "skills", "knowledge", "working", "work"]);

const terms = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));

/** How much of the shorter phrase the longer one contains. */
function overlap(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (!small.size) return 0;
  let shared = 0;
  for (const w of small) if (large.has(w)) shared++;
  return shared / small.size;
}

/**
 * The paraphrase has to be nearly all of the requirement.
 *
 * An evaluator quoting a requirement usually reproduces it or shortens
 * it. Two requirements from one posting routinely share half their
 * words, so anything below this is a coin toss between them, and a coin
 * toss is how a finding about SQL gets answered with evidence about
 * something else.
 */
export const HIGH_OVERLAP = 0.85;

export interface RequirementJoin {
  requirement: ScoredRequirement | null;
  how: ReconciledFinding["joinedBy"];
}

/**
 * Maps the requirement the evaluator quoted back to the scored one.
 *
 * Exact text first, then the same text with punctuation and case
 * normalized, then a paraphrase that is overwhelmingly the same words.
 * An ambiguous match is no match: where two requirements score equally
 * well, neither is chosen.
 */
export function joinRequirement(quoted: string | null, requirements: ScoredRequirement[]): RequirementJoin {
  if (!quoted || !requirements.length) return { requirement: null, how: "none" };

  const exact = requirements.filter((r) => r.rawText === quoted);
  if (exact.length === 1) return { requirement: exact[0]!, how: "exact-text" };

  const q = norm(quoted);
  const normalized = requirements.filter((r) => norm(r.rawText) === q);
  if (normalized.length === 1) return { requirement: normalized[0]!, how: "normalized-text" };

  const want = terms(quoted);
  const scored = requirements
    .map((r) => ({ r, score: overlap(want, terms(r.rawText)) }))
    .filter((x) => x.score >= HIGH_OVERLAP)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 1) return { requirement: scored[0]!.r, how: "high-overlap" };
  if (scored.length > 1 && scored[0]!.score > scored[1]!.score + 0.05) {
    return { requirement: scored[0]!.r, how: "high-overlap" };
  }
  return { requirement: null, how: "none" };
}

/**
 * Concepts reachable from a requirement, by its id.
 *
 * This is the authoritative path: the scorer recorded which requirements
 * produced which concept, and following that record cannot pair a
 * finding with a requirement the posting does not have.
 */
export function conceptsForRequirement(requirementId: string, fit: FitBreakdown): ScorableConcept[] {
  return fit.concepts.filter((c) => (c.requirementIds ?? []).includes(requirementId));
}

/**
 * The old path, kept only as a fallback and only when it is unambiguous.
 *
 * Measured against 20 real postings it produced no false matches, so it
 * is worth keeping for the cases where the evaluator paraphrases past
 * recognition. It is used ONLY when the identity join found nothing, and
 * it still refuses to guess: a weak overlap resolves to no match.
 */
export function conceptsFor(requirement: string | null, fit: FitBreakdown): ScorableConcept[] {
  if (!requirement) return [];
  const want = terms(requirement);
  if (!want.size) return [];

  const scored = fit.concepts.map((c) => {
    const have = terms(`${c.concept} ${c.rationale ?? ""}`);
    let shared = 0;
    for (const w of want) if (have.has(w)) shared++;
    return { c, shared, ratio: shared / want.size };
  });

  const strong = scored.filter((s) => s.shared >= 2 || (s.shared === 1 && s.ratio >= 0.5));
  return strong.sort((a, b) => b.shared - a.shared).slice(0, 3).map((s) => s.c);
}

/** Every sentence a rewrite could be aimed at. */
export function targetableLines(doc: ResumeDoc | null): string[] {
  if (!doc) return [];
  return [
    doc.summary.text,
    ...doc.roles.flatMap((r) => r.lines.map((l) => l.text)),
    ...doc.projects.map((p) => p.line.text),
  ];
}

/**
 * Does this presentation finding point at something that exists?
 *
 * The evaluator is asked to quote the sentence a presentation finding is
 * about. When it does, and the sentence is really in the document, a
 * rewrite has a target. When it does not, the finding is worth reading
 * and nothing more: choosing a target on its behalf would mean the
 * system deciding which sentence the model meant, which is exactly the
 * kind of guess this layer exists to avoid.
 */
export function resolveTarget(finding: ScreeningFinding, doc: ResumeDoc | null): string | null {
  const quoted = finding.quotedFromResume?.trim();
  if (!quoted) return null;
  const lines = targetableLines(doc);
  if (!lines.length) return null;

  const exact = lines.find((l) => l === quoted);
  if (exact) return exact;
  const q = norm(quoted);
  const normalized = lines.filter((l) => norm(l) === q);
  if (normalized.length === 1) return normalized[0]!;
  // A quotation that is a fragment of exactly one line still identifies
  // that line; a fragment matching several identifies nothing.
  const containing = lines.filter((l) => q.length >= 12 && norm(l).includes(q));
  return containing.length === 1 ? containing[0]! : null;
}

export interface ReconcileContext {
  /** The posting's scored requirements, with the text the packet showed. */
  requirements?: ScoredRequirement[];
  /** The document being evaluated, for verifying a finding's target. */
  doc?: ResumeDoc | null;
}

const PRESENTATION_KINDS: ScreeningFinding["kind"][] = [
  "CHRONOLOGY_CONFUSING", "IRRELEVANT_MATERIAL_DOMINATES", "PRESENTATION_RISK",
  "STRONGEST_EVIDENCE_UNDEREMPHASIZED", "CLAIM_TOO_VAGUE", "CAPABILITY_BURIED",
];

/**
 * Places one finding on the right side of the line.
 *
 * Order: findings the evaluator read as satisfied are set aside; a
 * requirement is joined by identity and answered from what the scorer
 * concluded about it; a finding about the page is judged on whether it
 * names a sentence that exists.
 */
export function reconcileFinding(
  finding: ScreeningFinding, fit: FitBreakdown, ctx: ReconcileContext = {},
): ReconciledFinding {
  const base = { finding, requirementIds: [] as string[], joinedBy: "none" as const, target: null as string | null };

  if (finding.kind === "REQUIREMENT_CLEARLY_SUPPORTED") {
    return { ...base, gap: "DIAGNOSTIC_PRESENTATION_FINDING",
             evidenceSays: "the evaluator read this as supported; nothing to reconcile",
             conceptKeys: [], actionable: false };
  }

  // A finding about the page rather than about a demand.
  if (!finding.requirement && PRESENTATION_KINDS.includes(finding.kind)) {
    const target = resolveTarget(finding, ctx.doc ?? null);
    const actionable = Boolean(target) && COMMUNICATION_KINDS.includes(finding.kind);
    return {
      ...base, target,
      gap: actionable ? "ACTIONABLE_PRESENTATION_GAP" : "DIAGNOSTIC_PRESENTATION_FINDING",
      evidenceSays: target
        ? `this is about how the page reads, and it names a sentence the document contains`
        : "this is about how the page reads but names no sentence the document contains, so there is nothing a rewrite could safely be aimed at",
      conceptKeys: [], actionable,
    };
  }

  // 1. Identity: the requirement the evaluator quoted, as the scorer holds it.
  const join = joinRequirement(finding.requirement, ctx.requirements ?? []);
  let concepts: ScorableConcept[] = [];
  let joinedBy: ReconciledFinding["joinedBy"] = join.how;
  let requirementIds: string[] = [];

  if (join.requirement) {
    requirementIds = [join.requirement.id];
    concepts = conceptsForRequirement(join.requirement.id, fit);
  }
  // 2. Fallback, only where identity found nothing, and still conservative.
  if (!concepts.length) {
    concepts = conceptsFor(finding.requirement, fit);
    joinedBy = concepts.length ? "concept-fallback" : join.requirement ? join.how : "none";
    if (concepts.length) requirementIds = [...new Set(concepts.flatMap((c) => c.requirementIds ?? []))];
  }

  if (!concepts.length) {
    return { ...base, joinedBy,
      requirementIds,
      gap: "UNMATCHED",
      evidenceSays: finding.requirement
        ? join.requirement
          ? `the requirement ${JSON.stringify(finding.requirement.slice(0, 60))} was identified but the scorer produced no concept for it`
          : `no scored requirement of this posting corresponds to ${JSON.stringify(finding.requirement.slice(0, 60))}`
        : "the finding names no requirement",
      conceptKeys: [], actionable: false };
  }

  const supported = concepts.filter((c) => c.resolution === "DIRECT" || c.resolution === "TRANSFERABLE");
  const conceptKeys = concepts.map((c) => c.concept);

  if (supported.length) {
    const gap: GapKind = "COMMUNICATION_GAP";
    return {
      ...base, gap, conceptKeys, requirementIds, joinedBy,
      evidenceSays: `the evidence establishes ${supported.map((c) => `${c.concept} (${c.resolution}${c.via ? ` via ${c.via}` : ""})`).join("; ")}`
        + ", so a reader missing it is a problem with the resume rather than with the record",
      actionable: COMMUNICATION_KINDS.includes(finding.kind),
    };
  }

  return {
    ...base, gap: "REAL_EVIDENCE_GAP", conceptKeys, requirementIds, joinedBy,
    evidenceSays: `the evidence does not establish ${concepts.map((c) => `${c.concept} (${c.resolution})`).join("; ")}`
      + ". The resume is right to be silent about it, and it stays that way.",
    actionable: false,
  };
}

export interface Reconciliation {
  all: ReconciledFinding[];
  communicationGaps: ReconciledFinding[];
  realEvidenceGaps: ReconciledFinding[];
  /** Presentation observations kept for the record and acted on by nothing. */
  diagnosticOnly: ReconciledFinding[];
}

export function reconcileFindings(
  findings: ScreeningFinding[], fit: FitBreakdown, ctx: ReconcileContext = {},
): Reconciliation {
  const all = findings.map((f) => reconcileFinding(f, fit, ctx));
  return {
    all,
    // Everything a revision pass may act on: an evidence-backed
    // requirement gap, or a presentation gap with a verified target.
    communicationGaps: all.filter((r) => r.actionable
      && (r.gap === "COMMUNICATION_GAP" || r.gap === "ACTIONABLE_PRESENTATION_GAP")),
    realEvidenceGaps: all.filter((r) => r.gap === "REAL_EVIDENCE_GAP"),
    diagnosticOnly: all.filter((r) => r.gap === "DIAGNOSTIC_PRESENTATION_FINDING"),
  };
}
