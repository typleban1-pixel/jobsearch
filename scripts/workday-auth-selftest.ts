/**
 * Workday authentication: classification, decisions, isolation, secrets.
 *
 *   node scripts/workday-auth-selftest.ts
 *
 * Everything here is pure or hits the real macOS keychain under a
 * dedicated test service name, so none of it can touch a real tenant, a
 * real credential or a real application.
 *
 * The properties under test are the ones that make this safe to run
 * unattended: a page that is several things at once resolves to the one
 * that STOPS; a credential for one tenant can never authenticate
 * another; and no secret reaches anything durable.
 */
import { classifyWorkdayPage, isActionable, type PageSignals, type WorkdayPageState } from "../lib/workday/pageState.ts";
import { planNext, sessionStateFrom, accountStateFrom, type AuthContext } from "../lib/workday/authPlan.ts";
import { tenantFromToken, tenantFromUrl, tenantKey, urlBelongsToTenant, candidateHomeUrl } from "../lib/workday/tenant.ts";
import { generatePassword, keychainRef, storePassword, readPassword, hasPassword,
         deletePassword, redact, KEYCHAIN_TEST_SERVICE, KEYCHAIN_SERVICE } from "../lib/workday/keychain.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};

const sig = (o: Partial<PageSignals> = {}): PageSignals => ({
  automationIds: [], text: "", url: "https://ntrs.wd1.myworkdayjobs.com/northerntrust",
  inputTypes: [], captcha: false, captchaBadgeOnly: false, sso: false, ...o,
});
const ctx = (o: Partial<AuthContext> = {}): AuthContext =>
  ({ hasCredential: false, signInAttempted: false, createAttempted: false, creationEnabled: false, ...o });

// ---------------------------------------------------------------- states
console.log("\n1. page classification, from the ids Workday actually stamps:");
{
  check("a sign-out control means signed in",
    classifyWorkdayPage(sig({ automationIds: ["utilityButtonSignOut"] })) === "SIGNED_IN");
  check("the candidate application menu means signed in",
    classifyWorkdayPage(sig({ automationIds: ["useMyLastApplication", "applyManually"] })) === "SIGNED_IN");
  check("sign-in form",
    classifyWorkdayPage(sig({ automationIds: ["email", "password", "signInSubmitButton"], inputTypes: ["email", "password"] })) === "SIGN_IN_FORM");
  check("create-account form, by the verify-password control",
    classifyWorkdayPage(sig({ automationIds: ["email", "password", "verifyPassword"], inputTypes: ["email", "password", "password"] })) === "CREATE_ACCOUNT_FORM");
  check("create-account form, by its submit button",
    classifyWorkdayPage(sig({ automationIds: ["email", "password", "createAccountSubmitButton"], inputTypes: ["password"] })) === "CREATE_ACCOUNT_FORM");
  check("the public posting",
    classifyWorkdayPage(sig({ automationIds: ["jobPostingHeader", "applyButton"] })) === "JOB_POSTING");
  // The real Northern Trust Candidate Home, from the first live sign-in.
  // It carries no sign-out control: that lives in an account-tasks menu.
  const candidateHome = ["utilityButtonBar", "utilityButtonBarSettingsMenu", "utilityButtonAccountTasksMenu",
                         "navigationItem-Candidate Home", "candidateHomePage", "candidate-home-app",
                         "welcomeMsgHeader", "applicationsSectionHeading"];
  check("the live Candidate Home is SIGNED_IN",
    classifyWorkdayPage(sig({ automationIds: candidateHome })) === "SIGNED_IN",
    classifyWorkdayPage(sig({ automationIds: candidateHome })));
  check("and it is not mistaken for signed out",
    classifyWorkdayPage(sig({ automationIds: candidateHome })) !== "SIGNED_OUT");
  check("a candidate-home id alongside a password field is NOT signed in",
    classifyWorkdayPage(sig({ automationIds: [...candidateHome, "password", "signInSubmitButton"],
      inputTypes: ["password"] })) !== "SIGNED_IN");

  check("the careers landing with a Sign In utility button is affirmatively signed OUT",
    classifyWorkdayPage(sig({ automationIds: ["utilityButtonSignIn", "jobSearchPage", "jobResults"] })) === "SIGNED_OUT");
  check("the same page with a Sign Out button is signed IN",
    classifyWorkdayPage(sig({ automationIds: ["utilityButtonSignOut", "jobSearchPage"] })) === "SIGNED_IN");
  check("a page carrying both is read as signed in, never signed out",
    classifyWorkdayPage(sig({ automationIds: ["utilityButtonSignIn", "utilityButtonSignOut"] })) === "SIGNED_IN");
  check("a job-search page with neither button says nothing about our standing",
    classifyWorkdayPage(sig({ automationIds: ["jobSearchPage", "jobResults"] })) === "JOB_POSTING");
  check("the loading shell alone is UNKNOWN, not a state",
    classifyWorkdayPage(sig({ automationIds: ["loading"] })) === "UNKNOWN");
  check("an unrecognised page is UNKNOWN, never a guess",
    classifyWorkdayPage(sig({ text: "something entirely different" })) === "UNKNOWN");
}

