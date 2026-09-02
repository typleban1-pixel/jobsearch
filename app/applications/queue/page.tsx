import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "../../../lib/portal/session.ts";
import { loadQueue } from "../../../lib/portal/applications.ts";

export const dynamic = "force-dynamic";

/**
 * The blocked-question queue.
 *
 * Each row shows the employer's own wording, not a normalized paraphrase,
 * because the paraphrase is what the matcher believed and the wording is
 * what was actually asked. The distinction between UNKNOWN and AMBIGUOUS
 * is on screen because the two need different thinking: UNKNOWN means
 * look outside the profile, AMBIGUOUS means choose between readings the
 * profile already supports.
 */
export default async function Queue() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const items = await loadQueue(session.client);

  return (
    <main className="wrap">
      <p className="back"><Link href="/applications">← applications</Link></p>
      <h1>Questions waiting for you</h1>
      <p className="muted">
        {items.length === 0
          ? "Nothing is blocked. Every prepared application has an answer or a reason for every field."
          : `${items.length} field${items.length === 1 ? "" : "s"} could not be answered safely. Nothing here was guessed.`}
      </p>

      {items.map((q) => (
        <section key={q.id} className="queue-item">
          <p className="muted small">
            <Link href={`/applications/${q.applicationId}`}>{q.applicationCompany} — {q.applicationTitle}</Link>
            {" · "}{q.isRequired ? "required" : "optional"}
            {" · "}<span className={`chip ${q.blockKind === "AMBIGUOUS" ? "warn" : ""}`}>{q.blockKind ?? "UNKNOWN"}</span>
          </p>

          <p className="asked"><strong>{q.questionText}</strong></p>
          <p className="muted small">{q.blockedReason}</p>

          {q.considered.length > 0 && (
            <details>
              <summary className="small">What was considered and set aside ({q.considered.length})</summary>
              <ul className="small">
                {q.considered.map((c, i) => (
                  <li key={i}><em>{c.what}</em> — {c.whyRejected}</li>
                ))}
              </ul>
            </details>
          )}

          <p className="muted small">
            <span className={`chip ${q.advice.scope === "APPLICATION_ONLY" ? "warn" : ""}`}>
              {q.advice.scope === "PROFILE" ? "worth storing about you"
                : q.advice.scope === "QUESTION" ? "reusable for this exact question"
                : "this application only"}
            </span>{" "}
            {q.advice.why}
          </p>

          <form method="post" action="/api/applications/answer">
            <input type="hidden" name="answerId" value={q.id} />
            <input type="hidden" name="returnTo" value="/applications/queue" />
            {q.options.length > 0 ? (
              <fieldset className="choices">
                <legend className="small">
                  The employer offers these. An answer that is not one of them cannot be
                  selected at fill time, so pick one rather than typing.
                </legend>
                {q.options.map((o, i) => (
                  <label key={i} className="choice">
                    <input type="radio" name="answer" value={o} required={q.isRequired} />
                    <span>{o}</span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <textarea name="answer" rows={2} placeholder="Your answer" />
            )}
            <label className="small">
              <input type="checkbox" name="leaveBlank" value="1" /> leave this field blank
            </label>
            <label className="small">
              <input type="checkbox" name="promote" value="1"
                     defaultChecked={false} disabled={q.advice.scope === "APPLICATION_ONLY"} />{" "}
              {q.advice.scope === "APPLICATION_ONLY"
                ? "reuse is unavailable for this kind of question"
                : "reuse this answer on future applications"}
            </label>
            <button type="submit">Save answer</button>
          </form>
        </section>
      ))}
    </main>
  );
}
