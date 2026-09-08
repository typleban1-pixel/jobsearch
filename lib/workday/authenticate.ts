/**
 * Getting a Workday application to a form it may actually fill.
 *
 * The pieces existed separately: tenant identity, page classification,
 * the decision table, the keychain, the state store. This is the loop
 * that runs them in order against one application, and it is the only
 * place that decides when to stop.
 *
 * WHAT THIS IS NOT
 *
 * It is not an approval step and it cannot become one. The strongest
 * thing it returns is AUTHENTICATED, which means a form is reachable. It
 * writes nothing to `applications`: not status, not human_approved, not
 * authorization_mode, not approved hashes. A Workday application that
 * authenticates is exactly as unapproved as it was before, and the
 * submit path is unchanged and still refuses Workday outright because
 * there is no ats_policy row for it.
 *
 * WHY THE DEPENDENCIES ARE INJECTED
 *
 * Every interesting case here is a failure: an expired session, a
 * refused credential, a CAPTCHA, a tenant redirect. Reproducing those
 * against live employers is impossible and driving them through a real
 * browser is slow, so the loop takes its browser and keychain as
 * functions and the whole state machine is tested without either.
 */
import type { WorkdayTenant } from "./tenant.ts";
import { urlBelongsToTenant } from "./tenant.ts";
import type { WorkdayPageState } from "./pageState.ts";
import { HANDOFF_REASON } from "./pageState.ts";
import { planNext, sessionStateFrom, accountStateFrom,
         type AccountState, type SessionState } from "./authPlan.ts";

/** How an authentication attempt ended. */
export const AUTH_OUTCOMES = [
  "AUTHENTICATED",        // a session exists; the form is reachable
  "ACCOUNT_REQUIRED",     // no session, no credential, no account
  "HANDOFF",              // a person is required; see reason
] as const;
export type AuthOutcome = (typeof AUTH_OUTCOMES)[number];

export interface AuthResult {
  outcome: AuthOutcome;
  /** Null only when AUTHENTICATED. */
  reason: string | null;
  /** The page state the attempt ended on. */
  finalState: WorkdayPageState;
  sessionState: SessionState;
  accountState: AccountState;
  /** Every state seen, in order. The audit trail for a stop. */
  path: WorkdayPageState[];
  /** True if a credential was typed. Never says WHICH. */
  signInAttempted: boolean;
}

export interface AuthDeps {
  /** Navigate to the tenant and classify what is there. */
  observe: () => Promise<{ state: WorkdayPageState; url: string }>;
  /** Reveal the credential form from the careers page. */
  openSignIn: () => Promise<void>;
  /** Type the credential and submit. Receives the secret; returns nothing. */
  signIn: (email: string, password: string) => Promise<void>;
  /** The tenant's stored password, or null. */
  readCredential: () => Promise<string | null>;
  /** The verified job-search address. */
  email: string;
  /**
   * Create the account, under the person's recorded authorisation.
   *
   * Absent (the default) the loop never creates anything and reports
   * ACCOUNT_REQUIRED, as before. Present, it is called at most once per
   * run, only when creationEnabled is also set, and it owns the whole
   * act: the password goes to the keychain first, the form is filled,
   * the consent control is ticked because the person said so, and the
   * button is pressed. The next pass observes the result.
   */
  createAccount?: (email: string) => Promise<void>;
  /**
   * Complete the tenant's email verification from the person's own
   * inbox. Absent, EMAIL_VERIFICATION is a handoff, as before. Present,
   * it is tried once; the next pass observes whether the tenant is
   * satisfied.
   */
  verifyEmail?: () => Promise<"ATTEMPTED" | "HANDOFF">;
}

export interface AuthOptions {
  /** Off for this implementation. Creation is a separate authorisation. */
  creationEnabled?: boolean;
  /** Bounded so a tenant that loops cannot spin. */
  maxSteps?: number;
  /** What the state row says before this attempt. */
  priorAccountState?: AccountState;
  everAuthenticated?: boolean;
}

/**
 * Runs the loop for one tenant.
 *
 * Each pass observes, decides, and acts. A pass that acts is followed by
 * another observation, because the only evidence an action worked is the
 * page afterwards. Nothing here waits on a timer.
 */