console.log("\n1b. the switch links must not be read as the form they point at:");
{
  // Exactly what the live Northern Trust modal renders. The sign-in form
  // carries createAccountLink; treating that as creation evidence made
  // this classify as CREATE_ACCOUNT_FORM, which with no stored
  // credential would have driven an account-creation attempt.
  const signInModal = ["formfield-email", "email", "formfield-password", "password",
                       "signInSubmitButton", "createAccountLink", "forgotPasswordLink"];
  check("the live sign-in modal is SIGN_IN_FORM",
    classifyWorkdayPage(sig({ automationIds: signInModal, inputTypes: ["text", "text", "password", "text"] })) === "SIGN_IN_FORM",
    classifyWorkdayPage(sig({ automationIds: signInModal, inputTypes: ["password"] })));
  // And the real creation form, which carries signInLink.
  const createForm = ["formfield-email", "email", "formfield-password", "password",
                      "formfield-verifypassword", "verifyPassword", "createAccountCheckbox",
                      "createAccountSubmitButton", "signInLink", "forgotPasswordLink"];
  check("the live create-account form is CREATE_ACCOUNT_FORM",
    classifyWorkdayPage(sig({ automationIds: createForm, inputTypes: ["text", "text", "password", "password", "checkbox", "text"] })) === "CREATE_ACCOUNT_FORM");
  check("a lone createAccountLink is not a creation form",
    classifyWorkdayPage(sig({ automationIds: ["createAccountLink"] })) !== "CREATE_ACCOUNT_FORM");
}

console.log("\n2. a password box alone is not enough to act on:");
{
  check("password with no naming button and no text is UNKNOWN",
    classifyWorkdayPage(sig({ inputTypes: ["password"] })) === "UNKNOWN");
  check("password + unambiguous 'create account' text",
    classifyWorkdayPage(sig({ inputTypes: ["password"], text: "create account" })) === "CREATE_ACCOUNT_FORM");
  check("password + unambiguous 'sign in' text",
    classifyWorkdayPage(sig({ inputTypes: ["password"], text: "sign in to your account" })) === "SIGN_IN_FORM");
  check("password + BOTH phrases is UNKNOWN, because it is ambiguous",
    classifyWorkdayPage(sig({ inputTypes: ["password"], text: "sign in or create account" })) === "UNKNOWN");
}

console.log("\n3. blocking states win over anything actionable:");
{
  // Each of these carries a full, usable sign-in form underneath.
  const withForm = { automationIds: ["email", "password", "signInSubmitButton"], inputTypes: ["password"] };
  check("CAPTCHA beats the sign-in form beneath it",
    classifyWorkdayPage(sig({ ...withForm, captcha: true })) === "CAPTCHA");
  check("MFA beats it",
    classifyWorkdayPage(sig({ ...withForm, text: "enter the one-time passcode from your authenticator app" })) === "MFA");
  check("a security question beats it",
    classifyWorkdayPage(sig({ ...withForm, text: "please answer your security question" })) === "SECURITY_QUESTION");
  check("email verification beats it",
    classifyWorkdayPage(sig({ ...withForm, text: "a verification code has been sent to your email" })) === "EMAIL_VERIFICATION");
  check("SSO beats it",
    classifyWorkdayPage(sig({ ...withForm, sso: true })) === "SSO_PROMPT");
  check("'account already exists' beats the creation form that produced it",
    classifyWorkdayPage(sig({ automationIds: ["email", "password", "verifyPassword"], inputTypes: ["password"],
      text: "an account already exists with this email address" })) === "ACCOUNT_EXISTS");
  check("a rejected credential beats the sign-in form that produced it",
    classifyWorkdayPage(sig({ ...withForm, text: "the email or password you entered is incorrect" })) === "INVALID_CREDENTIALS");
  // The failure this ordering exists to prevent.
  check("no blocking page is ever classified as actionable",
    !["CAPTCHA", "MFA", "SECURITY_QUESTION", "EMAIL_VERIFICATION", "ACCOUNT_EXISTS",
      "INVALID_CREDENTIALS", "SSO_PROMPT", "UNKNOWN"].some((s) => isActionable(s as WorkdayPageState)));
}

