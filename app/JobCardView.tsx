import Link from "next/link";
import type { JobCard } from "../lib/portal/db.ts";
import { JobPipelineControl } from "./JobSelect.tsx";
import { BAND_LABEL, BAND_EXPLANATION } from "../lib/portal/attentionRank.ts";
import { describeArrangement, describeLocations, describeSalary, uncertaintyBand } from "../lib/portal/present.ts";
import { matchLabel } from "../lib/portal/matchScore.ts";
import { postingLink } from "../lib/portal/source.ts";

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** What the verdict means, said the way a person would say it. */
const VERDICT_TEXT: Record<string, string> = {
  CANDIDATE: "Strong match",
  STRETCH: "Worth considering",
  REVIEW: "Needs review",
  "NOT A CANDIDATE": "Skip",
};

/**
 * One job, as a person decides on it.
 *
 * The card answers "should I apply?" and nothing else: what the job is,
 * where and for how much, how well it matches and the two or three facts
 * that decide that, where it was found with a link to the real posting,
 * and one control -- prepare an application, or the state of the one that
 * exists. Everything the ranking knows is still here, under "Why N?".
 */
export function JobCardView({ card, returnTo, rank = null }: { card: JobCard; returnTo: string; rank?: number | null }) {
  const salary = describeSalary(card);
  const band = uncertaintyBand(card.uncertainty);
  // The number and the words come from the Match Score alone, so they can
  // never contradict. It is a calibrated 0-100 read, not a percentage.
  const fit = matchLabel(card.match.score, card.match.provisional);
  const posting = postingLink({ source: card.source, url: card.url, applyUrl: card.applyUrl, status: card.status, statusChangedAt: card.statusChangedAt });

  // Two reasons for, one against: the strongest direct evidence and the
  // most important gap, both already computed by the ranking.
  const reasonsFor = card.directConcepts.slice(0, 2);
  const gaps = [
    ...card.credentialFamiliesUnmet.map((f) => `No ${f.toLowerCase()} credential`),
    ...card.attention.genuineGaps,
  ];
  const reasonAgainst = gaps[0] ?? null;
  const dimmed = card.activeInterest === "NOT_INTERESTED";

  return (
    <article className={`jobcard${dimmed ? " dimmed" : ""}`} aria-labelledby={`job-${card.id}-title`}>
      <div className="jobcard-head">
        <div className="jobcard-title">
          {rank !== null && <span className="jobcard-rank" title="position in your ranked list">#{rank}</span>}
          <div>
            <h2 id={`job-${card.id}-title`}><Link href={`/job/${card.id}`}>{card.title}</Link></h2>
            <p className="jobcard-company">{card.company}</p>
            <p className="jobcard-facts">
              <span>{describeLocations(card.locations, card.locationRaw)}</span>
              <span>{describeArrangement(card.remotePolicy)}</span>
              {salary && <span>{salary}</span>}
            </p>
          </div>
        </div>
        <div className={`jobcard-match${card.match.provisional ? " provisional" : ""}`}
          title={card.match.note ? `Match estimate — ${card.match.note}` : "How well this role matches your verified background, 0 to 100"}>
          <b>{card.match.provisional ? "~" : ""}{card.match.score}</b>
          <span className="matchword">match</span>
          <span className="matchfitword">{fit}</span>
        </div>
      </div>

      {(reasonsFor.length > 0 || reasonAgainst || card.attention.band === "GENERIC_REQUIREMENTS") && (
        <ul className="jobcard-reasons">
          {reasonsFor.map((r) => (
            <li key={r} className="for"><span className="mark" aria-hidden="true">&#10003;</span><span className="sr">Evidence for: </span>{r}</li>
          ))}
          {reasonAgainst && (
            <li className="against"><span className="mark" aria-hidden="true">&#9651;</span><span className="sr">Gap: </span>{reasonAgainst}</li>
          )}
          {card.attention.band === "GENERIC_REQUIREMENTS" && (
            <li className="note" title={BAND_EXPLANATION.GENERIC_REQUIREMENTS}>{BAND_LABEL.GENERIC_REQUIREMENTS}</li>
          )}
        </ul>
      )}

      <p className="jobcard-source">
        <span>{posting.foundVia}</span>
        {posting.removed
          ? <span className="removed">{posting.removed}</span>
          : posting.href && (
            <a href={posting.href} target="_blank" rel="noopener noreferrer"
              aria-label={`${posting.linkLabel} posting for ${card.title} at ${card.company} (opens in a new tab)`}>
              {posting.linkLabel} <span aria-hidden="true">&#8599;</span>
            </a>
          )}
        {card.variantCount > 1 && <span className="muted">{card.variantCount} versions of this opening</span>}
      </p>

      <div className="jobcard-actions">
        <JobPipelineControl jobId={card.id} openingId={card.openingId} appState={card.applicationState} />
        <form method="post" action="/api/interest">
          <input type="hidden" name="openingId" value={card.openingId} />
          <input type="hidden" name="jobId" value={card.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="state" value={card.activeInterest === "SAVED" ? "CLEAR" : "SAVED"} />
          <button type="submit" className={`btn-quiet${card.activeInterest === "SAVED" ? " on" : ""}`}>
            {card.activeInterest === "SAVED" ? "Saved" : "Save"}
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
        <details className="tech why">
          <summary>Why {card.match.provisional ? "~" : ""}{card.match.score}?</summary>
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
            {card.directConcepts.length > 0 && <p className="muted"><b>Direct evidence:</b> {card.directConcepts.join(" · ")}</p>}
            {card.transferableConcepts.length > 0 && <p className="muted"><b>Transferable:</b> {card.transferableConcepts.join(" · ")}</p>}
            {gaps.length > 0 && <p className="muted"><b>Gaps:</b> {gaps.join(" · ")}</p>}
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
      </div>
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
