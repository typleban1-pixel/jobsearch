/**
 * Turning verified project evidence into claims a resume may consider.
 *
 * A project used to get one hard-coded sentence. Employment gets a POOL:
 * several candidate claims per position, each citing its own rows, all
 * of them scored for relevance and most of them dropped. Seventeen
 * verified RentPup statements added at v10 could not be selected at all,
 * not because they were irrelevant but because nothing could reach them.
 * This is the missing half.
 *
 * Two things stay separate, and the separation is the whole design:
 *
 *   IDENTITY   what the project IS. One stable line, composed from the
 *              approved wording, always present when the project is.
 *   OPTIONAL   what it DOES. Any number of candidate claims, each one
 *              statement, each earning its place by relevance or not
 *              appearing at all.
 *
 * The optional claims are the evidence's own approved summary, VERBATIM.
 * That is not laziness, it is the truth property that makes the whole
 * thing safe: a claim identical to the statement it cites cannot
 * introduce a number, widen a scope, escalate a role, or drop a
 * qualifier, because it is the same sentence. Tailoring may still
 * reframe it afterwards, under every existing guard, and the provenance
 * gate falls back to this wording when a rewrite does not survive.
 */
import type { FrozenRow, ResumeLine } from "./resume.ts";

export const PROJECT_EVIDENCE_VERSION = 1;

/**
 * How far along a piece of project evidence actually is.
 *
 * Recorded as the first word of the evidence's detail when the v10 audit
 * established it. NONE means the statement predates the convention, not
 * that it is current.
 */
export type ImplementationState = "CURRENT" | "BUILT_BUT_PAUSED" | "PARTIAL" | "CONDITIONAL" | "NONE";

const STATE = /^(CURRENT|BUILT_BUT_PAUSED|PARTIAL|CONDITIONAL)\b/;

export function implementationState(row: Record<string, any>): ImplementationState {
  return ((String(row["detail"] ?? "").match(STATE) ?? [])[1] as ImplementationState) ?? "NONE";
}

/**
 * A statement that is not CURRENT may be shown ONLY in its own words.
 *
 * A filing workflow that is built but switched off is a real thing to
 * have built, and hiding it would be its own distortion. What must never
 * happen is the pause disappearing in a rewrite: "built an end-to-end
 * filing-assistance workflow" is a true sentence that reads as a live
 * service. The qualifier lives inside the approved statement, so the
 * rule is that the claim must BE the approved statement, exactly. No
 * judgement, nothing to get subtly wrong, and it fails closed.
 */
export function mayBeReframed(state: ImplementationState): boolean {
  return state === "CURRENT" || state === "NONE";
}

export interface ProjectClaim {
  line: ResumeLine;
  state: ImplementationState;
  /** False when the wording is fixed to the evidence's own sentence. */
  reframable: boolean;
}

/**
 * The candidate claims for one project, in a stable order.
 *
 * Ordered by row id rather than by anything meaningful: relevance
 * decides the order that reaches the page, and giving this function an
 * opinion about importance would be a second, invisible ranking.
 */
export function projectClaims(
  projectRowId: string, rows: FrozenRow[],
): ProjectClaim[] {
  const links = rows.filter((r) => r.source_table === "project_evidence"
    && r.row_data.project_id === projectRowId
    && r.row_data.employer_facing === true);
  const evidence = new Map(rows.filter((r) => r.source_table === "evidence").map((r) => [r.row_id, r]));

  const claims: ProjectClaim[] = [];
  for (const link of links) {
    const row = evidence.get(String(link.row_data.evidence_id));
    // A link whose evidence is not in this frozen version is skipped in
    // silence on purpose: it means the statement was retracted, and a
    // retracted statement must not reappear because a link outlived it.
    if (!row) continue;
    const summary = String(row.row_data.summary ?? "").trim();
    if (!summary) continue;
    const state = implementationState(row.row_data);
    claims.push({
      line: { text: summary, sources: [row.row_id] },
      state,
      reframable: mayBeReframed(state),
    });
  }
  return claims.sort((a, b) => a.line.sources[0]!.localeCompare(b.line.sources[0]!));
}