console.log("\n4. 'verify password' is not email verification:");
{
  // The exact false positive that would send every account creation to
  // handoff: the ordinary creation form contains the word "verify".
  const s = classifyWorkdayPage(sig({ automationIds: ["email", "password", "verifyPassword"],
    inputTypes: ["password"], text: "create account email address password verify password" }));
  check("the ordinary creation form still classifies as creation", s === "CREATE_ACCOUNT_FORM", s);
  // A scoring badge is not a challenge.
  check("an invisible CAPTCHA badge alone does not stop anything",
    classifyWorkdayPage(sig({ automationIds: ["email", "password", "signInSubmitButton"],
      inputTypes: ["password"], captchaBadgeOnly: true })) === "SIGN_IN_FORM");
}

// -------------------------------------------------------------- decisions
console.log("\n5. valid session -> reuse:");
check("a signed-in page proceeds", planNext("SIGNED_IN", ctx()).action === "PROCEED");
check("and needs no credential to do so", planNext("SIGNED_IN", ctx({ hasCredential: false })).action === "PROCEED");

console.log("\n5b. signed out at the careers site:");
{
  check("with a credential it signs in",
    planNext("SIGNED_OUT", ctx({ hasCredential: true })).action === "SIGN_IN");
  check("with none and creation on it creates",
    planNext("SIGNED_OUT", ctx({ creationEnabled: true })).action === "CREATE_ACCOUNT");
  check("with none and creation off it hands off",
    planNext("SIGNED_OUT", ctx()).action === "HANDOFF");
  check("and a credential already tried this run hands off",
    planNext("SIGNED_OUT", ctx({ hasCredential: true, signInAttempted: true })).action === "HANDOFF");
  // EXPIRED is a claim about history and needs a history.
  check("signed out with no prior authentication is UNKNOWN, not EXPIRED",
    sessionStateFrom("SIGNED_OUT", false) === "UNKNOWN");
  check("signed out AFTER a recorded authentication is EXPIRED",
    sessionStateFrom("SIGNED_OUT", true) === "EXPIRED");
  check("the same distinction holds at a sign-in form",
    sessionStateFrom("SIGN_IN_FORM", false) === "UNKNOWN" && sessionStateFrom("SIGN_IN_FORM", true) === "EXPIRED");
  check("a CAPTCHA is UNKNOWN even after a prior authentication",
    sessionStateFrom("CAPTCHA", true) === "UNKNOWN");
}

console.log("\n6. expired session + stored credential -> automatic login:");
{
  const d = planNext("SIGN_IN_FORM", ctx({ hasCredential: true }));
  check("it signs in", d.action === "SIGN_IN", JSON.stringify(d));
  check("with no handoff reason", d.reason === null);
}

console.log("\n7. no account, creation enabled -> creation:");
{
  check("a creation form with nothing stored creates",
    planNext("CREATE_ACCOUNT_FORM", ctx({ creationEnabled: true })).action === "CREATE_ACCOUNT");
  check("but not when creation is switched off",
    planNext("CREATE_ACCOUNT_FORM", ctx({ creationEnabled: false })).action === "HANDOFF");
  check("and the reason says exactly that",
    /not enabled/.test(planNext("CREATE_ACCOUNT_FORM", ctx()).reason ?? ""));
}

console.log("\n8. a held credential is preferred over making a second account:");
{
  const d = planNext("CREATE_ACCOUNT_FORM", ctx({ hasCredential: true, creationEnabled: true }));
  check("the creation tab with a stored credential signs in instead", d.action === "SIGN_IN", JSON.stringify(d));
  check("which is what stops a duplicate account being made", d.action !== "CREATE_ACCOUNT");
}