export async function authenticateTenant(
  tenant: WorkdayTenant,
  deps: AuthDeps,
  opts: AuthOptions = {},
): Promise<AuthResult> {
  const creationEnabled = opts.creationEnabled ?? false;
  const maxSteps = opts.maxSteps ?? 4;
  const path: WorkdayPageState[] = [];
  let signInAttempted = false;
  let createAttempted = false;
  let verifyAttempted = false;
  let accountState: AccountState = opts.priorAccountState ?? "UNKNOWN";

  const done = (outcome: AuthOutcome, reason: string | null, state: WorkdayPageState): AuthResult => ({
    outcome, reason, finalState: state,
    sessionState: sessionStateFrom(state, opts.everAuthenticated ?? false),
    accountState, path, signInAttempted,
  });

  for (let step = 0; step < maxSteps; step++) {
    const { state, url } = await deps.observe();
    path.push(state);
    accountState = accountStateFrom(state, accountState);

    // A redirect off this tenant's origin means whatever is on screen is
    // not this tenant's sign-in, and typing this tenant's credential
    // into it would hand a secret to a third party. Checked here as well
    // as in observe(), because this is the loop that would do the typing.
    if (!urlBelongsToTenant(url, tenant)) {
      return done("HANDOFF",
        `the page navigated to ${safeOrigin(url)}, which is not ${tenant.host}; `
        + "nothing is typed off the tenant's own origin", state);
    }

    const hasCredential = (await deps.readCredential()) !== null;

    // Email verification, when the person's inbox is available to the
    // run. One attempt: if the tenant still asks afterwards, a person
    // looks. Without the dependency the state is a handoff, as before.
    if (state === "EMAIL_VERIFICATION" && deps.verifyEmail && !verifyAttempted) {
      verifyAttempted = true;
      const r = await deps.verifyEmail();
      if (r === "ATTEMPTED") continue;
      return done("HANDOFF", HANDOFF_REASON.EMAIL_VERIFICATION, state);
    }

    const plan = planNext(state, { hasCredential, signInAttempted, createAttempted, creationEnabled,
      credentialUnproven: !(opts.everAuthenticated ?? false) });

    if (plan.action === "PROCEED") {
      if (state === "SIGNED_IN") return done("AUTHENTICATED", null, state);
      // JOB_POSTING or the careers page with no session evidence either
      // way. Not authenticated, and not something to guess about.
      return done("HANDOFF",
        "the page is readable but no authenticated session was observed", state);
    }

    if (plan.action === "HANDOFF") {
      // The one stop that is not a failure: nothing is wrong, there is
      // simply no account yet. Distinguished so the queue can show it as
      // a thing to authorise rather than a thing to fix.
      const noAccount = !hasCredential && !creationEnabled
        && (state === "SIGNED_OUT" || state === "SIGN_IN_FORM" || state === "CREATE_ACCOUNT_FORM");
      return noAccount
        ? done("ACCOUNT_REQUIRED",
            `no Workday account exists for ${tenant.host} and account creation is not enabled`, state)
        : done("HANDOFF", plan.reason ?? HANDOFF_REASON[state] ?? "unclassified stop", state);
    }

    if (plan.action === "CREATE_ACCOUNT") {
      // Unreachable while creationEnabled is false. With it, creation
      // happens only through a dependency the caller supplied on the
      // person's authorisation (see AuthDeps.createAccount); an
      // application run that holds no such dependency still cannot
      // create anything and reports what is needed.
      createAttempted = true;
      if (!deps.createAccount) {
        return done("ACCOUNT_REQUIRED",
          `account creation is required for ${tenant.host} and is not performed by the application flow`, state);
      }
      if (state === "SIGNED_OUT") {
        // The creation form sits behind the utility Sign In button too.
        await deps.openSignIn();
        // Leave createAttempted set: the next pass lands on a credential
        // form and the plan would otherwise re-decide CREATE_ACCOUNT.
        createAttempted = false;
        continue;
      }
      await deps.createAccount(deps.email);
      continue;
    }

    // SIGN_IN.
    if (state === "SIGNED_OUT") {
      // The credential form is behind the utility button.
      await deps.openSignIn();
      continue;
    }
    const password = await deps.readCredential();
    if (password === null) {
      return done("ACCOUNT_REQUIRED",
        `no stored credential for ${tenant.host}`, state);
    }
    signInAttempted = true;
    await deps.signIn(deps.email, password);
    // The next pass observes the result. A sign-in that failed lands on
    // INVALID_CREDENTIALS and the plan refuses to retry it.
  }

  const last = path[path.length - 1] ?? "UNKNOWN";
  return done("HANDOFF",
    `authentication did not settle within ${maxSteps} steps; states seen: ${path.join(" -> ")}`, last);
}

/** An origin, for a message, without carrying a full URL's query string. */
function safeOrigin(url: string): string {
  try { return new URL(url).host; } catch { return "an unparseable url"; }
}
