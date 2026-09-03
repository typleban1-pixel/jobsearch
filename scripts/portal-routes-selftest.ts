/**
 * Every link the portal offers must go somewhere that exists.
 *
 *   node scripts/portal-routes-selftest.ts
 *
 * "Answer questions" pointed at /applications/{id}/questions, a route
 * that has never existed. It appeared precisely when an application had
 * blocked questions -- the moment a person most needs it to work -- and
 * 404'd every time.
 *
 * The route list is read from the filesystem rather than hardcoded, so a
 * renamed or deleted page fails this test instead of shipping a dead
 * link.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { present, type ApplicationFacts } from "../lib/portal/presentationState.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};

/** Every route the app actually serves, walked from the app directory. */
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
const ALL = routes();
console.log(`\nroutes served: ${ALL.length}`);

/** Does a concrete href match a route, allowing [id] segments? */
const routeExists = (href: string): boolean => {
  if (/^https?:\/\//.test(href)) return true;          // an employer URL
  const parts = href.split("?")[0]!.split("/").filter(Boolean);
  return ALL.some((r) => {
    const rp = r.split("/").filter(Boolean);
    return rp.length === parts.length
      && rp.every((seg, i) => seg.startsWith("[") || seg === parts[i]);
  });
};

const F = (over: Partial<ApplicationFacts> = {}): ApplicationFacts => ({
  status: "AWAITING_REVIEW", humanApproved: false, allFieldsConfident: true,
  blockedAnswers: 0, submittedAt: null, confirmationReceived: false,
  provider: "GREENHOUSE", refusals: [], handoff: false, ...over,
} as ApplicationFacts);
const ID = "35eaed21-599e-4480-bc7b-192677c80f18";

console.log("\n1. the link that 404'd:");
{
  const p = present(F({ blockedAnswers: 3 }), ID);
  check("a blocked application offers an action", Boolean(p.action), JSON.stringify(p));
  check(`its href exists: ${p.action!.href}`, routeExists(p.action!.href), p.action!.href);
  // The ban is on the route that never existed, not on the word.
  // Written as a suffix test, it also rejected /apply/questions -- the
  // page that actually answers questions.
  check("it is not /applications/{id}/questions",
    !new RegExp(`^/applications/[^/]+/questions$`).test(p.action!.href), p.action!.href);
  check("it is the question wizard, not the review page",
    p.action!.href === "/apply/questions", p.action!.href);
}

console.log("\n2. every state's action resolves:");
{
  const states: Array<[string, ApplicationFacts]> = [
    ["blocked answers", F({ blockedAnswers: 5 })],
    ["awaiting review", F({ status: "AWAITING_REVIEW" })],
    ["ready to submit", F({ status: "READY_TO_SUBMIT", humanApproved: true })],
    ["blocked needs input", F({ status: "BLOCKED_NEEDS_INPUT" })],
    ["submitted", F({ status: "SUBMITTED", submittedAt: "2026-09-01T00:00:00Z" })],
    ["handoff", F({ handoff: true, status: "AWAITING_REVIEW" })],
    ["preparing", F({ status: "PREPARING" })],
    ["with refusals", F({ refusals: ["NOT_ELIGIBLE"] })],
    ["no discovered fields", F({ discoveredFields: 0 } as any)],
  ];
  for (const [label, facts] of states) {
    const p = present(facts, ID);
    if (!p.action) { check(`${label}: no action offered`, true); continue; }
    check(`${label}: ${p.action.href}`, routeExists(p.action.href), p.action.href);
  }
}

console.log("\n3. the routes this file depends on are really there:");
{
  for (const r of ["/applications/[id]/review", "/applications/queue", "/applications/[id]"]) {
    check(`${r} exists`, ALL.includes(r), JSON.stringify(ALL.filter((x) => x.startsWith("/applications"))));
  }
  check("/applications/[id]/questions does NOT exist, as expected",
    !ALL.includes("/applications/[id]/questions"));
}

console.log("\n4. a dead link is detectable:");
check("routeExists rejects a made-up route", !routeExists("/applications/abc/nowhere"));
check("and accepts a real one with an id", routeExists(`/applications/${ID}/review`));
check("and accepts an employer URL", routeExists("https://boards.greenhouse.io/x"));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("every offered link goes somewhere that exists");
