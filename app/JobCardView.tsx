import Link from "next/link";
import type { JobCard } from "../lib/portal/db.ts";
import { JobSelect } from "./JobSelect.tsx";
import { BAND_LABEL, BAND_EXPLANATION } from "../lib/portal/attentionRank.ts";
import {
  describeArrangement, describeFreshness, describeLocations, describeSalary,
  evidenceLabel, uncertaintyBand,
} from "../lib/portal/present.ts";
import { matchLabel } from "../lib/portal/matchScore.ts";

/** An application a person can act on from its review page. */
const REVIEWABLE = new Set(["AWAITING_REVIEW", "READY_TO_SUBMIT", "BLOCKED_NEEDS_INPUT"]);

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** What the verdict means, said the way a person would say it. */
const VERDICT_TEXT: Record<string, string> = {
  CANDIDATE: "Strong match",
  STRETCH: "Worth considering",
  REVIEW: "Needs review",
  "NOT A CANDIDATE": "Skip",
};

/**
 * One job, as a person reads it.
 *
 * The scoring numbers this card used to lead with (Opportunity,
 * Generalist, Specialist, Fit, and the four-part decomposition) are all
 * still computed and still shown, under "Matching details". They answer
 * how the ranking was produced, which is a question for the days when
 * the ranking looks wrong. The question every other day is whether this
 * job is worth reading, and that is what the card now leads with.
 */
