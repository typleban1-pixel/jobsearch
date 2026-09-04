import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../lib/portal/supabase.ts";
import { evaluateReadiness } from "../../../../lib/applications/readiness.ts";
import { resolveOneAnswer } from "../../../../lib/applications/resolveAnswers.ts";

/**
 * Answering one blocked question (the queue's one-at-a-time form).
 *
 * The write, the option check against this application's own frozen
 * snapshot, deliberate reuse and the unblock transition all live in the
 * shared resolver, so this route and the consolidated form behave
 * identically. The answer becomes HUMAN_CONFIRMED: you supplied it, so it
 * is never presented as derived or inferred. "Leave blank" is a real
 * answer, not an absence.
 */
const STATUS: Record<string, number> = {
  EMPTY: 400, NOT_FOUND: 404, OPTION_NOT_OFFERED: 409, ERROR: 500,
};

export async function POST(request: Request): Promise<Response> {
  const store = await cookies();
  const db = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (name, value, options) => store.set(name, value, options as any),
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const form = await request.formData();
  const returnTo = String(form.get("returnTo") ?? "/applications/queue");
  const res = await resolveOneAnswer(db as any, {
    answerId: String(form.get("answerId") ?? ""),
    answer: String(form.get("answer") ?? "").trim(),
    leaveBlank: form.get("leaveBlank") === "1",
    promote: form.get("promote") === "1",
    reuseAnswerIds: String(form.get("reuseAnswerIds") ?? "").split(",").map((x) => x.trim()).filter(Boolean),
  });

  if (!res.ok) {
    return NextResponse.json({ error: res.message ?? "could not save the answer" },
      { status: STATUS[res.status] ?? 500 });
  }

  // Re-evaluate every application this answer touched, exactly once; the
  // evaluator is idempotent, and a failure here is deliberately swallowed
  // because the scheduled sweep re-evaluates everything.
  for (const appId of new Set(res.touched)) {
    await evaluateReadiness(db as any, appId).catch(() => undefined);
  }

  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/applications/queue";
  return NextResponse.redirect(new URL(safe, request.url), { status: 303 });
}
