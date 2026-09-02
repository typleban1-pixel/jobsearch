import Link from "next/link";
import { notFound } from "next/navigation";
import { redirect } from "next/navigation";
import { loadJobCards } from "../../../lib/portal/db.ts";
import { currentSession } from "../../../lib/portal/session.ts";
import {
  describeArrangement, describeFreshness, describeLocations, describeSalary, uncertaintyBand,
} from "../../../lib/portal/present.ts";

export const dynamic = "force-dynamic";

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export default async function JobDetail(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await currentSession();
  if (!session) redirect("/login");
  const db = session.client;
  const cards = await loadJobCards(db);
  const card = cards.find((c) => c.id === id);
  if (!card) notFound();

  // Sibling variants of the same opening. Applying through one of these
  // blocks the others, so they belong on screen together.
  const siblings = cards.filter((c) => c.openingId === card.openingId && c.id !== card.id);
  const { data: opening } = await db.from("openings")
    .select("identity_method,provider_opening_key").eq("id", card.openingId).maybeSingle();
  const { data: desc } = await db.from("job_descriptions")
    .select("description_text").eq("job_id", card.id).maybeSingle();

  const returnTo = `/job/${card.id}`;

  // One live application per requisition, so the control disappears once
  // any variant of this opening has one.
  const { data: live } = await db.from("applications")
    .select("id,status").eq("canonical_opening_id", card.openingId)
    .not("status", "in", "(REJECTED,WITHDRAWN,ABANDONED)").limit(1);
  const liveApplication = live?.[0] ?? null;

  const rank = [...cards].sort((a, b) => b.fit - a.fit).findIndex((c) => c.id === card.id) + 1;
  const evidenceRank = [...cards]
    .sort((a, b) => b.creditedCount - a.creditedCount || b.fit - a.fit)
    .findIndex((c) => c.id === card.id) + 1;

  return (
    <main className="wrap">
      <p className="back">
        <Link href="/jobs">← all jobs</Link>
        {" · "}<Link href="/applications">applications</Link>
      </p>

      {liveApplication ? (
        <p className="muted small">
          <Link href={`/applications/${liveApplication.id}`}>
            An application for this opening already exists ({liveApplication.status}).
          </Link>
        </p>
      ) : (
        <form method="post" action="/api/applications/prepare">
          <input type="hidden" name="jobId" value={card.id} />
          <input type="hidden" name="returnTo" value="/applications" />
          <button type="submit">Apply to this</button>
          <span className="muted small">
            {" "}Freezes this exact posting version and queues it for preparation on the local worker.
          </span>
        </form>
      )}
      <header className="top">
        <h1>{card.title}</h1>
        <div className="provenance">
          profile v{card.profileVersion} · weights v{card.weightsVersion} · fit formula {card.fitFormulaVersion}
        </div>
      </header>
      <div className="company">{card.company}{card.url && <> · <a href={card.url} target="_blank" rel="noreferrer">original posting</a></>}</div>

      <div className="actions" style={{ justifyContent: "flex-start", marginTop: 14 }}>
        <form method="post" action="/api/interest">
          <input type="hidden" name="openingId" value={card.openingId} />
          <input type="hidden" name="jobId" value={card.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="state" value={card.activeInterest === "SAVED" ? "CLEAR" : "SAVED"} />
          <button type="submit" className={card.activeInterest === "SAVED" ? "" : "primary"}>
            {card.activeInterest === "SAVED" ? "Unsave" : "Save"}
          </button>
        </form>
        <form method="post" action="/api/interest">
          <input type="hidden" name="openingId" value={card.openingId} />
          <input type="hidden" name="jobId" value={card.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="state" value={card.activeInterest === "NOT_INTERESTED" ? "CLEAR" : "NOT_INTERESTED"} />
          <button type="submit">{card.activeInterest === "NOT_INTERESTED" ? "Undo not interested" : "Not interested"}</button>
        </form>
      </div>

      <section className="section">
        <h3>Why it ranked here</h3>
        <table className="detail">
          <tbody>
            <tr><th>Fit</th><td className="num"><b>{card.fit}</b> · rank {rank} of {cards.length} by Fit, {evidenceRank} by evidence</td></tr>
            <tr><th>from evidence (coverage)</th><td className="num">{signed(card.coveragePoints)}{card.coverage !== null && ` · coverage ${(card.coverage * 100).toFixed(1)}%`}</td></tr>
            <tr><th>title family</th><td className="num">{signed(card.titleMatchPoints)}</td></tr>
            <tr><th>seniority</th><td className="num">{signed(card.seniorityPoints)}</td></tr>
            <tr><th>gate penalties</th><td className="num">{signed(card.gatePenaltyPoints)}</td></tr>
            {card.otherPoints !== 0 && <tr><th>other terms</th><td className="num">{signed(card.otherPoints)}</td></tr>}
            <tr><th>Opportunity / Generalist / Specialist</th><td className="num">{card.opportunity ?? "—"} / {card.generalist ?? "—"} / {card.specialist ?? "—"}</td></tr>
            <tr><th>Uncertainty</th><td className="num">{card.uncertainty ?? "—"} ({uncertaintyBand(card.uncertainty).toLowerCase()})</td></tr>
            <tr><th>Recommendation state</th><td>{card.recommendation ?? "not set"}{card.recommendation === "STRETCH" && " · surfaced, never auto-submitted"}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="section">
        <h3>Evidence</h3>
        <table className="detail">
          <tbody>
            <tr><th>Credited concepts</th><td className="num">{card.creditedCount} of {card.evaluableCount} judgeable{card.excludedUnknown > 0 && `, ${card.excludedUnknown} undecidable`}</td></tr>
            <tr><th>DIRECT</th><td>{card.directConcepts.length ? card.directConcepts.join(", ") : "none"}</td></tr>
            <tr><th>TRANSFERABLE</th><td>{card.transferableConcepts.length ? card.transferableConcepts.join(", ") : "none"}</td></tr>
            <tr><th>Not evidenced</th><td>{card.absentConcepts.length ? card.absentConcepts.join(", ") : "none"}</td></tr>
            <tr><th>Credential families unmet</th><td>{card.credentialFamiliesUnmet.length ? card.credentialFamiliesUnmet.join(", ") : "none"}</td></tr>
            <tr><th>Education gates unmet</th><td className="num">{card.educationGatesUnmet}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="section">
        <h3>The posting</h3>
        <table className="detail">
          <tbody>
            <tr><th>Locations</th><td>{describeLocations(card.locations, card.locationRaw)}</td></tr>
            <tr><th>Raw location field</th><td>{card.locationRaw ?? "none"}</td></tr>
            <tr><th>Work arrangement</th><td>{describeArrangement(card.remotePolicy)}</td></tr>
            <tr><th>Salary</th><td className="num">{describeSalary(card) ?? "not stated"}</td></tr>
            <tr><th>Freshness</th><td>{describeFreshness(card)}</td></tr>
            <tr><th>Eligibility</th><td>{card.eligibility}{card.eligibilityReason && ` · ${card.eligibilityReason}`}</td></tr>
            <tr>
              <th>Canonical opening</th>
              <td>
                {opening?.identity_method === "PROVIDER_OPENING_ID"
                  ? `shared requisition ${opening.provider_opening_key}`
                  : "its own opening"}
                {siblings.length > 0 && (
                  <> · {siblings.length} other published variant{siblings.length > 1 ? "s" : ""}:{" "}
                    {siblings.map((s, i) => (
                      <span key={s.id}>{i > 0 && ", "}<Link href={`/job/${s.id}`}>{describeLocations(s.locations, s.locationRaw)}</Link></span>
                    ))}
                    . Applying through any one blocks the rest.
                  </>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {desc?.description_text && (
        <section className="section">
          <h3>Description</h3>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13.5, color: "var(--ink-soft)", maxHeight: 420, overflow: "auto", border: "1px solid var(--line)", borderRadius: 6, padding: 12, background: "var(--surface)" }}>
            {desc.description_text.slice(0, 12000)}
          </div>
        </section>
      )}
    </main>
  );
}
