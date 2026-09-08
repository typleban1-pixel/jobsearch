import { redirect } from "next/navigation";
import { currentSession } from "../../../../lib/portal/session.ts";
import { loadReview, type ReviewCheck } from "../../../../lib/portal/reviewData.ts";
import { PrimaryNav } from "../../../PrimaryNav.tsx";
import { ApproveButton } from "../../../apply/ApproveButton.tsx";
import Link from "next/link";

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
  const refusedRaw = Array.isArray(sp.refused) ? sp.refused[0] : sp.refused;
  const REFUSAL_TEXT: Record<string, string> = {
    MATERIAL_QUALIFICATION_GAP: "the role's core qualifications are not established by your verified evidence",
    BLOCKED_ANSWERS: "some questions are still open (answer them or leave them blank on the Questions page)",
    REQUIRED_UNANSWERED: "a required field is unanswered",
    POSTING_NOT_OPEN: "the posting is no longer open",
    NOT_ELIGIBLE: "the job no longer meets your eligibility rules",
    CANDIDACY_REFUSES: "this no longer looks like a match",
    POSTING_CHANGED: "the posting changed after this application was prepared",
    ALREADY_SUBMITTED_ON_OPENING: "you have already applied to this opening",
    ARTIFACT_CHANGED: "the resume changed after it was reviewed",
    ANSWERS_CHANGED: "the answers changed after they were reviewed",
    FIELDS_NOT_CONFIDENT: "not every field has a confident answer yet",
    NO_CURRENT_CANDIDACY: "this job has no current candidacy verdict",
  };
  const refused = refusedRaw ? String(refusedRaw).split(",").filter(Boolean).map((c) => REFUSAL_TEXT[c] ?? c.toLowerCase().replace(/_/g, " ")) : [];

  return (
    <main className="review">
      <header className="applyhead">
        <h1>Review application</h1>
        <PrimaryNav current="apply" />
      </header>

      {refused.length > 0 && (
        <div className="banner warn">
          <strong>Not approved.</strong>{" "}
          <span>The approval was refused because {refused.join("; and ")}. Fix that and try again.</span>
        </div>
      )}
      {justApproved && (
        <div className="banner good">
          <strong>Application approved &#10003;</strong>
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

      {/* The posting itself, as the reference while approving: what it
          asks for and what it says, with the original a click away. */}
      <section className="posting" aria-labelledby="posting-h">
        <h3 id="posting-h">The posting</h3>
        <p className="facts">
          {r.location && <span>{r.location}</span>}
          {r.workArrangement && <span>{r.workArrangement}</span>}
          {r.salary && <span>{r.salary}</span>}
          {r.posting.postedAt && <span>Posted {new Date(r.posting.postedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
          <span>Found via {r.posting.source}</span>
          {r.jobUrl && <a href={r.jobUrl} target="_blank" rel="noopener noreferrer">View original &#8599;</a>}
        </p>
        {r.posting.requirements.length > 0 && (
          <>
            <p className="muted small">What it asks for ({r.posting.requirements.length}):</p>
            <ul className="reqs">{r.posting.requirements.map((q) => <li key={q}>{q}</li>)}</ul>
          </>
        )}
        {r.posting.descriptionFull
          ? <p className="desc">{r.posting.descriptionFull}</p>
          : <p className="muted small">No description was captured for this posting.</p>}
      </section>

      {/* A submission that has happened is terminal: its outcome takes
          precedence over any pre-submit readiness. Only when nothing has been
          submitted (terminalState NONE) do the readiness warnings show. */}
      {r.terminalState === "CONFIRMED" ? (
        <div className="banner good">
          <strong>Submitted successfully &#10003;</strong>
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
            <dt>Employer &amp; role</dt><dd>{r.company} &mdash; {r.title}</dd>
            {r.submissionMode && (<><dt>Submission mode</dt><dd>{r.submissionMode}</dd></>)}
            <dt>Resume used</dt><dd>{r.resume.hasArtifact ? "Exact tailored PDF (below)" : "no saved PDF bound"}</dd>
            <dt>Confirmation</dt><dd>{r.confirmed || r.terminalState === "CONFIRMED" ? "Received" : "Not received"}</dd>
          </dl>
        </section>
      ) : r.noActionReason ? (
        <section className="pane">
          <h3>How this application works</h3>
          <p className="muted">{r.noActionReason}</p>
        </section>
      ) : null}

      {/* The review, as three steps. Each step summarises what went right and
          expands the one thing, if any, that needs the person. */}
      {(() => {
        const blocked = r.answers.filter((a) => a.state === "BLOCKED");
        const answered = r.answers.filter((a) => a.state !== "BLOCKED");
        const resumeOk = r.resumeChecks.every((c) => c.state === "PASS");
        const resumeProblems = r.resumeChecks.filter((c) => c.state !== "PASS");
        const finalProblems = r.applicationChecks.filter((c) => c.state === "FAIL" && !/questions/i.test(c.label));
        return (
          <ol className="reviewsteps">
            <li className={`reviewstep${resumeOk ? " ok" : " attention"}`}>
              <div className="reviewstep-head">
                <span className="stepno" aria-hidden="true">1</span>
                <h3>Resume</h3>
                <span className={`stepstatus ${resumeOk ? "ok" : "warn"}`}>
                  {resumeOk ? "\u2713 Tailored and ready" : `\u26a0 ${resumeProblems.map((c) => c.whenFailed ?? c.label).join("; ")}`}
                </span>
              </div>
              {r.resume.hasArtifact ? (
                <details className="reviewstep-body">
                  <summary className="btn-quiet">Preview the PDF</summary>
                  <object className="pdf" data={`/applications/${r.applicationId}/resume.pdf`} type="application/pdf">
                    <p>Your browser cannot display the PDF here.</p>
                  </object>
                  <a className="btn-quiet" href={`/applications/${r.applicationId}/resume.pdf`} target="_blank" rel="noopener noreferrer">Open PDF in a new tab</a>
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
                </details>
              ) : (
                <p className="bad">{r.resume.linesAccepted > 0 || r.resume.contentSha256
                  ? "No saved PDF is bound to this application."
                  : "Nothing has been prepared for this application yet, so there is no resume to review."}</p>
              )}
            </li>

            <li className={`reviewstep${blocked.length ? " attention" : " ok"}`}>
              <div className="reviewstep-head">
                <span className="stepno" aria-hidden="true">2</span>
                <h3>Application questions</h3>
                <span className={`stepstatus ${blocked.length ? "warn" : "ok"}`}>
                  {answered.length > 0 && <>{"\u2713"} {answered.length} answered automatically</>}
                  {answered.length > 0 && blocked.length > 0 && " \u00b7 "}
                  {blocked.length > 0 && <>{"\u26a0"} {blocked.length} need{blocked.length === 1 ? "s" : ""} you</>}
                  {answered.length === 0 && blocked.length === 0 && "No questions on this form"}
                </span>
              </div>
              {blocked.length > 0 && (
                <div className="needsinput">
                  <p className="needsinput-lead"><b>Needs your input</b></p>
                  <ul className="answers blocked">
                    {blocked.map((a) => (
                      <li key={a.fieldKey}>
                        <p className="q">{a.question}</p>
                        {a.blockedReason && <p className="src">{a.blockedReason}</p>}
                      </li>
                    ))}
                  </ul>
                  <Link className="btn-primary" href={`/apply/questions#app-${r.applicationId}`}>
                    Answer {blocked.length === 1 ? "it" : "them"} &rarr;
                  </Link>
                </div>
              )}
              {answered.length > 0 && (
                <details className="reviewstep-body">
                  <summary className="btn-quiet">Read the {answered.length} answer{answered.length === 1 ? "" : "s"} the employer will receive</summary>
                  <ul className="answers">
                    {answered.map((a) => (
                      <li key={a.fieldKey}>
                        <p className="q">{a.question}</p>
                        <p className="a">{a.answer ?? <em>left blank</em>}</p>
                        {a.source && <p className="src">{a.source}</p>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>

            <li className={`reviewstep${r.warnings.length || finalProblems.length ? " attention" : " ok"}`}>
              <div className="reviewstep-head">
                <span className="stepno" aria-hidden="true">3</span>
                <h3>Final review</h3>
                <span className={`stepstatus ${r.warnings.length || finalProblems.length ? "warn" : "ok"}`}>
                  {r.warnings.length === 0 && finalProblems.length === 0
                    ? "\u2713 Everything else looks good"
                    : `\u26a0 ${r.warnings.length + finalProblems.length} thing${r.warnings.length + finalProblems.length === 1 ? "" : "s"} to look at`}
                </span>
              </div>
              {(r.warnings.length > 0 || finalProblems.length > 0) && (
                <ul className="reviewstep-problems">
                  {r.warnings.map((w) => <li key={w}>{w}</li>)}
                  {finalProblems.map((c) => <li key={c.label}>{c.label}</li>)}
                </ul>
              )}
              <details className="tech">
                <summary>All checks</summary>
                <div className="checklists compact">
                  <div><h4>Resume</h4><ul className="checks">{r.resumeChecks.map((c) => <Check key={c.label} c={c} />)}</ul></div>
                  <div><h4>Application</h4><ul className="checks">{r.applicationChecks.map((c) => <Check key={c.label} c={c} />)}</ul></div>
                  <div><h4>Final submission</h4><ul className="checks">{r.finalChecks.map((c) => <Check key={c.label} c={c} />)}</ul></div>
                </div>
              </details>
            </li>
          </ol>
        );
      })()}


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
        ) : r.phase === "APPROVED" && r.submitOutcome !== "AMBIGUOUS" && !r.submittedAt && !r.automatable ? (
          <>
            <strong>Approved. Finish it on {r.providerLabel}.</strong>
            <p className="muted">
              {r.providerLabel} is not submitted by the worker, so the last step is yours: open the employer&rsquo;s
              form, attach the resume above (Open PDF), and use the answers on this page. Nothing here submits.
            </p>
            {r.applyUrl && (
              <a className="btn-primary big" href={r.applyUrl} target="_blank" rel="noreferrer">Continue on {r.providerLabel}</a>
            )}
          </>
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
            <ApproveButton applicationId={r.applicationId} accountSetup={r.accountSetup} />
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
          <a className="btn-quiet" href="/apply">Back to Applications</a>
          {/* A follow-up to the recruiter, composed from the approved
              résumé and the posting; it lands on Outreach to copy. */}
          <form method="post" action="/api/outreach/draft">
            <input type="hidden" name="applicationId" value={r.applicationId} />
            <button type="submit" className="btn-quiet">Send a note to the recruiter &rarr;</button>
          </form>
          {!r.submittedAt && (
            <form method="post" action="/api/applications/abandon">
              <input type="hidden" name="applicationId" value={r.applicationId} />
              <input type="hidden" name="returnTo" value="/apply" />
              <button type="submit" className="qapp-remove-btn" aria-label="Not interested: remove this application">Not interested · remove this application</button>
            </form>
          )}
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