console.log("\n9. an account we cannot open is a handoff:");
{
  check("ACCOUNT_EXISTS hands off", planNext("ACCOUNT_EXISTS", ctx({ hasCredential: true, creationEnabled: true })).action === "HANDOFF");
  check("even with creation enabled and a credential held",
    planNext("ACCOUNT_EXISTS", ctx({ hasCredential: true, creationEnabled: true })).reason !== null);
  check("a sign-in form with no credential hands off rather than guessing",
    planNext("SIGN_IN_FORM", ctx({ hasCredential: false })).action === "HANDOFF");
}

console.log("\n10. a refused credential is never retried:");
{
  check("INVALID_CREDENTIALS hands off", planNext("INVALID_CREDENTIALS", ctx({ hasCredential: true })).action === "HANDOFF");
  check("and a second sign-in in the same run is refused",
    planNext("SIGN_IN_FORM", ctx({ hasCredential: true, signInAttempted: true })).action === "HANDOFF");
  check("as is a second creation attempt",
    planNext("CREATE_ACCOUNT_FORM", ctx({ creationEnabled: true, createAttempted: true })).action === "HANDOFF");
}

console.log("\n11. every human-presence state hands off, under every context:");
{
  const blocking: WorkdayPageState[] = ["CAPTCHA", "MFA", "SECURITY_QUESTION", "EMAIL_VERIFICATION", "SSO_PROMPT", "UNKNOWN"];
  const contexts = [ctx(), ctx({ hasCredential: true }), ctx({ creationEnabled: true }),
                    ctx({ hasCredential: true, creationEnabled: true })];
  let bad = 0;
  for (const s of blocking) for (const c of contexts) {
    const d = planNext(s, c);
    if (d.action !== "HANDOFF" || !d.reason) { bad++; console.log(`      ${s} under ${JSON.stringify(c)} -> ${d.action}`); }
  }
  check(`all ${blocking.length * contexts.length} combinations hand off with a reason`, bad === 0, `${bad} did not`);
  check("email verification specifically is a handoff for now",
    /not enabled/.test(planNext("EMAIL_VERIFICATION", ctx()).reason ?? ""));
}

console.log("\n12. authentication never implies approval:");
{
  // PROCEED means a form is reachable. There is no action in the whole
  // vocabulary that submits, approves, or advances an application.
  const actions = new Set(["SIGNED_IN", "SIGNED_OUT", "SIGN_IN_FORM", "CREATE_ACCOUNT_FORM", "JOB_POSTING", "CAPTCHA",
    "MFA", "SECURITY_QUESTION", "EMAIL_VERIFICATION", "ACCOUNT_EXISTS", "INVALID_CREDENTIALS", "SSO_PROMPT", "UNKNOWN"]
    .flatMap((s) => [ctx(), ctx({ hasCredential: true, creationEnabled: true })]
      .map((c) => planNext(s as WorkdayPageState, c).action)));
  check("the only outcomes are proceed, sign in, create, hand off",
    [...actions].every((a) => ["PROCEED", "SIGN_IN", "CREATE_ACCOUNT", "HANDOFF"].includes(a)), JSON.stringify([...actions]));
  check("nothing in the vocabulary submits or approves",
    ![...actions].some((a) => /SUBMIT|APPROVE|SEND/i.test(a)));
}

console.log("\n13. state transitions record only what was proven:");
{
  check("signed in -> session VALID", sessionStateFrom("SIGNED_IN") === "VALID");
  check("a credential form after a known session -> EXPIRED", sessionStateFrom("SIGN_IN_FORM", true) === "EXPIRED");
  check("a CAPTCHA proves nothing about the session", sessionStateFrom("CAPTCHA", true) === "UNKNOWN");
  check("an unknown page proves nothing either", sessionStateFrom("UNKNOWN", true) === "UNKNOWN");
  check("signed in -> account EXISTS", accountStateFrom("SIGNED_IN", "UNKNOWN") === "EXISTS");
  check("'already exists' -> account EXISTS", accountStateFrom("ACCOUNT_EXISTS", "NONE") === "EXISTS");
  check("being offered a creation form does NOT prove no account exists",
    accountStateFrom("CREATE_ACCOUNT_FORM", "EXISTS") === "EXISTS");
}

