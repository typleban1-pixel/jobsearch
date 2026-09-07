import { redirect } from "next/navigation";
import { currentSession } from "../../../../lib/portal/session.ts";
import { loadReview, type ReviewCheck } from "../../../../lib/portal/reviewData.ts";
import { PrimaryNav } from "../../../PrimaryNav.tsx";

export const dynamic = "force-dynamic";

function Check({ c }: { c: ReviewCheck }) {
  const mark = c.state === "PASS" ? "\u2713" : c.state === "PENDING" ? "\u25cb" : "\u2715";
  return (
    <li className={`check ${c.state.toLowerCase()}`}>
      <span className="mark" aria-hidden="true">{mark}</span>
      <span>{c.label}</span>
    </li>
  );
}

export default async function ReviewPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { id } = await props.params;
  const sp = await props.searchParams;
  const r = await loadReview(session.client, id);
  if (!r) redirect("/apply");

  const justApproved = (Array.isArray(sp.approved) ? sp.approved[0] : sp.approved) === "1";

  return (
    <main className="review">
      <header className="applyhead">
        <h1>Review</h1>
        <PrimaryNav current="apply" />
      </header>

      {justApproved && (
        <div className="banner good">
          <strong>Application approved \u2713</strong>
          <span>Nothing has been submitted yet.</span>
        </div>
      )}

      <section className="jobhead">
        <p className="company">{r.company}</p>
        <h2>{r.title}</h2>
        <p className="meta">
          <span className="verdict">{r.candidacyLabel}</span>
          {r.location && <span>{r.location}</span>}
          {r.workArrangement && <span>{r.workArrangement}</span>}
          {r.salary && <span>{r.salary}</span>}
        </p>
      </section>

      {/* A submission that has happened is terminal: its outcome takes
          precedence over any pre-submit readiness. Only when nothing has been
          submitted (terminalState NONE) do the readiness warnings show. */}
      {r.terminalState === "CONFIRMED" ? (
        <div className="banner good">
          <strong>Submitted successfully \u2713</strong>
          <span>Employer confirmed receipt of this application.</span>
        </div>
      ) : r.terminalState === "UNCERTAIN" ? (
        <div className="banner warn">
          <strong>Submission uncertain</strong>
          <span>A submission may have reached the employer but was never confirmed. It was not re-sent; this needs manual verification.</span>
        </div>
      ) : r.terminalState === "SENT_UNCONFIRMED" ? (
        <div className="banner plain">
          <strong>Submitted</strong>
          <span>This was sent; the employer has not yet confirmed receipt.</span>
        </div>
      ) : r.warnings.length > 0 ? (
        <div className="banner warn">
          <strong>Needs another look</strong>
          <ul>{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      ) : r.phase === "APPROVED" ? (
        <div className="banner good">
          <strong>Approved</strong>
          <span>Waiting for the final submission step. Nothing has been submitted.</span>
        </div>
      ) : r.noActionReason ? (
        <div className="banner plain">
          <strong>Apply on the employer&rsquo;s site</strong>
          <span>{r.noActionReason}</span>
        </div>
      ) : (
        <div className="banner plain">
          <strong>Application prepared</strong>
          <span>We have everything needed for you to review this application. Nothing has been submitted.</span>
        </div>
      )}

      {r.terminalState !== "NONE" ? (
        <section className="pane">
          <h3>Submission record</h3>
          <dl className="submission-record">
            <dt>Status</dt><dd>{r.terminalState === "CONFIRMED" ? "Employer confirmed"
              : r.terminalState === "UNCERTAIN" ? "Uncertain \u2014 not confirmed"
              : "Sent \u2014 awaiting confirmation"}</dd>
            {r.submittedAt && (<><dt>Submitted</dt><dd>{new Date(r.submittedAt).toLocaleString()}</dd></>)}
            <dt>Employer &amp; role</dt><dd>{r.company} \u2014 {r.title}</dd>
            {r.submissionMode && (<><dt>Submission mode</dt><dd>{r.submissionMode}</dd></>)}
            <dt>Resume used</dt><dd>{r.resume.hasArtifact ? "Exact tailored PDF (saved below)" : "no saved PDF bound"}</dd>
            <dt>Confirmation</dt><dd>{r.confirmed ? "Received" : r.terminalState === "CONFIRMED" ? "Received" : "Not received"}</dd>
          </dl>
        </section>
      ) : r.noActionReason ? (
        // The in-portal preparation checklist does not apply when the
        // application is completed on the employer's site: showing ✗ marks
        // for a resume that was never meant to be prepared here reads as work
        // the person must do, with no control to do it. The external action
        // below is the whole next step.
        <section className="pane">
          <h3>How this application works</h3>
          <p className="muted">{r.noActionReason}</p>
        </section>
      ) : (
        <section className="checklists">
          <div>
            <h3>Resume</h3>
            <ul className="checks">{r.resumeChecks.map((c) => <Check key={c.label} c={c} />)}</ul>
          </div>
          <div>
            <h3>Application</h3>
            <ul className="checks">{r.applicationChecks.map((c) => <Check key={c.label} c={c} />)}</ul>
          </div>
          <div>
            <h3>Final submission</h3>
            <ul className="checks">{r.finalChecks.map((c) => <Check key={c.label} c={c} />)}</ul>
          </div>
        </section>
      )}

      <section className="pane">
        <h3>Tailored resume</h3>
        <p className="muted">This is the exact resume currently prepared for this application.</p>
        {r.resume.hasArtifact ? (
          <>
            <object className="pdf" data={`/applications/${r.applicationId}/resume.pdf`} type="application/pdf">
              <p>Your browser cannot display the PDF here.</p>
            </object>
            <a className="btn-quiet" href={`/applications/${r.applicationId}/resume.pdf`} target="_blank" rel="noreferrer">Open PDF</a>
          </>
        ) : (
          <p className="bad">No saved PDF is bound to this application.</p>
        )}
        <details className="tech">
          <summary>Resume verification</summary>
          <dl>
            <dt>Artifact hash</dt><dd>{r.resume.artifactSha256 ?? "none"}</dd>
            <dt>Content hash</dt><dd>{r.resume.contentSha256 ?? "none"}</dd>
            <dt>Renderer version</dt><dd>{r.resume.rendererVersion ?? "unknown"}</dd>
            <dt>Grounding version</dt><dd>{r.resume.groundingVersion ?? "not recorded"}</dd>
            <dt>Claim lines</dt><dd>{r.resume.linesAccepted}</dd>
          </dl>
        </details>
      </section>

      <section className="pane">
        <h3>Application answers</h3>
        <p className="muted">These are the answers the employer will receive.</p>
        <ul className="answers">
          {r.answers.map((a) => (
            <li key={a.fieldKey}>
              <p className="q">{a.question}</p>
              <p className="a">{a.answer ?? <em>left blank</em>}</p>
              {a.source && <p className="src">{a.source}</p>}
            </li>
          ))}
        </ul>
      </section>

      <section className="pane">
        <h3>Why this may be worth applying to</h3>
        {r.mainGap ? (
          <>
            <p className="muted">Main gap</p>
            <p>{r.mainGap} is not established.</p>
          </>
        ) : (
          <p>No role-defining gap was found against the requirements this posting states.</p>
        )}
        <details className="tech">
          <summary>See matching details</summary>
          <p className="muted">Requirements this posting states:</p>
          <ul>{r.keyRequirements.map((q) => <li key={q}>{q}</li>)}</ul>
        </details>
      </section>

      <section className="pane">
        <h3>The job</h3>
        <p className="desc">{r.descriptionExcerpt}{r.descriptionExcerpt.length >= 700 ? "\u2026" : ""}</p>
        {r.jobUrl && <a className="btn-quiet" href={r.jobUrl} target="_blank" rel="noreferrer">View full job listing</a>}
      </section>

      {r.submitOutcome === "AMBIGUOUS" && (
        <section className="pane ambiguous">
          <h3>We could not confirm this submission</h3>
          <p>
            The submit button was clicked{r.clickAttemptedAt
              ? ` at ${new Date(r.clickAttemptedAt).toLocaleString("en-US", {
                  month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`
              : ""}, but the employer&rsquo;s page never confirmed receipt. The application may
            or may not have reached them, and the system cannot tell which.
          </p>
          <p className="muted">
            Nothing has been marked submitted, and no retry is offered, because applying again
            could send this employer a second copy. Check the employer&rsquo;s confirmation page,
            your email, or their application portal, then tell us what you found.
          </p>

          <form method="post" action="/api/applications/resolve-ambiguous" className="resolveform">
            <input type="hidden" name="applicationId" value={r.applicationId} />
            <fieldset>
              <legend>What did you check?</legend>
              <label><input type="radio" name="evidence" value="CONFIRMATION_PAGE" required /> The employer&rsquo;s confirmation page</label>
              <label><input type="radio" name="evidence" value="CONFIRMATION_EMAIL" /> A confirmation email from the employer</label>
              <label><input type="radio" name="evidence" value="EMPLOYER_PORTAL" /> Their application portal</label>
              <label><input type="radio" name="evidence" value="OTHER" /> Something else</label>
            </fieldset>
            <label className="notefield">
              Note or reference (optional)
              <input type="text" name="note" maxLength={500} placeholder="e.g. confirmation number, what the email said" />
            </label>
            <div className="resolveactions">
              <button className="btn-primary" type="submit" name="decision" value="received">
                Confirm employer received application
              </button>
              <button className="btn-quiet" type="submit" name="decision" value="not-received">
                Confirm not submitted &middot; allow retry
              </button>
            </div>
            <p className="muted small">
              Confirming records your judgement, not a machine verification. The original
              evidence and the unconfirmed result are kept either way.
            </p>
          </form>
        </section>
      )}

      <section className="approve">
        {r.submitRunning || r.submitQueued ? (
          <p className="inflight">
            <strong>{r.submitRunning ? "Submitting\u2026" : "Starting submission\u2026"}</strong>
            <span className="muted">
              The worker on your Mac is handling this. You can leave this page; the request is
              saved and will carry on without you.
            </span>
          </p>
        ) : r.phase === "APPROVED" && r.submitOutcome !== "AMBIGUOUS" && !r.submittedAt ? (
          <>
            <form method="post" action="/api/applications/submit-request">
              <input type="hidden" name="applicationId" value={r.applicationId} />
              <button className="btn-primary big" type="submit">Submit application</button>
            </form>
            <p className="muted">
              {r.submitOutcome === "SAFE_STOP"
                ? "The last attempt stopped before anything was sent, so trying again is safe."
                : r.submitOutcome === "DECLINED"
                ? "The last request was declined before it started."
                : "This asks the worker on your Mac to submit it. Every check runs again immediately before the application is sent."}
            </p>
          </>
        ) : r.assisted && r.assistedFinishCommand ? (
          <>
            <strong>Ready to finish on {r.providerLabel}</strong>
            <p className="muted">{r.noActionReason}</p>
            <p className="muted">Run this locally to open the pre-filled form (it fills every resolved
              answer and uploads the exact résumé above, then stops at {r.providerLabel}&rsquo;s human check):</p>
            <pre className="cmd"><code>{r.assistedFinishCommand}</code></pre>
            <p className="muted">Then solve the {r.providerLabel} check, confirm the values, and click Submit.
              The assisted run watches for the confirmation page and records it; if it cannot observe the
              result it will ask you to confirm rather than guess. Nothing is submitted automatically.</p>
          </>
        ) : r.canApprove ? (
          <>
            <form method="post" action="/api/applications/approve">
              <input type="hidden" name="applicationId" value={r.applicationId} />
              <button className="btn-primary big" type="submit">Approve application</button>
            </form>
            <p className="muted">
              Approval means this resume and these answers may proceed to the final submission
              workflow. It does not mean the application has been submitted yet.
            </p>
          </>
        ) : r.canApproveDespiteGap ? (
          <>
            <form method="post" action="/api/applications/approve">
              <input type="hidden" name="applicationId" value={r.applicationId} />
              <input type="hidden" name="acceptQualificationGap" value="1" />
              <button className="btn-primary big" type="submit">Approve anyway</button>
            </form>
            <p className="muted">
              Your verified evidence does not establish this role&rsquo;s core qualifications, so it will not be
              sent on its own. Approving here is your decision to apply regardless: it binds this exact resume
              and these answers, records that you accepted the gap, and hands the application to the same
              submission path as any other approval.
            </p>
          </>
        ) : r.noActionReason ? (
          <>
            {r.externalAction && (
              <a className="btn-primary big" href={r.externalAction.href} target="_blank" rel="noreferrer">{r.externalAction.label}</a>
            )}
            {!r.externalAction && r.jobUrl && (
              <a className="btn-primary big" href={r.jobUrl} target="_blank" rel="noreferrer">Open job listing</a>
            )}
            <p className="muted">{r.noActionReason}</p>
          </>
        ) : r.phase === "PREPARED" ? (
          <p className="muted">This cannot be approved until the points above are resolved.</p>
        ) : null}
        <div className="secondary">
          <a className="btn-quiet" href="/apply">Back to Apply</a>
        </div>
      </section>

      <details className="tech">
        <summary>Technical details</summary>
        <dl>
          {Object.entries(r.technical).map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{String(v ?? "none")}</dd></div>
          ))}
        </dl>
      </details>
    </main>
  );
}
