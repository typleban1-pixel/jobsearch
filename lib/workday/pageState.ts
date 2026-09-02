/**
 * What a Workday page IS, decided from the DOM rather than from timing.
 *
 * Every branch in the authentication flow rests on this. Getting it
 * wrong in the permissive direction means typing a credential into the
 * wrong form or calling a CAPTCHA an ordinary sign-in, so the rule is
 * that anything not positively recognised is UNKNOWN, and UNKNOWN is a
 * handoff.
 *
 * WHY data-automation-id
 *
 * Workday renders its candidate pages from one shared component set and
 * stamps data-automation-id on the controls that matter. Those ids are
 * the same across every tenant: ntrs, huron and bakerhughes all render
 * the same "createAccountSubmitButton". They are stable, machine-meant
 * and unlocalised, which text is not: the same page says "Sign In",
 * "Iniciar sesion" or "Anmelden" depending on the tenant's locale.
 *
 * Text is therefore a fallback signal and never the only evidence for a
 * state that leads to typing something.
 *
 * PRECEDENCE
 *
 * Blocking states are decided before useful ones. A page with both a
 * password field and a CAPTCHA is a CAPTCHA: recognising the part we
 * could act on and ignoring the part we cannot is precisely how an
 * automation talks itself into a wrong action.
 */

/**
 * What was found on the page. Extracted by the browser layer, classified
 * here, so classification is pure and testable without Playwright.
 */
export interface PageSignals {
  /** Every data-automation-id present, lowercased. */
  automationIds: string[];
  /** Visible body text, lowercased and whitespace-normalised. */
  text: string;
  /** The page URL. */
  url: string;
  /** Input types present, e.g. "password", "email". */
  inputTypes: string[];
  /** True when a CAPTCHA widget is mounted (not merely a scoring badge). */
  captcha: boolean;
  /** An invisible scoring badge only. Recorded, never a stop by itself. */
  captchaBadgeOnly: boolean;
  /** A third-party identity provider prompt. */
  sso: boolean;
}

export const WORKDAY_PAGE_STATES = [
  "SIGNED_IN",              // an authenticated candidate session exists
  "SIGNED_OUT",             // the careers site, affirmatively not signed in
  "SIGN_IN_FORM",           // email + password, account presumed to exist
  "CREATE_ACCOUNT_FORM",    // email + password + verify, no account yet
  "ACCOUNT_EXISTS",         // creation refused: the address is taken
  "INVALID_CREDENTIALS",    // sign-in refused
  "EMAIL_VERIFICATION",     // a code or link sent to the address
  "MFA",                    // a second factor beyond the password
  "SECURITY_QUESTION",      // an answer we were never told
  "CAPTCHA",                // a human-presence challenge
  "SSO_PROMPT",             // an external identity provider
  "JOB_POSTING",            // the public posting, not yet an account flow
  "UNKNOWN",                // recognised as nothing; always a handoff
] as const;
export type WorkdayPageState = (typeof WORKDAY_PAGE_STATES)[number];

const has = (ids: string[], ...want: string[]) => want.some((w) => ids.includes(w));
const says = (text: string, re: RegExp) => re.test(text);

/**
 * Phrases that identify a state on their own.
 *
 * Deliberately narrow. "verify" appears in "verify password" on the
 * ordinary create-account form, so an email-verification pattern that
 * matched it would send every account creation to handoff.
 */