// -------------------------------------------------------------- isolation
console.log("\n14. tenant isolation:");
{
  const a = tenantFromToken("ntrs.wd1.myworkdayjobs.com/northerntrust");
  const b = tenantFromToken("huron.wd1.myworkdayjobs.com/huroncareers");
  check("two employers give two keys", tenantKey(a) !== tenantKey(b));
  check("the key is the cookie origin", tenantKey(a) === "ntrs.wd1.myworkdayjobs.com");
  check("a tenant B url does not belong to tenant A",
    !urlBelongsToTenant("https://huron.wd1.myworkdayjobs.com/huroncareers", a));
  check("and tenant A's own url does", urlBelongsToTenant("https://ntrs.wd1.myworkdayjobs.com/northerntrust", a));
  check("a lookalike host does not match",
    !urlBelongsToTenant("https://ntrs.wd1.myworkdayjobs.com.evil.test/x", a));
  check("a different Workday pod is a different tenant",
    tenantKey(tenantFromToken("ntrs.wd5.myworkdayjobs.com/northerntrust")) !== tenantKey(a));
  check("keychain accounts differ per tenant",
    keychainRef(tenantKey(a)).account !== keychainRef(tenantKey(b)).account);
  // Two sites of ONE tenant share an account, which is correct.
  const a2 = tenantFromToken("ntrs.wd1.myworkdayjobs.com/OtherSite");
  check("two sites of one tenant share one key", tenantKey(a2) === tenantKey(a));
  check("but the site is still recorded", a2.site === "OtherSite" && a.site === "northerntrust");

  check("a url parses to the same identity as its token",
    tenantFromUrl("https://ntrs.wd1.myworkdayjobs.com/en-US/northerntrust/job/x")?.host === a.host);
  check("a locale segment is not mistaken for the site",
    tenantFromUrl("https://ntrs.wd1.myworkdayjobs.com/en-US/northerntrust")?.site === "northerntrust");
  check("a non-Workday url yields nothing", tenantFromUrl("https://example.com/careers") === null);
  for (const bad of ["notworkday.com/x", "ntrs.myworkdayjobs.com/x", "ntrs.wd1.example.com/x"]) {
    let threw = false; try { tenantFromToken(bad); } catch { threw = true; }
    check(`"${bad}" is refused as a token`, threw);
  }
  check("the candidate home is on the tenant's own origin",
    candidateHomeUrl(a) === "https://ntrs.wd1.myworkdayjobs.com/northerntrust");
}

