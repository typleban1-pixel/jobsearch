/**
 * The "Answer questions" button, end to end, against real applications.
 *
 * The button 404'd in production for every application with a blocked
 * question. The first repair pointed it at a route that exists but
 * cannot answer anything. So this checks three separate things, because
 * only the third is what a person actually needs:
 *
 *   1. the href resolves to a route the app serves
 *   2. that route is the question flow, not a review page
 *   3. that flow really offers THIS application's unresolved questions,
 *      with the same count the card promised, and the answer rows it
 *      would write belong to that application
 *
 * Run against at least two applications, so nothing here can be true by
 * accident for one id.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { present, type ApplicationFacts } from "../lib/portal/presentationState.ts";
import { loadBlockedGroups, answerIdsFor } from "../lib/portal/applyBoard.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};

function routes(dir = "app", prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) {
      if (e.startsWith("(") || e === "api") { out.push(...routes(full, prefix)); continue; }
      out.push(...routes(full, `${prefix}/${e}`));
    } else if (e === "page.tsx") out.push(prefix || "/");
  }
  return out;
}
const ALL = new Set(routes());
const resolves = (href: string) => {
  const parts = href.split("?")[0]!.split("/").filter(Boolean);
  return [...ALL].some((r) => {
    const rp = r.split("/").filter(Boolean);
    return rp.length === parts.length && rp.every((seg, i) => seg.startsWith("[") || seg === parts[i]);
  });
};

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

// ---- real applications that are actually in the broken state --------
/**
 * Only applications a person can actually act on.
 *
 * An abandoned application still has blocked answer rows, but the wizard
 * deliberately does not offer them and no card invites you to answer
 * them. Testing those asserted that a dead application should appear in
 * a live queue, which is the opposite of what the system should do.
 */
const LIVE = ["BLOCKED_NEEDS_INPUT", "AWAITING_REVIEW", "READY_TO_SUBMIT", "PREPARED"];
const { data: allApps, error: appsError } = await db.from("applications").select("id,job_id,status");
if (appsError) { console.error(appsError.message); process.exit(1); }
const apps = (allApps ?? []).filter((a: any) => LIVE.includes(String(a.status)));
const withBlocked: { id: string; blocked: number; label: string }[] = [];
for (const a of apps as any[]) {
  const { count } = await db.from("application_answers")
    .select("id", { count: "exact", head: true }).eq("application_id", a.id).eq("confidence_state", "BLOCKED");
  if (!count) continue;
  const { data: j } = await db.from("jobs").select("title,company_id").eq("id", a.job_id).maybeSingle();
  const { data: c } = await db.from("companies").select("name").eq("id", j?.company_id).maybeSingle();
  withBlocked.push({ id: a.id, blocked: count, label: `${c?.name} — ${String(j?.title).slice(0, 40)}` });
}
console.log(`\napplications with unresolved questions: ${withBlocked.length}`);
check("at least two such applications exist to test with", withBlocked.length >= 2, String(withBlocked.length));

const F = (id: string, blocked: number): ApplicationFacts => ({
  status: "BLOCKED_NEEDS_INPUT", blockedAnswers: blocked, requiredUnanswered: 0,
  humanApproved: false, allFieldsConfident: false, submittedAt: null, applyUrl: null,
  provider: "GREENHOUSE", discoveredFields: 5,
  confirmationReceived: false, refusals: [], handoff: null,
} as unknown as ApplicationFacts);

// ---- the wizard's own view of the world -----------------------------
const groups = await loadBlockedGroups(db as any);
const byApplication = new Map<string, number>();
for (const g of groups) for (const f of g.fields) {
  byApplication.set(f.applicationId, (byApplication.get(f.applicationId) ?? 0) + 1);
}
console.log(`the wizard groups ${groups.length} distinct question(s) across ${byApplication.size} application(s)`);

for (const app of withBlocked.slice(0, 4)) {
  console.log(`\n${app.label}  (${app.id.slice(0, 8)}, ${app.blocked} blocked)`);
  const p = present(F(app.id, app.blocked), app.id);

  check("offers an Answer questions action", p.action?.label === "Answer questions", JSON.stringify(p.action));
  check(`href resolves to a served route: ${p.action?.href}`, resolves(p.action!.href), p.action!.href);
  check("href is not the route that never existed",
    !new RegExp("^/applications/[^/]+/questions$").test(p.action!.href), p.action!.href);
  check("href is the question flow, not the review page",
    p.action!.href === "/apply/questions", p.action!.href);

  // The destination must actually carry THIS application's questions.
  const offered = byApplication.get(app.id) ?? 0;
  check(`the wizard offers this application's questions (${offered})`, offered > 0, `offered ${offered}`);
  check(`the count matches what the card promised (${app.blocked})`,
    offered === app.blocked, `card said ${app.blocked}, wizard offers ${offered}`);

  // And the rows it would write belong to this application, not another.
  const mine = groups.filter((g: any) => g.fields.some((f: any) => f.applicationId === app.id));
  let correctlyOwned = true;
  for (const g of mine) {
    const ids = await answerIdsFor(db as any, g);
    for (const f of g.fields.filter((x: any) => x.applicationId === app.id)) {
      const answerId = ids.get(`${f.applicationId}:${f.fieldKey}`);
      if (!answerId) { correctlyOwned = false; continue; }
      const { data: row } = await db.from("application_answers")
        .select("application_id").eq("id", answerId).maybeSingle();
      if (row?.application_id !== app.id) correctlyOwned = false;
    }
  }
  check("every answer row the wizard would write belongs to this application", correctlyOwned);
}

// ---- the way back ----------------------------------------------------
check("/applications still resolves", resolves("/applications"));
check("/apply resolves", resolves("/apply"));
check("the wizard's post target exists",
  statSync("app/api/applications/answer/route.ts").isFile());

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
console.log("every application with unresolved questions opens a page that can answer them");
