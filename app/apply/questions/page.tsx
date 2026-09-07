import { redirect } from "next/navigation";
import { currentSession } from "../../../lib/portal/session.ts";
import { loadBlockedGroups, answerIdsFor } from "../../../lib/portal/applyBoard.ts";
import { summarize } from "../../../lib/portal/questionGroups.ts";
import { PrimaryNav } from "../../PrimaryNav.tsx";
import { QuestionsForm, type FormData, type FormItem } from "./QuestionsForm.tsx";

export const dynamic = "force-dynamic";

/**
 * Every unresolved question on one screen.
 *
 * The old flow paged through one question at a time. This shows all of
 * them at once, grouped by application, with the duplicate questions that
 * are SAFE to reuse pulled into a single shared control -- reusing the
 * same question grouping the queue uses, and the same readiness logic on
 * save. Consent and anything not marked reusable stays one control per
 * application, so an agreement is never inferred across employers.
 */
export default async function ConsolidatedQuestions() {
  const session = await currentSession();
  if (!session) redirect("/login");

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

  // Build the view model. A group with one member, or a multi-member group
  // that is not reusable, becomes one control PER application; a reusable
  // multi-member group becomes a single shared control that writes to every
  // member (the resolver still checks each application's own form).
  const byApplication = new Map<string, FormItem[]>();
  const shared: FormItem[] = [];
  let total = 0;

  for (const g of groups) {
    const ids = await answerIdsFor(session.client, g);
    const idOf = (appId: string, fieldKey: string) => ids.get(`${appId}:${fieldKey}`) ?? "";
    const question = g.questionText || g.label;
    // "If yes, please enter your position title and dates" means nothing
    // without the question above it. Shown when every member agrees on it.
    const contextOf = (f: { follows?: { question: string; answer: string | null } | null }) =>
      f.follows ? `Follows “${f.follows.question}” — ${f.follows.answer === null ? "not answered yet" : `answered “${f.follows.answer}”`}` : null;
    const sharedContext = (() => {
      const all = g.fields.map(contextOf);
      return all.length && all.every((c) => c && c === all[0]) ? all[0] : null;
    })();

    if (g.fields.length > 1 && g.reusable) {
      const primary = g.fields[0]!;
      const controlId = idOf(primary.applicationId, primary.fieldKey);
      if (!controlId) continue;
      const reuseAnswerIds = g.fields.slice(1)
        .map((f) => idOf(f.applicationId, f.fieldKey)).filter(Boolean);
      shared.push({
        controlId, reuseAnswerIds, question, blockedReason: g.blockedReason,
        required: g.required, options: g.universalOptions, type: primary.type,
        applications: [...new Set(g.fields.map((f) => f.applicationLabel))], applicationId: null,
        applyUrl: primary.applyUrl ?? null, context: sharedContext,
      });
      total += 1;
      continue;
    }

    // One control per member: single-member groups, and non-reusable groups
    // where each application must be answered on its own.
    for (const f of g.fields) {
      const controlId = idOf(f.applicationId, f.fieldKey);
      if (!controlId) continue;
      const item: FormItem = {
        controlId, reuseAnswerIds: [], question: f.questionText || f.label || question,
        blockedReason: f.blockedReason ?? g.blockedReason, required: f.required,
        options: f.options, type: f.type, applications: [f.applicationLabel], applicationId: f.applicationId,
        applyUrl: f.applyUrl ?? null, context: contextOf(f),
      };
      const list = byApplication.get(f.applicationLabel) ?? [];
      list.push(item); byApplication.set(f.applicationLabel, list);
      total += 1;
    }
  }

  const data: FormData = {
    perApplication: [...byApplication.entries()]
      .map(([application, items]) => ({ application, items }))
      .sort((a, b) => a.application.localeCompare(b.application)),
    shared, total,
  };

  return (
    <main className="wizard">
      <header className="applyhead">
        <h1>Questions</h1>
        <PrimaryNav current="apply" />
      </header>
      <div className="wizardhead">
        <p className="needcount">
          <strong>
            {s.answersNeeded > 0
              ? `${s.answersNeeded} answer${s.answersNeeded === 1 ? "" : "s"} needed`
              : "No answers to type"}
          </strong>
        </p>
        <p className="muted">
          Across {s.applications} application{s.applications === 1 ? "" : "s"}.
          {s.answersNeeded > 0 && " Answer what you can and save once; nothing is submitted here."}
          {s.handoffs > 0 && ` ${s.handoffs} file upload${s.handoffs === 1 ? "" : "s"} to finish on the employer's own form.`}
        </p>
      </div>
      <QuestionsForm data={data} />
    </main>
  );
}