export function JobCardView({ card, returnTo, rank = null }: { card: JobCard; returnTo: string; rank?: number | null }) {
  const salary = describeSalary(card);
  const band = uncertaintyBand(card.uncertainty);
  // The user-facing fit label comes from the Match Score alone, so the
  // number and the words never contradict. The candidacy verdict is kept
  // for automation/submission safety and still shown under "Matching
  // details" -- it no longer sets the headline fit claim.
  const fit = matchLabel(card.match.score, card.match.provisional);

  // The strongest thing we can say for the job, and the most important
  // thing against it. Both come from evidence already computed.
  const strong = card.directConcepts.slice(0, 3);
  // Boilerplate the ranking set aside is not shown as a gap either: a
  // requirement naming no field is not something to be missing.
  const gaps = [
    ...card.credentialFamiliesUnmet.map((f) => `no ${f.toLowerCase()} credential`),
    ...card.attention.genuineGaps.slice(0, 2),
  ];

  return (
    <article className={`jobcard${card.activeInterest ? " dimmed" : ""}`}>
      <div className="jobcard-head">
        <div className="jobcard-title">
          <JobSelect jobId={card.id} openingId={card.openingId} appStatus={card.applicationStatus} />
          {rank !== null && <span className="jobcard-rank" title="position in your ranked queue">#{rank}</span>}
          <div>
            <h2><Link href={`/job/${card.id}`}>{card.title}</Link></h2>
            <p className="jobcard-company">{card.company}</p>
          </div>
        </div>
        <div className="jobcard-badges">
          <span className={`matchbadge${card.match.provisional ? " provisional" : ""}`}
            title={card.match.note ? `Match estimate — ${card.match.note}` : "How good this opportunity is for your verified background"}>
            <b>{card.match.provisional ? "~" : ""}{card.match.score}</b> Match
          </span>
          <span className={`matchfit${card.match.provisional ? " provisional" : ""}`}
            title="Your fit for this role, derived from the Match Score">
            {fit}
          </span>
        </div>
      </div>

      {card.attention.band === "GENERIC_REQUIREMENTS" && (
        <p className="jobcard-band" title={BAND_EXPLANATION.GENERIC_REQUIREMENTS}>
          <span>{BAND_LABEL.GENERIC_REQUIREMENTS}</span>
        </p>
      )}

      <p className="jobcard-facts">
        <span>{describeLocations(card.locations, card.locationRaw)}</span>
        <span>{describeArrangement(card.remotePolicy)}</span>
        <span>{salary ?? "salary not stated"}</span>
      </p>

      {strong.length > 0 && (
        <p className="jobcard-why">
          <span className="lead">Strong evidence</span>
          {strong.join(" · ")}
        </p>
      )}
      {gaps.length > 0 && (
        <p className="jobcard-gap">
          <span className="lead">Main gap</span>
          {gaps.join(" · ")}
        </p>
      )}

      {(card.activeInterest || card.variantCount > 1 || card.applicationStatus) && (
        <p className="jobcard-flags">
          {card.applicationStatus && (
            <span className="flag applied">
              {card.applicationStatus === "SUBMITTED" ? "Already applied" : "Application in progress"}
            </span>
          )}
          {card.activeInterest === "SAVED" && <span className="flag">Saved</span>}
          {card.activeInterest === "NOT_INTERESTED" && <span className="flag">Not interested</span>}
          {card.variantCount > 1 && (
            <span className="flag">{card.variantCount} versions of this opening</span>
          )}
        </p>
      )}

      <div className="jobcard-actions">
        {card.applicationId && REVIEWABLE.has(card.applicationStatus ?? "")
          ? <Link className="btn-primary" href={`/applications/${card.applicationId}/review`}>Review application</Link>
          : <Link className="btn-primary" href={`/job/${card.id}`}>Review job</Link>}
        <form method="post" action="/api/interest">
          <input type="hidden" name="openingId" value={card.openingId} />
          <input type="hidden" name="jobId" value={card.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="state" value={card.activeInterest === "SAVED" ? "CLEAR" : "SAVED"} />
          <button type="submit" className="btn-quiet">
            {card.activeInterest === "SAVED" ? "Unsave" : "Save"}
          </button>
        </form>
        <form method="post" action="/api/interest">
          <input type="hidden" name="openingId" value={card.openingId} />
          <input type="hidden" name="jobId" value={card.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="state" value={card.activeInterest === "NOT_INTERESTED" ? "CLEAR" : "NOT_INTERESTED"} />
          <button type="submit" className="btn-quiet">
            {card.activeInterest === "NOT_INTERESTED" ? "Undo" : "Not interested"}
          </button>
        </form>
      </div>

      {/* Human-readable match breakdown; the raw formula sits inside it. */}
      <details className="tech">
        <summary>Match details</summary>
        <div className="matchdetail">
          <dl className="matchgrid">
            <div><dt>Match score</dt><dd>{card.match.provisional ? "~" : ""}{card.match.score}/100{card.match.note ? ` · ${card.match.note}` : ""}</dd></div>
            {card.candidacy && <div><dt>Candidacy</dt><dd>{VERDICT_TEXT[card.candidacy.label] ?? card.candidacy.label}{card.candidacy.stale ? " (stale)" : ""}</dd></div>}
            <div><dt>Hard requirements supported</dt><dd>{card.candidacy ? `${card.candidacy.hardMet}/${card.candidacy.hardTotal}` : "—"}</dd></div>
            <div><dt>By direct vs transferable</dt><dd>{card.hardDirect} direct · {card.candidacy?.transferableMatches ?? card.transferableConcepts.length} transferable</dd></div>
            <div><dt>Genuine gaps</dt><dd>{describeGaps(card)}</dd></div>
            <div><dt>Seniority</dt><dd>{card.seniorityPoints > 0 ? "aligned" : card.seniorityPoints < 0 ? "mismatch" : "not stated"}</dd></div>
            <div><dt>Compensation</dt><dd>{salary ?? "not stated"}</dd></div>
            <div><dt>Uncertainty</dt><dd>{band.toLowerCase()}{card.uncertainty !== null ? ` (${card.uncertainty})` : ""}{card.excludedUnknown > 0 ? ` · ${card.excludedUnknown} unevaluable` : ""}</dd></div>
          </dl>
          {card.candidacy?.reason && <p className="muted">{card.candidacy.reason}</p>}
          {!card.scorable && <p className="muted">Too few requirements were extracted to judge this posting.</p>}

          <details className="tech-raw">
            <summary>Raw scoring details</summary>
            <dl className="scoregrid">
              <div><dt>attention score</dt><dd>{card.attention.score.toFixed(1)}</dd></div>
              <div><dt>Fit (Formula3, raw)</dt><dd>{card.fit}</dd></div>
              <div><dt>Opportunity</dt><dd>{card.opportunity ?? "—"}</dd></div>
              <div><dt>Generalist</dt><dd>{card.generalist ?? "—"}</dd></div>
              <div><dt>Specialist</dt><dd>{card.specialist ?? "—"}</dd></div>
              <div><dt>from evidence</dt><dd>{signed(card.coveragePoints)}</dd></div>
              <div><dt>title family</dt><dd>{signed(card.titleMatchPoints)}</dd></div>
              <div><dt>seniority</dt><dd>{signed(card.seniorityPoints)}</dd></div>
              <div><dt>gates</dt><dd>{signed(card.gatePenaltyPoints)}</dd></div>
              {card.otherPoints !== 0 && <div><dt>other</dt><dd>{signed(card.otherPoints)}</dd></div>}
            </dl>
            <p className="muted">Fit is a raw, signed ranking quantity, not a percentage. The Match score above is the calibrated 0–100 read.</p>
          </details>
        </div>
      </details>
    </article>
  );
}

/** Genuine gaps, in one line, or "none". */
function describeGaps(card: JobCard): string {
  const parts: string[] = [];
  const core = card.candidacy?.coreGaps ?? 0;
  const gating = card.candidacy?.gatingGaps ?? card.credentialFamiliesUnmet.length;
  if (core) parts.push(`${core} role-defining`);
  if (gating) parts.push(`${gating} credential`);
  if (card.educationGatesUnmet) parts.push(`${card.educationGatesUnmet} education`);
  return parts.length ? parts.join(", ") : "none";
}
