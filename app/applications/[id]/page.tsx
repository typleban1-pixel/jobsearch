import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentSession } from "../../../lib/portal/session.ts";
import { loadApplication, loadEvents } from "../../../lib/portal/applications.ts";
import { loadFillRuns, existingScreenshots } from "../../../lib/portal/operations.ts";

export const dynamic = "force-dynamic";

const STATE_NOTE: Record<string, string> = {
  VERIFIED: "an approved profile row or an approved stored answer says so",
  DERIVED: "a deterministic transformation of verified evidence",
  HUMAN_CONFIRMED: "you supplied or approved this for this application",
  BLOCKED: "material uncertainty remains, so nothing proceeds",
};

/**
 * The review screen.
 *
 * Two independent gates are shown separately and never merged: the
 * machine's account of every field, and your approval. Neither implies
 * the other, and the approve control is deliberately unavailable while
 * anything is blocked rather than merely discouraged.
 */
/**
 * What happened after you asked the worker to run this.
 *
 * Three distinct states, because "you clicked" and "it is running" and
 * "it finished and stopped" need different things from you, and the
 * first version of this screen showed none of them: the click was
 * silently rejected and the page looked unchanged.
 */
function RunStatus({ requestedAt, startedAt, latestRun, applicationId }: {
  requestedAt: string | null; startedAt: string | null; latestRun: any; applicationId: string;
}) {
  const when = (t: string | null) => (t ? t.slice(0, 16).replace("T", " ") : "");
  const ranAfterRequest = latestRun && requestedAt
    && String(latestRun.started_at) >= requestedAt;

  if (ranAfterRequest) {
    const ok = latestRun.outcome === "HANDOFF";
    return (
      <p className={`chip ${ok ? "" : "warn"}`}>
        The worker ran this at {when(latestRun.started_at)} and stopped at{" "}
        <strong>{latestRun.outcome}</strong>: {latestRun.stop_detail}{" "}
        <Link href={`/applications/${applicationId}`}>See what the browser did</Link>, below.
        Nothing was submitted.
      </p>
    );
  }
  if (startedAt) {
    return <p className="chip">The worker picked this up at {when(startedAt)} and is running it now.</p>;
  }
  if (requestedAt) {
    return (
      <p className="chip">
        Requested {when(requestedAt)}. Queued for the local worker, which runs on the daily
        schedule or whenever it is started by hand. Nothing has happened yet.
      </p>
    );
  }
  return null;
}

