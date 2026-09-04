import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";
import { evaluateReadiness } from "../../../../lib/applications/readiness.ts";
import { resolveOneAnswer, type AnswerResolution } from "../../../../lib/applications/resolveAnswers.ts";

/**
 * Saving every answered question in one request.
 *
 * The consolidated questions form posts all the reader's answers at once.
 * Each is applied INDEPENDENTLY through the same shared resolver the
 * one-at-a-time route uses, so a single bad answer never discards the
 * others: successes are written and reported saved, failures are reported
 * with a reason and left open for a retry. Answers are HUMAN_CONFIRMED and
 * never inferred; reuse is only what the reader explicitly ticked.
 *
 * After the writes, every application any answer touched is re-evaluated
 * EXACTLY ONCE (a Set dedupes applications a shared answer resolved), and
 * evaluateReadiness is itself idempotent, so a newly ready application is
 * enqueued once and an already-queued or submitted one is left alone.
 */
const MAX = 500;

export async function POST(request: Request): Promise<Response> {
  const store = await cookies();
  const db = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 400 }); }
  const raw = Array.isArray(body?.answers) ? body.answers : null;
  if (!raw) return NextResponse.json({ error: "answers must be an array" }, { status: 400 });
  if (raw.length === 0) return NextResponse.json({ error: "no answers to save" }, { status: 400 });
  if (raw.length > MAX) return NextResponse.json({ error: `too many answers in one request (max ${MAX})` }, { status: 413 });

  const resolutions: AnswerResolution[] = raw.map((a: any) => ({
    answerId: String(a?.answerId ?? ""),
    answer: String(a?.answer ?? "").trim(),
    leaveBlank: a?.leaveBlank === true,
    promote: a?.promote === true,
    reuseAnswerIds: Array.isArray(a?.reuseAnswerIds)
      ? a.reuseAnswerIds.map((x: unknown) => String(x)).filter(Boolean) : [],
  }));

  // Apply each resolution. Sequential on purpose: two answers can resolve
  // the same application, and doing them in order keeps the unblock check
  // consistent. Each is independent, so one failure never aborts the rest.
  const results = [];
  const touched = new Set<string>();
  for (const r of resolutions) {
    const res = await resolveOneAnswer(db as any, r);
    results.push(res);
    for (const id of res.touched) touched.add(id);
  }

  // Re-evaluate each affected application exactly once. Failures are
  // captured, not thrown: the scheduled sweep re-evaluates everything, so
  // the worst case is a short delay, never a lost or double-queued app.
  const reevaluated = [];
  for (const applicationId of touched) {
    try {
      const outcome = await evaluateReadiness(db as any, applicationId);
      reevaluated.push({ applicationId, ...outcome });
    } catch (e) {
      reevaluated.push({ applicationId, ready: false, code: "REEVAL_ERROR", note: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  const saved = results.filter((r) => r.ok && r.status === "SAVED").length;
  const alreadyResolved = results.filter((r) => r.status === "ALREADY_RESOLVED").length;
  const failed = results.filter((r) => !r.ok);
  const enqueued = reevaluated.filter((r: any) => r.enqueued === true).length;

  return NextResponse.json({
    ok: failed.length === 0,
    saved, alreadyResolved, failedCount: failed.length,
    appsReevaluated: touched.size, enqueued,
    results, reevaluated,
  }, { status: failed.length === 0 ? 200 : 207 });
}
