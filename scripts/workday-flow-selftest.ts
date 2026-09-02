/**
 * The Workday application flow, end to end, without a browser.
 *
 *   node scripts/workday-flow-selftest.ts
 *
 * Every interesting case in this loop is a failure: an expired session,
 * a refused credential, a CAPTCHA, a redirect to another origin. None of
 * those can be produced on demand against a live employer, so the
 * browser and the keychain are injected and the whole state machine runs
 * here.
 *
 * The property that matters most is the last one: authentication cannot
 * change what an application is allowed to do.
 */
import { authenticateTenant, type AuthDeps } from "../lib/workday/authenticate.ts";
import { tenantFromToken } from "../lib/workday/tenant.ts";
import type { WorkdayPageState } from "../lib/workday/pageState.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};

const A = tenantFromToken("ntrs.wd1.myworkdayjobs.com/northerntrust");
const B = tenantFromToken("huron.wd1.myworkdayjobs.com/huroncareers");
const EMAIL = "plebantyler@gmail.com";
const PW = "Xk4!mQ7pRt2wZn9bVc3sLd6h";

/**
 * A scripted tenant. Each entry is what the next observation returns;
 * signIn advances to the next scripted state, which is how a login that
 * works and one that fails are told apart.
 */
function fake(states: Array<WorkdayPageState | { state: WorkdayPageState; url: string }>,
              credential: string | null) {
  let i = 0;
  const typed: string[] = [];
  const deps: AuthDeps = {
    observe: async () => {
      const s = states[Math.min(i, states.length - 1)]!;
      return typeof s === "string" ? { state: s, url: `https://${A.host}/${A.site}` } : s;
    },
    openSignIn: async () => { i++; },
    signIn: async (_e, p) => { typed.push(p); i++; },
    readCredential: async () => credential,
    email: EMAIL,
  };
  return { deps, typed };
}

console.log("\n1. a valid session proceeds:");
{
  const { deps, typed } = fake(["SIGNED_IN"], PW);
  const r = await authenticateTenant(A, deps);
  check("outcome is AUTHENTICATED", r.outcome === "AUTHENTICATED", JSON.stringify(r));
  check("session recorded VALID", r.sessionState === "VALID");
  check("account recorded EXISTS", r.accountState === "EXISTS");
  check("no credential was typed", typed.length === 0);
  check("and no reason is given, because nothing stopped", r.reason === null);
}

console.log("\n2. signed out with no account or credential -> ACCOUNT_REQUIRED:");
{
  const { deps, typed } = fake(["SIGNED_OUT"], null);
  const r = await authenticateTenant(A, deps);
  check("outcome is ACCOUNT_REQUIRED", r.outcome === "ACCOUNT_REQUIRED", JSON.stringify(r));
  check("the reason names the tenant", /ntrs\.wd1\.myworkdayjobs\.com/.test(r.reason ?? ""), r.reason ?? "");
  check("nothing was typed", typed.length === 0);
  check("it is not reported as a session expiry", r.sessionState === "UNKNOWN");
  // The same at the credential form, one page further in.
  const f2 = fake(["SIGN_IN_FORM"], null);
  check("a sign-in form with no credential is also ACCOUNT_REQUIRED",
    (await authenticateTenant(A, f2.deps)).outcome === "ACCOUNT_REQUIRED");
}

console.log("\n3. an expired session with a stored credential signs in and proceeds:");
{
  // Signed out -> open the form -> sign in -> signed in.
  const { deps, typed } = fake(["SIGNED_OUT", "SIGN_IN_FORM", "SIGNED_IN"], PW);
  const r = await authenticateTenant(A, deps, { everAuthenticated: true });
  check("outcome is AUTHENTICATED", r.outcome === "AUTHENTICATED", JSON.stringify(r));
  check("the credential was typed exactly once", typed.length === 1, `${typed.length}`);
  check("and it was the stored one", typed[0] === PW);
  check("the path shows the whole route",
    r.path.join(" -> ") === "SIGNED_OUT -> SIGN_IN_FORM -> SIGNED_IN", r.path.join(" -> "));
  check("signInAttempted is recorded", r.signInAttempted === true);
  // With a prior authentication on record, a no-session observation IS
  // an expiry. Without one it is not, and case 2 proves that.
  const f2 = fake(["SIGN_IN_FORM"], null);
  const r2 = await authenticateTenant(A, f2.deps, { everAuthenticated: true });
  check("a no-session page after a known session reads EXPIRED", r2.sessionState === "EXPIRED");
}

console.log("\n4. an invalid credential hands off and is never retried:");
{
  const { deps, typed } = fake(["SIGN_IN_FORM", "INVALID_CREDENTIALS"], PW);
  const r = await authenticateTenant(A, deps);
  check("outcome is HANDOFF", r.outcome === "HANDOFF", JSON.stringify(r));
  check("the reason says the credential was refused", /refused/.test(r.reason ?? ""), r.reason ?? "");
  check("it was typed once and only once", typed.length === 1, `${typed.length}`);
  check("and this is not reported as ACCOUNT_REQUIRED", r.outcome !== "ACCOUNT_REQUIRED");
}

console.log("\n5. every human-presence wall hands off:");
{
  for (const [state, expect] of [
    ["CAPTCHA", /CAPTCHA/i], ["MFA", /second factor/i],
    ["SECURITY_QUESTION", /security question/i], ["EMAIL_VERIFICATION", /verification/i],
    ["SSO_PROMPT", /identity provider/i],
  ] as Array<[WorkdayPageState, RegExp]>) {
    const { deps, typed } = fake([state], PW);
    const r = await authenticateTenant(A, deps);
    check(`${state} -> HANDOFF`, r.outcome === "HANDOFF", JSON.stringify(r.outcome));
    check(`  with a reason a person can act on`, expect.test(r.reason ?? ""), r.reason ?? "");
    check(`  and nothing typed`, typed.length === 0);
  }
}

