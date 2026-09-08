/**
 * What to do next, given where we are and what we hold.
 *
 * The browser work is unavoidably messy; the DECISION is not, so it
 * lives here as a pure function over a page state and a credential fact.
 * Every safety property the user asked for is asserted against this
 * table rather than against a live tenant.
 *
 * THE ONE THING THIS IS NOT
 *
 * Authentication is not approval. Nothing in this file, and nothing that
 * consumes it, may move an application toward submission. Signing in
 * successfully means a form became reachable; it says nothing about
 * whether the application should be sent, and the existing review and
 * submit guards are untouched by all of this.
 */
import { type WorkdayPageState, HANDOFF_REASON } from "./pageState.ts";

export const WORKDAY_ACTIONS = [
  "PROCEED",          // authenticated; the form is reachable
  "SIGN_IN",          // type the stored credential
  "CREATE_ACCOUNT",   // no account and the flow is unambiguous
  "HANDOFF",          // a person is required
] as const;
export type WorkdayAction = (typeof WORKDAY_ACTIONS)[number];

export interface AuthContext {
  /** A credential exists in the keychain for THIS tenant. */
  hasCredential: boolean;
  /** This run already tried to sign in and was refused. */
  signInAttempted: boolean;
  /** This run already tried to create an account. */
  createAttempted: boolean;
  /** Account creation is switched on. Off by default. */
  creationEnabled: boolean;
  /**
   * The stored credential has never opened a session: it was written by
   * a creation attempt whose outcome was never observed as SIGNED_IN. A
   * refusal of such a credential means the account was probably never
   * made, so one creation attempt is allowed; a real existing account
   * answers that attempt with ACCOUNT_EXISTS, which still stops.
   */
  credentialUnproven?: boolean;
}

export interface AuthDecision {
  action: WorkdayAction;
  /** Set on HANDOFF. Null otherwise. */
  reason: string | null;
  /** The state this decision was made from, for the audit trail. */
  from: WorkdayPageState;
}

/**
 * The whole decision table.
 *
 * Retries are bounded by the attempt flags rather than by a counter: a
 * credential that was just refused is not going to be accepted by typing
 * it again, and a creation that just failed is not going to succeed on a
 * second pass in the same run. One attempt each, then a person.
 */
export function planNext(state: WorkdayPageState, ctx: AuthContext): AuthDecision {
  const stop = (reason: string): AuthDecision => ({ action: "HANDOFF", reason, from: state });

  switch (state) {
    case "SIGNED_IN":
      return { action: "PROCEED", reason: null, from: state };

    case "SIGNED_OUT":
      // The careers site, with no session. Reaching a credential form
      // means clicking the utility Sign In button first, which the
      // caller does; the decision about what to do THERE is the same one
      // the sign-in form itself would produce.
      if (ctx.hasCredential && !ctx.signInAttempted) return { action: "SIGN_IN", reason: null, from: state };
      if (ctx.creationEnabled && !ctx.createAttempted) return { action: "CREATE_ACCOUNT", reason: null, from: state };
      return stop(ctx.hasCredential
        ? "the stored credential was already tried this run and the tenant still shows no session"
        : "no session and no stored credential for this tenant, and account creation is not enabled");

    case "SIGN_IN_FORM":
      if (!ctx.hasCredential) {
        // An account may or may not exist. Creating one blindly is how a
        // duplicate account gets made, and typing a guess is worse.
        return ctx.creationEnabled && !ctx.createAttempted
          ? { action: "CREATE_ACCOUNT", reason: null, from: state }
          : stop("a sign-in was requested and no credential is stored for this tenant");
      }
      if (ctx.signInAttempted) return stop("the stored credential was already tried this run and the page still asks for one");
      return { action: "SIGN_IN", reason: null, from: state };

    case "CREATE_ACCOUNT_FORM":
      if (ctx.hasCredential && !ctx.signInAttempted) {
        // We hold a credential for this tenant, so an account very
        // probably exists and this page is simply the default tab.
        // Signing in is both likelier to work and impossible to turn
        // into a duplicate account.
        return { action: "SIGN_IN", reason: null, from: state };
      }
      if (!ctx.creationEnabled) return stop("no account exists for this tenant and account creation is not enabled");
      if (ctx.createAttempted) return stop("account creation was already attempted this run and the page still asks for it");
      return { action: "CREATE_ACCOUNT", reason: null, from: state };

    case "ACCOUNT_EXISTS":
      // The address is taken and whatever we hold, if anything, did not
      // get us in. Which account it is, and whose, is not ours to guess.
      return stop(HANDOFF_REASON.ACCOUNT_EXISTS!);

    case "INVALID_CREDENTIALS":
      if (ctx.creationEnabled && ctx.credentialUnproven && !ctx.createAttempted && ctx.signInAttempted) {
        return { action: "CREATE_ACCOUNT", reason: null, from: state };
      }
      return stop(HANDOFF_REASON.INVALID_CREDENTIALS!);

    case "JOB_POSTING":
      // The public posting. Applying is what moves it into the account
      // flow, and that is the caller's step, not a decision to make here.
      return { action: "PROCEED", reason: null, from: state };

    case "CAPTCHA":
    case "MFA":
    case "SECURITY_QUESTION":
    case "EMAIL_VERIFICATION":
    case "SSO_PROMPT":
    case "UNKNOWN":
      return stop(HANDOFF_REASON[state]!);
  }
}

/** Session state as the tenant row records it. */
export type SessionState = "VALID" | "EXPIRED" | "UNKNOWN";
export type AccountState = "UNKNOWN" | "NONE" | "CREATING" | "EXISTS" | "LOCKED";

/**
 * What a page state implies about the stored session, if anything.
 *
 * EXPIRED is a claim about HISTORY: a session existed and has since
 * lapsed. Observing that we are signed out does not establish it. For a
 * tenant we have never authenticated with there was never a session to
 * expire, and writing EXPIRED would assert an event that never happened.
 *
 * So expiration requires both halves: an authentication we recorded, and
 * an observation that it no longer holds. Otherwise the session state is
 * UNKNOWN and the precise observation is kept in last_page_state, where
 * SIGNED_OUT records exactly what was seen without overstating it.
 */
export function sessionStateFrom(state: WorkdayPageState, everAuthenticated = false): SessionState {
  if (state === "SIGNED_IN") return "VALID";
  const noSession = state === "SIGNED_OUT" || state === "SIGN_IN_FORM" || state === "CREATE_ACCOUNT_FORM";
  if (noSession) return everAuthenticated ? "EXPIRED" : "UNKNOWN";
  // A CAPTCHA or an unrecognised page proves nothing either way.
  return "UNKNOWN";
}

/** What a page state implies about whether an account exists. */
export function accountStateFrom(state: WorkdayPageState, prior: AccountState): AccountState {
  if (state === "SIGNED_IN") return "EXISTS";
  if (state === "ACCOUNT_EXISTS") return "EXISTS";
  if (state === "SIGN_IN_FORM") return prior === "UNKNOWN" ? "UNKNOWN" : prior;
  // A create-account form being offered is not proof no account exists;
  // Workday shows it as a tab beside sign-in.
  return prior;
}
