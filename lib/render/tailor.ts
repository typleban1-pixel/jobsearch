/**
 * Tailored resume generation.
 *
 * The model is a PROPOSER. It receives only the evidence rows selected for
 * one bullet and rewrites within them. It never sees the full profile, so
 * it cannot borrow a fact from elsewhere, and it never sees the job
 * description's phrasing, so it cannot echo language the evidence does not
 * support. Then every proposal goes through checkGrounding, which is the
 * authority.
 *
 * A proposal that fails is REJECTED and RECORDED, never softened until it
 * passes. If nothing survives for a bullet, the original master-resume
 * line is used unchanged: falling back to verified text is always
 * available, so there is never pressure to accept a doubtful rewrite.
 */
import { checkGrounding, GROUNDING_VERSION, type GroundingVerdict } from "./grounding.ts";
import type { LlmProvider } from "../llm/provider.ts";

export const TAILOR_VERSION = 1;

export interface EvidenceRow { id: string; text: string; kind: string }

export interface BulletSource {
  /** The master resume's own wording, which is already verified. */
  original: string;
  evidence: EvidenceRow[];
  /**
   * The implementation state the evidence declares, when it declares
   * one. Project evidence carries it; nothing else does yet. A state
   * other than CURRENT fixes the wording, so a rewrite of it is refused
   * by NO_STATE_ESCALATION and the master wording is used instead.
   */
  implementationState?: string;
}

export interface TailoredBullet {
  /**
   * The master line this was derived from.
   *
   * Assembly matches on this. Matching on the evidence set instead
   * collapsed every claim citing one employment record into a single
   * bullet, then fanned it back out: four distinct Holley claims became
   * the same sentence four times.
   */
  original: string;
  text: string;
  evidenceIds: string[];
  sourceText: string;
  generation: "SELECTED" | "REORDERED" | "REFRAMED";
  verdict: GroundingVerdict;
}

export interface RejectedBullet {
  original: string;
  proposed: string;
  evidenceIds: string[];
  sourceText: string;
  failedCheck: string;
  failureDetail: string;
}

export interface TailorResult {
  accepted: TailoredBullet[];
  rejected: RejectedBullet[];
  /** Bullets that fell back to the master wording because no rewrite survived. */
  fellBack: number;
}

const SYSTEM = `You rewrite one resume bullet so it speaks to a specific role.

You are given EVIDENCE: verified statements about what this person did.
You may only restate what the evidence says. You may reorder it, compress
it, change emphasis, and choose plainer words.

You may NOT:
- add any number, percentage, duration or count that is not in the evidence
- add any company, client, product, tool or institution the evidence does not name
- claim to have led, owned, managed, directed, founded, created, established
  or launched anything unless the evidence uses that word about that thing
- claim expertise, mastery, seniority or depth the evidence does not state
- claim a degree, licence, certification or professional title

Write one sentence. No em dashes. American English. Return only the
sentence, with no preamble and no quotation marks.`;

/** Asks for one rewrite. Returns null rather than throwing, so one bad bullet cannot fail a resume. */
async function propose(llm: LlmProvider, source: BulletSource, roleContext: string): Promise<string | null> {
  const evidence = source.evidence.map((e, i) => `[${i + 1}] ${e.text}`).join("\n");
  try {
    const out = await llm.complete<string>({
      tier: "fast",
      system: SYSTEM,
      // The role is given as a short list of themes, never as the
      // posting's own prose. A model handed the job description reaches
      // for its vocabulary, and that vocabulary is the employer's claim
      // about the job, not evidence about the candidate.
      prompt: `EVIDENCE:\n${evidence}\n\nThe role emphasises: ${roleContext}\n\nCurrent bullet: ${source.original}\n\nRewrite the bullet.`,
      maxOutputTokens: 300,
      purpose: "tailor_resume_bullet",
    });
    const text = String(out.content).trim().replace(/^["']|["']$/g, "").split("\n")[0]!.trim();
    return text.length > 12 ? text : null;
  } catch {
    return null;
  }
}

export async function tailorBullets(
  llm: LlmProvider | null,
  sources: BulletSource[],
  roleContext: string,
  opts: {
    approvedMetrics?: string[]; knownEntities?: string[]; targetJobText?: string;
    /**
     * Every word the frozen profile uses. Lets the terminology guard
     * tell the candidate's own vocabulary from the employer's; see
     * importedPhrases. Never a licence to assert an unsupported fact.
     */
    profileVocabulary?: string;
  } = {},
): Promise<TailorResult> {
  const accepted: TailoredBullet[] = [];
  const rejected: RejectedBullet[] = [];
  let fellBack = 0;

  for (const source of sources) {
    const evidenceIds = source.evidence.map((e) => e.id);
    const sourceText = source.evidence.map((e) => e.text).join(" ");
    const common = {
      evidenceIds, sourceText,
      approvedMetrics: opts.approvedMetrics ?? [],
      knownEntities: opts.knownEntities ?? [],
      // The posting, so the guard can tell a reframing from the posting's
      // own vocabulary being attached to past work.
      targetJobText: opts.targetJobText,
      profileVocabulary: opts.profileVocabulary,
      // The wording being replaced. Three checks are meaningless without
      // it: a qualifier can only be dropped from something, a verb can
      // only be promoted relative to something, and a tense can only
      // change from something.
      original: source.original,
      implementationState: source.implementationState,
    };

    // A null provider is the dry-run path: every bullet falls back to its
    // verified master wording and no model is called.
    const proposal = llm ? await propose(llm, source, roleContext) : null;

    if (proposal) {
      const verdict = checkGrounding({ claim: proposal, ...common });
      if (verdict.ok) {
        accepted.push({ original: source.original, text: proposal, evidenceIds, sourceText, generation: "REFRAMED", verdict });
        continue;
      }
      rejected.push({
        original: source.original, proposed: proposal, evidenceIds, sourceText,
        failedCheck: verdict.failedCheck ?? "UNKNOWN",
        failureDetail: verdict.failureDetail ?? "",
      });
    }

    // The master wording is already verified, so falling back is always
    // safe. It is checked anyway: a line that cannot pass its own guards
    // must not reach an employer because it happens to be older.
    const fallback = checkGrounding({ claim: source.original, ...common });
    if (fallback.ok) {
      accepted.push({ original: source.original, text: source.original, evidenceIds, sourceText, generation: "SELECTED", verdict: fallback });
      fellBack++;
    } else {
      rejected.push({
        original: source.original, proposed: source.original, evidenceIds, sourceText,
        failedCheck: fallback.failedCheck ?? "UNKNOWN",
        failureDetail: `master wording failed its own guards: ${fallback.failureDetail}`,
      });
    }
  }

  return { accepted, rejected, fellBack };
}

export { GROUNDING_VERSION };