console.log("\n6. an account that already exists hands off, never creates:");
{
  const { deps } = fake(["ACCOUNT_EXISTS"], null);
  const r = await authenticateTenant(A, deps);
  check("HANDOFF", r.outcome === "HANDOFF", JSON.stringify(r));
  check("the reason says an account exists we cannot open",
    /already exists/.test(r.reason ?? ""), r.reason ?? "");
}

console.log("\n7. a redirect off the tenant refuses, before anything is typed:");
{
  const { deps, typed } = fake([
    { state: "SIGN_IN_FORM", url: `https://${B.host}/${B.site}` },
  ], PW);
  const r = await authenticateTenant(A, deps);
  check("HANDOFF", r.outcome === "HANDOFF", JSON.stringify(r));
  check("the reason names both hosts",
    r.reason!.includes(B.host) && r.reason!.includes(A.host), r.reason ?? "");
  check("tenant A's credential was NOT typed into tenant B's form", typed.length === 0);
  // And an entirely foreign origin.
  const f2 = fake([{ state: "SIGN_IN_FORM", url: "https://login.evil.test/signin" }], PW);
  const r2 = await authenticateTenant(A, f2.deps);
  check("a foreign origin is refused too", r2.outcome === "HANDOFF" && f2.typed.length === 0);
  check("and the message carries only the host, not the full url",
    !r2.reason!.includes("/signin"), r2.reason ?? "");
}

console.log("\n8. account creation stays off:");
{
  const { deps, typed } = fake(["CREATE_ACCOUNT_FORM"], null);
  const r = await authenticateTenant(A, deps);
  check("a creation form with creation disabled -> ACCOUNT_REQUIRED",
    r.outcome === "ACCOUNT_REQUIRED", JSON.stringify(r));
  check("nothing was typed", typed.length === 0);
  // Even asked to, the flow does not create: it reports and stops.
  const f2 = fake(["CREATE_ACCOUNT_FORM"], null);
  const r2 = await authenticateTenant(A, f2.deps, { creationEnabled: true });
  check("even with creation enabled, the application flow does not create",
    r2.outcome === "ACCOUNT_REQUIRED", JSON.stringify(r2));
  check("and says so explicitly",
    /not performed by the application flow/.test(r2.reason ?? ""), r2.reason ?? "");
  check("still nothing typed", f2.typed.length === 0);
}

console.log("\n9. the loop is bounded:");
{
  // A tenant that never settles: always a sign-in form, credential held.
  const { deps, typed } = fake(["SIGN_IN_FORM"], PW);
  const r = await authenticateTenant(A, deps, { maxSteps: 4 });
  check("it terminates", r.outcome === "HANDOFF", JSON.stringify(r.outcome));
  check("and the credential is typed once, not once per step",
    typed.length === 1, `typed ${typed.length} times`);
}

console.log("\n10. no secret leaks into anything the run records:");
{
  const { deps } = fake(["SIGN_IN_FORM", "INVALID_CREDENTIALS"], PW);
  const r = await authenticateTenant(A, deps);
  const recorded = JSON.stringify(r);
  check("the password is not in the result", !recorded.includes(PW));
  check("nor is the email", !recorded.includes(EMAIL), recorded.slice(0, 120));
  check("the reason names no credential value", !r.reason!.includes(PW));
  const ok = await authenticateTenant(A, fake(["SIGNED_IN"], PW).deps);
  check("nor in a successful result", !JSON.stringify(ok).includes(PW));
}

console.log("\n11. authentication cannot approve or submit:");
{
  const r = await authenticateTenant(A, fake(["SIGNED_IN"], PW).deps);
  const keys = Object.keys(r);
  check("the result carries no approval field",
    !keys.some((k) => /approv|authoriz|submit|status/i.test(k)), JSON.stringify(keys));
  check("the strongest outcome is AUTHENTICATED", r.outcome === "AUTHENTICATED");
  check("which is not a submission or an approval",
    !/SUBMIT|APPROVE|READY/i.test(r.outcome));
  // The vocabulary is closed: three outcomes, none of which act on an
  // application record.
  const outcomes = new Set<string>();
  for (const s of ["SIGNED_IN", "SIGNED_OUT", "SIGN_IN_FORM", "CREATE_ACCOUNT_FORM", "CAPTCHA",
                   "MFA", "ACCOUNT_EXISTS", "INVALID_CREDENTIALS", "EMAIL_VERIFICATION",
                   "SECURITY_QUESTION", "SSO_PROMPT", "JOB_POSTING", "UNKNOWN"] as WorkdayPageState[]) {
    for (const cred of [PW, null]) outcomes.add((await authenticateTenant(A, fake([s], cred).deps)).outcome);
  }
  check("every reachable outcome is one of three",
    [...outcomes].every((o) => ["AUTHENTICATED", "ACCOUNT_REQUIRED", "HANDOFF"].includes(o)),
    JSON.stringify([...outcomes]));
}

console.log("\n12. a readable page that proves no session is not authentication:");
{
  const r = await authenticateTenant(A, fake(["JOB_POSTING"], PW).deps);
  check("a public posting is not treated as authenticated",
    r.outcome === "HANDOFF", JSON.stringify(r));
  check("and says no session was observed",
    /no authenticated session/.test(r.reason ?? ""), r.reason ?? "");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("authentication reaches a form, and never reaches an approval");
