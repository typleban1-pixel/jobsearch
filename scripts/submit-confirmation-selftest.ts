/**
 * Deciding whether a click actually submitted the application.
 *
 * Home Chef's confirmation page congratulates you and, in a sidebar,
 * offers "Sign in to MyGreenhouse to keep tabs on your application".
 * Treating the words "sign in" as a barrier recorded a real, completed
 * submission as not submitted, which invites applying to the same
 * employer twice. A genuine wall keeps the form and does not thank you.
 */

const SUCCESS = /thank you|application (?:has been )?(?:received|submitted)|we[\u2019\u0027]?ve received|successfully submitted|your application was/i;
const LOGIN = /sign in|log in to continue|session (?:has )?expired/i;

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

interface Page { text: string; controls: number; url: string }

/** The decision as submit-application.ts makes it. */
function judge(before: Page, after: Page): { confirmed: boolean; problems: string[] } {
  const introduced = (re: RegExp) => re.test(after.text) && !re.test(before.text);
  const succeeded = SUCCESS.test(after.text);
  const problems: string[] = [];
  if (introduced(LOGIN) && !succeeded) problems.push("the page is asking to sign in");
  if (after.controls >= before.controls && !succeeded) problems.push("the form is still present");
  return { confirmed: succeeded && problems.length === 0, problems };
}

const FORM: Page = {
  text: "Apply for this job First Name Last Name Email Resume Submit application",
  controls: 21,
  url: "https://job-boards.greenhouse.io/embed/job_app?for=homechef&token=5286389008",
};

// The real Home Chef confirmation page, verbatim.
{
  const after: Page = {
    text: "Thank you for applying! We appreciate your interest and will review your application soon. "
      + "In the meantime, check out our tasty meals at HomeChef.com! View more jobs at Home Chef "
      + "Back to job post Track your application Sign in to MyGreenhouse to keep tabs on your "
      + "application, get status updates and more. Sign in to MyGreenhouse",
    controls: 0,
    url: "https://job-boards.greenhouse.io/embed/job_app/confirmation?for=homechef&token=5286389008",
  };
  const r = judge(FORM, after);
  check("an optional sign-in tracking card does not block confirmation", r.confirmed, r.problems.join(","));
  check("and no sign-in problem is reported", !r.problems.some((p) => /sign in/.test(p)), r.problems.join(","));
  check("the confirmation URL is reached", after.url.includes("/confirmation"), "");
  check("and the form is gone", after.controls === 0, "");
}

// A genuine sign-in wall: no success text, form still there.
{
  const after: Page = {
    text: "Please sign in to continue your application. Sign in Email Password",
    controls: 24,
    url: "https://job-boards.greenhouse.io/embed/job_app?for=homechef&token=5286389008",
  };
  const r = judge(FORM, after);
  check("a real login wall is not confirmed", !r.confirmed, "");
  check("and it reports the sign-in problem", r.problems.some((p) => /sign in/.test(p)), r.problems.join(","));
  check("and it reports the form still present", r.problems.some((p) => /still present/.test(p)), "");
}

// A session expiring mid-submission is still a failure.
{
  const after: Page = { text: "Your session has expired. Please sign in again.", controls: 21, url: FORM.url };
  check("an expired session is not confirmed", !judge(FORM, after).confirmed, "");
}

// Success text that was already on the page before the click proves
// nothing, but it also must not be read as a newly introduced problem.
{
  const before: Page = { ...FORM, text: FORM.text + " Sign in to MyGreenhouse" };
  const after: Page = {
    text: "Thank you for applying! Sign in to MyGreenhouse to keep tabs on your application.",
    controls: 0, url: FORM.url + "/confirmation",
  };
  check("pre-existing sign-in text is never introduced by the click", judge(before, after).confirmed, "");
}

// Other employers phrase confirmation differently.
for (const text of [
  "Your application has been received.",
  "We\u2019ve received your application and will be in touch.",
  "Application successfully submitted.",
]) {
  const r = judge(FORM, { text, controls: 0, url: FORM.url + "/confirmation" });
  check(`confirmed: "${text.slice(0, 34)}..."`, r.confirmed, r.problems.join(","));
}

// No success signal at all, form gone: still not confirmed, because
// nothing said the employer received it.
{
  const r = judge(FORM, { text: "Something went wrong.", controls: 0, url: FORM.url });
  check("a vanished form without a success signal is not confirmed", !r.confirmed, "");
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