// ---------------------------------------------------------------- secrets
console.log("\n15. generated passwords:");
{
  const ps = Array.from({ length: 200 }, () => generatePassword());
  check("all are the requested length", ps.every((p) => p.length === 28));
  check("all are unique", new Set(ps).size === ps.length);
  check("every one has upper, lower, digit and symbol",
    ps.every((p) => /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[!#$%*+\-=?@^_]/.test(p)));
  check("none contains a quote, backslash or space",
    ps.every((p) => !/['"\\\s]/.test(p)));
  // The property that matters: nothing personal is an input.
  // Words of four characters or more. Shorter ones appear in random
  // 28-character strings by chance, which would test the shuffle rather
  // than the property that matters: nothing personal is an INPUT.
  const personal = ["pleban", "typleban", "plebantyler", "gmail", "1994", "cleveland", "44113", "workday"];
  check("no generated password contains anything personal",
    ps.every((p) => !personal.some((w) => p.toLowerCase().includes(w))));
  let threw = false; try { generatePassword(8); } catch { threw = true; }
  check("a too-short password is refused", threw);
}

console.log("\n16. the keychain, for real, under a test service name:");
{
  const ref = { service: KEYCHAIN_TEST_SERVICE, account: "selftest.wd1.myworkdayjobs.com" };
  const other = { service: KEYCHAIN_TEST_SERVICE, account: "othertenant.wd1.myworkdayjobs.com" };
  await deletePassword(ref); await deletePassword(other);
  check("the test service is not the real one", String(KEYCHAIN_TEST_SERVICE) !== String(KEYCHAIN_SERVICE));
  check("nothing stored yet", (await hasPassword(ref)) === false);
  check("reading a missing credential returns null, it does not throw", (await readPassword(ref)) === null);

  const pw = generatePassword();
  await storePassword(ref, pw);
  check("stored", (await hasPassword(ref)) === true);
  check("and reads back exactly", (await readPassword(ref)) === pw);

  const pw2 = generatePassword();
  await storePassword(ref, pw2);
  check("storing again replaces rather than duplicating", (await readPassword(ref)) === pw2);

  // The isolation property, at the storage layer.
  const otherPw = generatePassword();
  await storePassword(other, otherPw);
  check("tenant A's credential is not tenant B's", (await readPassword(ref)) !== (await readPassword(other)));
  check("tenant B reads its own", (await readPassword(other)) === otherPw);
  check("and A still reads its own", (await readPassword(ref)) === pw2);

  check("deleting works", (await deletePassword(ref)) === true);
  check("and it is then absent", (await hasPassword(ref)) === false);
  check("tenant B is unaffected by A's deletion", (await hasPassword(other)) === true);
  await deletePassword(other);
  check("cleaned up", (await hasPassword(other)) === false);
}

console.log("\n17. redaction, as the last line of defence:");
{
  const pw = generatePassword();
  const line = `signing in to ntrs with ${pw} now`;
  check("a secret is removed", !redact(line, [pw]).includes(pw));
  check("and marked", redact(line, [pw]).includes("[redacted]"));
  check("null and short values are ignored safely",
    redact("abc", [null, undefined, "x"]) === "abc");
  check("the rest of the line survives", redact(line, [pw]).startsWith("signing in to ntrs with "));
}

// ---------------------------------------------------- unattended creation
console.log("\n8. creation and verification through the caller's dependencies (2026-09-07 authorisation):");
{
  const { authenticateTenant } = await import("../lib/workday/authenticate.ts");
  const tenant = tenantFromToken("uchicago.wd5.myworkdayjobs.com/External");
  const url = "https://uchicago.wd5.myworkdayjobs.com/External";
  // A script of states the tenant will show, in order; hooks record what was called.
  const script = (states: WorkdayPageState[]) => {
    const seen: string[] = []; let i = 0;
    const deps: any = {
      email: "x@example.com",
      observe: async () => ({ state: states[Math.min(i++, states.length - 1)], url }),
      openSignIn: async () => { seen.push("openSignIn"); },
      signIn: async () => { seen.push("signIn"); },
      readCredential: async () => null,
    };
    return { deps, seen };
  };
  {
    const t = script(["SIGNED_OUT", "SIGN_IN_FORM", "SIGNED_IN"]);
    const r = await authenticateTenant(tenant, t.deps, { creationEnabled: true });
    check("creation enabled but no createAccount dependency: still ACCOUNT_REQUIRED, nothing created",
      r.outcome === "ACCOUNT_REQUIRED" && !t.seen.includes("createAccount"), `${r.outcome} ${t.seen.join(",")}`);
  }
  {
    const t = script(["SIGNED_OUT", "SIGN_IN_FORM", "SIGNED_IN"]);
    t.deps.createAccount = async () => { t.seen.push("createAccount"); };
    const r = await authenticateTenant(tenant, t.deps, { creationEnabled: true });
    check("with the dependency: sign-in opened, account created once, then authenticated",
      r.outcome === "AUTHENTICATED" && t.seen.join(",") === "openSignIn,createAccount", `${r.outcome} ${t.seen.join(",")}`);
  }
  {
    const t = script(["CREATE_ACCOUNT_FORM", "CREATE_ACCOUNT_FORM", "CREATE_ACCOUNT_FORM"]);
    t.deps.createAccount = async () => { t.seen.push("createAccount"); };
    const r = await authenticateTenant(tenant, t.deps, { creationEnabled: true });
    check("creation that leaves the form on screen is tried once, then handed off",
      r.outcome === "HANDOFF" && t.seen.filter((x) => x === "createAccount").length === 1, `${r.outcome} ${t.seen.join(",")}`);
  }
  {
    const t = script(["EMAIL_VERIFICATION", "SIGNED_IN"]);
    t.deps.verifyEmail = async () => { t.seen.push("verifyEmail"); return "ATTEMPTED"; };
    const r = await authenticateTenant(tenant, t.deps, { creationEnabled: true });
    check("email verification completed from the inbox, then authenticated",
      r.outcome === "AUTHENTICATED" && t.seen.join(",") === "verifyEmail", `${r.outcome} ${t.seen.join(",")}`);
  }
  {
    const t = script(["EMAIL_VERIFICATION", "EMAIL_VERIFICATION", "EMAIL_VERIFICATION"]);
    t.deps.verifyEmail = async () => { t.seen.push("verifyEmail"); return "ATTEMPTED"; };
    const r = await authenticateTenant(tenant, t.deps, { creationEnabled: true });
    check("verification tried once; a tenant still asking is a handoff",
      r.outcome === "HANDOFF" && t.seen.length === 1, `${r.outcome} ${t.seen.join(",")}`);
  }
  {
    const t = script(["EMAIL_VERIFICATION"]);
    const r = await authenticateTenant(tenant, t.deps, { creationEnabled: true });
    check("without the inbox dependency, verification is a handoff as before", r.outcome === "HANDOFF", r.outcome);
  }
  {
    const t = script(["CAPTCHA"]);
    t.deps.createAccount = async () => { t.seen.push("createAccount"); };
    const r = await authenticateTenant(tenant, t.deps, { creationEnabled: true });
    check("a CAPTCHA is still a handoff even with creation enabled", r.outcome === "HANDOFF" && t.seen.length === 0, r.outcome);
  }
  {
    // A credential written by a creation whose outcome was never seen is
    // refused: the account was probably never made, so create once.
    const t = script(["SIGN_IN_FORM", "INVALID_CREDENTIALS", "SIGNED_IN"]);
    t.deps.readCredential = async () => "stored-but-never-used";
    t.deps.createAccount = async () => { t.seen.push("createAccount"); };
    const r = await authenticateTenant(tenant, t.deps, { creationEnabled: true, everAuthenticated: false });
    check("an unproven credential refused once leads to one creation attempt",
      r.outcome === "AUTHENTICATED" && t.seen.join(",") === "signIn,createAccount", `${r.outcome} ${t.seen.join(",")}`);
  }
  {
    const t = script(["SIGN_IN_FORM", "INVALID_CREDENTIALS", "SIGNED_IN"]);
    t.deps.readCredential = async () => "stored-and-proven";
    t.deps.createAccount = async () => { t.seen.push("createAccount"); };
    const r = await authenticateTenant(tenant, t.deps, { creationEnabled: true, everAuthenticated: true });
    check("a credential that once worked and is now refused is a handoff, never a second account",
      r.outcome === "HANDOFF" && !t.seen.includes("createAccount"), `${r.outcome} ${t.seen.join(",")}`);
  }
  {
    // UChicago answers a creation with its sign-in form. The new
    // credential is typed once; a refusal of that still stops.
    const t = script(["SIGN_IN_FORM", "INVALID_CREDENTIALS", "SIGN_IN_FORM", "SIGNED_IN"]);
    t.deps.readCredential = async () => "stored-but-never-used";
    t.deps.createAccount = async () => { t.seen.push("createAccount"); };
    const r = await authenticateTenant(tenant, t.deps, { creationEnabled: true, everAuthenticated: false, maxSteps: 8 });
    check("a creation answered by the sign-in form gets one sign-in with the new credential",
      r.outcome === "AUTHENTICATED" && t.seen.join(",") === "signIn,createAccount,signIn", `${r.outcome} ${t.seen.join(",")}`);
    const u = script(["SIGN_IN_FORM", "INVALID_CREDENTIALS", "SIGN_IN_FORM", "INVALID_CREDENTIALS", "SIGN_IN_FORM"]);
    u.deps.readCredential = async () => "stored-but-never-used";
    u.deps.createAccount = async () => { u.seen.push("createAccount"); };
    const r2 = await authenticateTenant(tenant, u.deps, { creationEnabled: true, everAuthenticated: false, maxSteps: 8 });
    check("and a second refusal after creation is a handoff, never a second creation",
      r2.outcome === "HANDOFF" && u.seen.filter((x) => x === "createAccount").length === 1 && u.seen.filter((x) => x === "signIn").length === 2, `${r2.outcome} ${u.seen.join(",")}`);
  }
  {
    const t = script(["SIGN_IN_FORM", "INVALID_CREDENTIALS", "ACCOUNT_EXISTS"]);
    t.deps.readCredential = async () => "stored-but-never-used";
    t.deps.createAccount = async () => { t.seen.push("createAccount"); };
    const r = await authenticateTenant(tenant, t.deps, { creationEnabled: true, everAuthenticated: false });
    check("the creation attempt meeting an existing account stops", r.outcome === "HANDOFF" && /already exists/.test(r.reason ?? ""), `${r.outcome} ${r.reason}`);
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("classification stops before it acts; tenants stay separate; secrets stay in the keychain");
