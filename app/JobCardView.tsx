import Link from "next/link";
import type { JobCard } from "../lib/portal/db.ts";
import { BAND_LABEL, BAND_EXPLANATION } from "../lib/portal/attentionRank.ts";
import {
  describeArrangement, describeFreshness, describeLocations, describeSalary,
  evidenceLabel, uncertaintyBand,
} from "../lib/portal/present.ts";

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
export function JobCardView({ card, returnTo }: { card: JobCard; returnTo: string }) {
  const salary = describeSalary(card);
  const band = uncertaintyBand(card.uncertainty);
  const verdict = card.candidacy ? VERDICT_TEXT[card.candidacy.label] ?? card.candidacy.label : null;

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
        <div>
          <h2><Link href={`/job/${card.id}`}>{card.title}</Link></h2>
          <p className="jobcard-company">{card.company}</p>
        </div>
        {verdict && (
          <span className={`verdict ${card.candidacy!.label.toLowerCase().replace(/\s+/g, "-")}`}>
            {verdict}
          </span>
        )}
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
        <Link className="btn-primary" href={`/job/${card.id}`}>Review job</Link>
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

      {/* Nothing is deleted, only folded. */}
      <details className="tech">
        <summary>Matching details</summary>
        <div className="matchdetail">
          <p>
            Evidence <b>{evidenceLabel(card)}</b>
            {card.excludedUnknown > 0 && ` · ${card.excludedUnknown} undecidable`}
            {" · uncertainty "}<b>{band.toLowerCase()}</b>
            {card.uncertainty !== null && ` (${card.uncertainty})`}
            {" · "}{describeFreshness(card)}
            {card.seniority && ` · ${card.seniority.toLowerCase()}`}
          </p>
          {card.candidacy && (
            <p>
              Candidacy <b>{card.candidacy.label}{card.candidacy.stale ? " (stale)" : ""}</b>
              {card.candidacy.reason ? ` — ${card.candidacy.reason}` : ""}
            </p>
          )}
          {!card.scorable && <p>Too few requirements were extracted to judge this posting.</p>}
          <dl className="scoregrid">
            <div><dt>requirements met</dt><dd>{card.candidacy ? `${card.candidacy.hardMet}/${card.candidacy.hardTotal}` : "—"}</dd></div>
            <div><dt>met by direct evidence</dt><dd>{card.hardDirect}</dd></div>
            <div><dt>attention score</dt><dd>{card.attention.score.toFixed(1)}</dd></div>
            <div><dt>Fit</dt><dd>{card.fit}</dd></div>
            <div><dt>Opportunity</dt><dd>{card.opportunity ?? "—"}</dd></div>
            <div><dt>Generalist</dt><dd>{card.generalist ?? "—"}</dd></div>
            <div><dt>Specialist</dt><dd>{card.specialist ?? "—"}</dd></div>
            <div><dt>from evidence</dt><dd>{signed(card.coveragePoints)}</dd></div>
            <div><dt>title family</dt><dd>{signed(card.titleMatchPoints)}</dd></div>
            <div><dt>seniority</dt><dd>{signed(card.seniorityPoints)}</dd></div>
            <div><dt>gates</dt><dd>{signed(card.gatePenaltyPoints)}</dd></div>
            {card.otherPoints !== 0 && <div><dt>other</dt><dd>{signed(card.otherPoints)}</dd></div>}
          </dl>
          {card.transferableConcepts.length > 0 && (
            <p>Transferable: {card.transferableConcepts.slice(0, 6).join(" · ")}</p>
          )}
          {card.educationGatesUnmet > 0 && (
            <p>{card.educationGatesUnmet} education gate{card.educationGatesUnmet > 1 ? "s" : ""} unmet</p>
          )}
        </div>
      </details>
    </article>
  );
}