const TEXT = {
  accountExists: /account already exists|already have an account with this email|email address is already in use|an account with this email/,
  invalidCreds: /(incorrect|invalid|wrong)\s+(email|password|username|credentials)|email or password you entered|could not sign you in|sign[- ]?in (?:attempt )?failed/,
  emailVerify: /(verification|confirmation)\s+(code|link|email)\s+(?:has been |was )?sent|check your (?:email|inbox) (?:for|to)|we (?:have |'ve )?(?:sent|emailed) you a (?:code|link)|verify your email/,
  mfa: /two[- ]factor|multi[- ]factor|authenticator app|one[- ]time passcode|security code (?:sent )?to your (?:phone|device)|enter the code from/,
  securityQuestion: /security question|challenge question|what was the name of|your first pet|mother's maiden/,
} as const;

/**
 * Classifies one page.
 *
 * Order is the safety property. Human-presence and refusal states are
 * tested before any state that would lead this system to type into a
 * field, so a page that is several things at once resolves to the one
 * that stops rather than the one that proceeds.
 */
export function classifyWorkdayPage(s: PageSignals): WorkdayPageState {
  const ids = s.automationIds.map((i) => i.toLowerCase());
  const text = s.text.toLowerCase();

  // ---- 1. human presence, before anything actionable ----------------
  if (s.captcha) return "CAPTCHA";
  if (says(text, TEXT.mfa)) return "MFA";
  if (says(text, TEXT.securityQuestion)) return "SECURITY_QUESTION";

  // ---- 2. refusals, before the form that produced them ---------------
  //
  // Both render the originating form again underneath the error. Reading
  // the form first would retry the same credential forever.
  if (says(text, TEXT.accountExists)) return "ACCOUNT_EXISTS";
  if (says(text, TEXT.invalidCreds)) return "INVALID_CREDENTIALS";
  if (says(text, TEXT.emailVerify)) return "EMAIL_VERIFICATION";

  // ---- 3. an external identity provider ------------------------------
  if (s.sso) return "SSO_PROMPT";

  // ---- 4. already authenticated --------------------------------------
  //
  // A sign-out control is the only affirmative proof of a session. An
  // "Apply" button is not: the public posting has one too.
  if (has(ids, "utilitybuttonsignout", "signoutlink", "utilitynavsignout")) return "SIGNED_IN";
  if (has(ids, "usemylastapplication", "applymanually", "useresumeorcv")
      && !s.inputTypes.includes("password")) return "SIGNED_IN";

  // ---- 4b. affirmatively signed OUT -----------------------------------
  //
  // The careers landing page renders a utility bar carrying exactly one
  // of these two buttons. utilityButtonSignIn is therefore positive
  // evidence of no session, which is a different and far more useful
  // fact than "we could not tell". A first survey of the nineteen live
  // tenants classified every one of them UNKNOWN for want of this.
  //
  // Checked after sign-out so a page somehow carrying both is read as
  // signed in, never as signed out.
  if (has(ids, "utilitybuttonsignin", "signinlink_utility")
      && !s.inputTypes.includes("password")) return "SIGNED_OUT";

  // ---- 5. the two credential forms -----------------------------------
  //
  // Distinguished by the confirm-password control, which only the
  // creation form has. Without that, the two are otherwise identical and
  // the wrong choice types a new password into a sign-in box.
  const password = s.inputTypes.includes("password") || has(ids, "password");
  const verify = has(ids, "verifypassword", "confirmpassword", "verifynewpassword");
  // SUBMIT buttons only. createAccountLink and signInLink are the links
  // that SWITCH between the two forms, and each sits on the OTHER one:
  // the sign-in form carries createAccountLink, the creation form
  // carries signInLink. Counting them as evidence of the form you are on
  // inverts the answer, and against the live Northern Trust tenant it
  // classified the sign-in modal as a creation form.
  const createBtn = has(ids, "createaccountsubmitbutton");
  const signInBtn = has(ids, "signinsubmitbutton");

  if (password && (verify || createBtn)) return "CREATE_ACCOUNT_FORM";
  if (password && signInBtn) return "SIGN_IN_FORM";
  // A password box with neither button named. Text may disambiguate, but
  // only when it points one way and not the other.
  if (password) {
    const createish = says(text, /create account|create an account|sign up/);
    const signinish = says(text, /sign in|log in|welcome back/);
    if (createish && !signinish) return "CREATE_ACCOUNT_FORM";
    if (signinish && !createish) return "SIGN_IN_FORM";
    return "UNKNOWN";
  }

  // ---- 6. the public posting or the search page -----------------------
  if (has(ids, "applybutton", "jobpostingheader", "jobpostingdescription")) return "JOB_POSTING";
  // The careers landing page with neither utility button resolved. It is
  // a real Workday page, but it says nothing about our standing.
  if (has(ids, "jobsearchpage", "jobresults", "jobsearch")) return "JOB_POSTING";

  return "UNKNOWN";
}

/** States from which this system may proceed without a person. */
const ACTIONABLE = new Set<WorkdayPageState>(["SIGNED_IN", "SIGNED_OUT", "SIGN_IN_FORM", "CREATE_ACCOUNT_FORM", "JOB_POSTING"]);
export const isActionable = (s: WorkdayPageState): boolean => ACTIONABLE.has(s);

/** Why a state stops, in words a person reading the queue can act on. */
export const HANDOFF_REASON: Record<WorkdayPageState, string | null> = {
  SIGNED_IN: null,
  SIGNED_OUT: null,
  SIGN_IN_FORM: null,
  CREATE_ACCOUNT_FORM: null,
  JOB_POSTING: null,
  CAPTCHA: "the tenant presented a CAPTCHA, which only a person may answer",
  MFA: "the tenant asked for a second factor, which this system does not hold",
  SECURITY_QUESTION: "the tenant asked a security question whose answer is not in the verified profile",
  EMAIL_VERIFICATION: "the tenant sent a verification code or link; automated email verification is not enabled",
  ACCOUNT_EXISTS: "an account already exists for this address and no stored credential matches it",
  INVALID_CREDENTIALS: "the stored credential was refused by the tenant",
  SSO_PROMPT: "the tenant delegates sign-in to an external identity provider",
  UNKNOWN: "the page matched no known Workday state, so nothing about it may be assumed",
};