export default async function ApplicationReview(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await currentSession();
  if (!session) redirect("/login");
  const detail = await loadApplication(session.client, id);
  if (!detail) notFound();
  const fillRuns = await loadFillRuns(session.client, id).catch(() => [] as any[]);
  const events = await loadEvents(session.client, id).catch(() => [] as any[]);
  const latestRun = fillRuns[0];
  // Screenshots live on the machine that ran the fill, never in Supabase.
  // The deployed portal therefore has none, and asking is cheaper than
  // rendering six broken images to find out.
  const shots = latestRun?.screenshot_dir ? await existingScreenshots(latestRun.screenshot_dir) : [];
  const confirmation = events.find((e: any) => e.event === "SUBMIT_CONFIRMED");
  const verification = events.find((e: any) => e.event === "EMAIL_VERIFICATION_COMPLETED");

  const { summary: s, answers, accepted, rejected, masterClaims, formFields } = detail;

  const blocked = answers.filter((a) => a.confidence === "BLOCKED");
  const answered = answers.filter((a) => a.confidence !== "BLOCKED");
  const reframed = accepted.filter((c) => c.generation === "REFRAMED");
  const fellBack = accepted.filter((c) => c.generation === "SELECTED");
  const masterSet = new Set(masterClaims);

  return (
    <main className="wrap">
      <p className="back"><Link href="/applications">← applications</Link></p>
      <h1>{s.company} — {s.title}</h1>
      <p className="muted">
        {s.status} · {s.submissionMode} · prepared {s.preparedAt ? s.preparedAt.slice(0, 16).replace("T", " ") : "not yet"}
        {" · "}<Link href={`/job/${s.jobId}`}>the posting</Link>
        {" · "}<Link href={`/applications/${s.id}/events`}>audit trail</Link>
      </p>

      {s.postingChanged && (
        <p className="chip warn">
          The employer has published a newer version of this posting since this application froze
          its copy. Re-prepare it rather than applying against text you did not read.
        </p>
      )}

      <h2>Can this be submitted</h2>
      <table className="apps">
        <tbody>
          <tr>
            <th>Every required field accounted for</th>
            <td>{s.allFieldsConfident ? "yes" : "no"}</td>
            <td className="muted small">
              {s.accountedFor} of {s.required} required fields, {blocked.length} blocked. Computed by
              the database from the answers below; it cannot be set by hand.
            </td>
          </tr>
          <tr>
            <th>Approved by you</th>
            <td>{s.humanApproved ? "yes" : "no"}</td>
            <td className="muted small">Both gates are required, and neither implies the other.</td>
          </tr>
        </tbody>
      </table>

      {!s.humanApproved && (
        s.allFieldsConfident ? (
          <form method="post" action="/api/applications/approve">
            <input type="hidden" name="applicationId" value={s.id} />
            <input type="hidden" name="returnTo" value={`/applications/${s.id}`} />
            <button type="submit">Approve this application package</button>
            <p className="muted small">
              Approval does not send anything. Submission is a human action taken in the employer&apos;s
              own form.
            </p>
          </form>
        ) : (
          <p className="muted">
            Approval is unavailable while {blocked.length} field{blocked.length === 1 ? " is" : "s are"} blocked.{" "}
            <Link href="/applications/queue">Answer them here.</Link>
          </p>
        )
      )}

      {s.humanApproved && !s.submittedAt && (
        <>
          <h2>Run it</h2>
          <p className="muted small">
            You approved this on {s.humanApprovedAt ? s.humanApprovedAt.slice(0, 16).replace("T", " ") : "an earlier date"}.
            Approval and execution are separate: this asks the local worker to open the
            employer&apos;s form and run the same adapter a manual run would. The portal has no
            browser of its own, so nothing happens here and now.
          </p>
          <form method="post" action="/api/applications/request-submit">
            <input type="hidden" name="applicationId" value={s.id} />
            <input type="hidden" name="returnTo" value={`/applications/${s.id}`} />
            <button type="submit">Ask the worker to submit this</button>
          </form>
          <RunStatus
            requestedAt={s.submitRequestedAt}
            startedAt={s.submitStartedAt}
            latestRun={latestRun}
            applicationId={s.id}
          />
        </>
      )}

      <h2>The document that will be uploaded</h2>
      {detail.artifact ? (
        <>
          <p className="muted small">
            {detail.artifact.bytes.toLocaleString()} bytes, renderer v{detail.artifact.rendererVersion ?? "?"},
            fingerprint <code>{detail.artifact.sha256.slice(0, 16)}</code>.
            {s.humanApproved
              ? " This is the artifact you approved, and the only one the browser will upload."
              : " Approving binds to this exact file; if it changes afterwards, filling stops rather than sending a different document."}
          </p>
          <object data={`/applications/${s.id}/resume.pdf`} type="application/pdf" className="resume-preview">
            <p className="muted small">
              Your browser will not display it inline.{" "}
              <a href={`/applications/${s.id}/resume.pdf`}>Open the PDF</a>.
            </p>
          </object>
          <p className="muted small">
            <a href={`/applications/${s.id}/resume.pdf`}>Open in a new tab</a>
          </p>
        </>
      ) : (
        <p className="muted">No rendered PDF is stored for this application, so there is nothing to approve yet.</p>
      )}

      <h2>What it claims, and where each line came from</h2>
      <p className="muted small">
        {accepted.length} line{accepted.length === 1 ? "" : "s"}: {reframed.length} rewritten for this
        role, {fellBack.length} kept from the master wording. Every line cites frozen evidence and
        passed the same grounding checks the master resume passes.
      </p>
      <ul className="claims">
        {accepted.map((c, i) => (
          <li key={i}>
            <span className={`chip ${c.generation === "REFRAMED" ? "direct" : ""}`}>
              {c.generation === "REFRAMED" ? "rewritten" : "master wording"}
            </span>{" "}
            {c.claim}
            {c.generation === "REFRAMED" && !masterSet.has(c.claim) && (
              <div className="muted small">cites {c.evidenceIds.length} frozen row{c.evidenceIds.length === 1 ? "" : "s"}</div>
            )}
          </li>
        ))}
      </ul>

      {rejected.length > 0 && (
        <details>
          <summary>
            {rejected.length} proposed line{rejected.length === 1 ? " was" : "s were"} refused by a guard
          </summary>
          <p className="muted small">
            Kept so the guards can be argued with. None of these reached the resume.
          </p>
          <ul className="claims">
            {rejected.map((c, i) => (
              <li key={i}>
                <span className="chip warn">{c.grounding?.failedCheck ?? "REJECTED"}</span> {c.claim}
                <div className="muted small">{c.grounding?.detail}</div>
              </li>
            ))}
          </ul>
        </details>
      )}

      <h2>What the browser did</h2>
      {fillRuns.length === 0 ? (
        <p className="muted">No fill has been attempted yet.</p>
      ) : (
        <>
          <table className="apps">
            <tbody>
              {fillRuns.map((r: any) => (
                <tr key={r.id}>
                  <td className="muted small">{String(r.started_at).slice(0, 16).replace("T", " ")}</td>
                  <td><span className={`chip ${r.outcome === "HANDOFF" ? "direct" : "warn"}`}>{r.outcome}</span></td>
                  <td className="num">{r.fields_filled} filled, {r.fields_left_blank} blank</td>
                  <td className="muted small">{r.stop_detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {latestRun?.form_snapshot_hash_at_fill && (
            <p className="muted small">
              Form snapshot at the most recent fill:{" "}
              <code>{String(latestRun.form_snapshot_hash_at_fill).slice(0, 16)}</code>
              {s.formSnapshotHash && String(latestRun.form_snapshot_hash_at_fill) !== s.formSnapshotHash && (
                <strong> — this differs from the approved snapshot.</strong>
              )}
            </p>
          )}
        </>
      )}

      {Array.isArray(latestRun?.parser_reconciliation) && latestRun.parser_reconciliation.length > 0 && (
        <>
          <h3>What the employer&apos;s resume parser did</h3>
          <p className="muted small">
            The board read the uploaded PDF and filled fields from it. Kept separate because
            &ldquo;their software inferred this&rdquo; and &ldquo;this system asserted this&rdquo; are different claims.
          </p>
          <ul className="small">
            {latestRun.parser_reconciliation.map((p: any, i: number) => (
              <li key={i}>{typeof p === "string" ? p : JSON.stringify(p)}</li>
            ))}
          </ul>
        </>
      )}

      {latestRun?.screenshot_dir && (
        <>
          <h3>Screenshots</h3>
          {shots.length === 0 ? (
            <p className="muted small">
              This fill produced screenshots, but they live on the machine that ran it and are
              never uploaded anywhere. They show a filled form, which means a home address and a
              phone number. Open this page on that machine to see them.
            </p>
          ) : (
            <>
              <p className="muted small">
                Served from this machine only, never uploaded.
              </p>
              <div className="shots">
                {shots.map((name) => (
                  <figure key={name}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/applications/${s.id}/screenshot/${name}`} alt={name} loading="lazy" />
                    <figcaption>{name.replace(/^\d+-/, "").replace(/\.png$/, "")}</figcaption>
                  </figure>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <h2>Submission</h2>
      {confirmation ? (
        <>
          <p className="chip direct">Confirmed by the employer</p>
          <p className="muted small">{confirmation.detail}</p>
          <p className="muted small">
            Recorded {String(confirmation.occurredAt).slice(0, 19).replace("T", " ")}. Written only
            after the live page said it had received the application; a click, a network request or
            the form disappearing are none of them sufficient on their own.
          </p>
        </>
      ) : (
        <p className="muted">
          Not submitted. Nothing is recorded as submitted without the employer&apos;s own
          confirmation on the page.
        </p>
      )}
      {verification && (
        <p className="muted small">
          An ordinary email verification step was completed. {verification.detail}
        </p>
      )}

      <h2>Application fields</h2>
      <p className="muted small">
        {formFields.length} field{formFields.length === 1 ? "" : "s"} in the employer&apos;s form
        {detail.snapshotProvider ? `, snapshotted from ${detail.snapshotProvider}` : ""}. No fit score,
        coverage ratio or model confidence appears anywhere below: job ranking is comparative and
        allowed to be wrong, an application answer is not.
      </p>

      <table className="apps">
        <tbody>
          {answered.map((a) => (
            <tr key={a.id}>
              <td>{a.fieldLabel}{a.isRequired && <span className="muted"> *</span>}</td>
              <td><span className={`chip ${a.confidence === "BLOCKED" ? "warn" : "direct"}`}>{a.confidence}</span></td>
              <td>{a.answer ?? <em className="muted">left blank</em>}</td>
              <td className="muted small">{STATE_NOTE[a.confidence]}</td>
            </tr>
          ))}
          {blocked.map((a) => (
            <tr key={a.id}>
              <td>{a.fieldLabel}{a.isRequired && <span className="muted"> *</span>}</td>
              <td><span className="chip warn">BLOCKED · {a.blockKind}</span></td>
              <td><Link href="/applications/queue">answer this</Link></td>
              <td className="muted small">{a.blockedReason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
