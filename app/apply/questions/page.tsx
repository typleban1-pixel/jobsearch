import { redirect } from "next/navigation";
import { currentSession } from "../../../lib/portal/session.ts";
import { loadBlockedGroups, answerIdsFor } from "../../../lib/portal/applyBoard.ts";
import { summarize } from "../../../lib/portal/questionGroups.ts";
import { PrimaryNav } from "../../PrimaryNav.tsx";

export const dynamic = "force-dynamic";

/**
 * One question at a time.
 *
 * The old queue put every blocked field on one page, which meant the
 * same question appeared once per application and the reader did the
 * same work twice. Questions are grouped by what they actually ask, and
 * a group is offered for reuse only when reusing it is safe. Consent is
 * never in that set: two identical consent controls are still two
 * separate agreements.
 */
export default async function QuestionWizard(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const sp = await props.searchParams;
  const groups = await loadBlockedGroups(session.client);
  const s = summarize(groups);

  if (groups.length === 0) {
    return (
      <main className="wizard">
        <header className="applyhead"><h1>Questions</h1><PrimaryNav current="apply" /></header>
        <section className="caughtup">
          <h2>That&rsquo;s everything we needed.</h2>
          <p>No questions are waiting for you.</p>
          <a className="btn-primary" href="/apply">Back to Apply</a>
        </section>
      </main>
    );
  }

  const raw = Number((Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? 1);
  const index = Math.min(Math.max(1, Number.isFinite(raw) ? raw : 1), groups.length);
  const group = groups[index - 1]!;
  const ids = await answerIdsFor(session.client, group);

  const primary = group.fields[0]!;
  const primaryId = ids.get(`${primary.applicationId}:${primary.fieldKey}`) ?? "";
  const others = group.fields.slice(1);
  const otherIds = others.map((f) => ids.get(`${f.applicationId}:${f.fieldKey}`) ?? "").filter(Boolean);

  const apps = [...new Set(group.fields.map((f) => f.applicationLabel))];
  const next = index < groups.length ? `/apply/questions?q=${index + 1}` : "/apply/questions/done";

  return (
    <main className="wizard">
      <header className="applyhead">
        <h1>Questions</h1>
        <PrimaryNav current="apply" />
      </header>

      <div className="wizardhead">
        <p className="needcount">
          <strong>{s.answersNeeded} answer{s.answersNeeded === 1 ? "" : "s"} needed</strong>
        </p>
        <p className="muted">
          These answers apply to {s.blockedFields} fields across {s.applications} application{s.applications === 1 ? "" : "s"}.
        </p>
      </div>

      <article className="qcard">
        <p className="qprogress">Question {index} of {groups.length}</p>
        <h2 className="qtext">{group.questionText || group.label}</h2>
        <p className="qasked">
          Asked by {group.fields.length} application{group.fields.length === 1 ? "" : "s"}
        </p>
        <ul className="qapps">{apps.map((a) => <li key={a}>{a}</li>)}</ul>

        {group.blockedReason && (
          <div className="qwhy">
            <p className="qwhyhead">Why we need you</p>
            <p>{group.blockedReason}</p>
          </div>
        )}

        <form method="post" action="/api/applications/answer">
          <input type="hidden" name="answerId" value={primaryId} />
          <input type="hidden" name="returnTo" value={next} />

          {group.options.length > 0 ? (
            <div className="qoptions">
              {group.options.map((o) => (
                <label key={o} className="qoption">
                  <input type="radio" name="answer" value={o} required />
                  <span>{o}</span>
                </label>
              ))}
            </div>
          ) : (
            <input className="qinput" type="text" name="answer" required
              aria-label={group.questionText || group.label} />
          )}

          {others.length > 0 && (
            group.reusable ? (
              <label className="qreuse">
                <input type="checkbox" name="reuseAnswerIds" value={otherIds.join(",")} />
                <span>Use this answer for {others.length === 1 ? "both applications" : `all ${group.fields.length} applications`}</span>
              </label>
            ) : (
              <p className="qnoreuse">{group.reuseNote}</p>
            )
          )}

          {!group.required && (
            <label className="qblank">
              <input type="checkbox" name="leaveBlank" value="1" />
              <span>Leave this blank</span>
            </label>
          )}

          <div className="qactions">
            {index > 1 && <a className="btn-quiet" href={`/apply/questions?q=${index - 1}`}>Back</a>}
            <button className="btn-primary" type="submit">Save &amp; next</button>
          </div>
        </form>
      </article>
    </main>
  );
}
