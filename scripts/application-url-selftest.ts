/**
 * Resolving the real application form, and refusing when it cannot be.
 *
 *   node scripts/application-url-selftest.ts          offline cases only
 *   node scripts/application-url-selftest.ts --live   also hit the boards API
 *
 * The defect these cover: jobs.apply_url holds Greenhouse's absolute_url,
 * which for a custom-branded board is the employer's careers page. The
 * adapter opened stripe.com/jobs/search?gh_jid=7844214, found a job
 * description with an Apply button and no form, and stopped. 1,505 of
 * 2,786 Greenhouse jobs were in that state, including the one already
 * approved for submission.
 *
 * The case that matters most is the last one. A board token belonging to
 * another employer must never resolve, because the failure it produces is
 * an application sent to the wrong company's requisition.
 */
import { greenhouseFormUrl, greenhouseBoardUrl, verifyGreenhouseForm, verifyFormPage, sameEmployer } from "../lib/ingest/applicationUrl.ts";

const live = process.argv.includes("--live");
let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

// Real board tokens and real job ids, as ingest holds them.
const CASES: Array<[string, string, string, string]> = [
  // employer, token, job id, the apply_url currently stored
  ["Stripe",     "stripe",     "7844214",     "https://stripe.com/jobs/search?gh_jid=7844214"],
  ["SpotHero",   "spothero",   "8010894",     "https://spothero.com/careers/8010894/?gh_jid=8010894"],
  ["Toast",      "toast",      "8049262",     "https://careers.toasttab.com/jobs?gh_jid=8049262"],
  ["Brex",       "brex",       "8743271002",  "https://www.brex.com/careers/8743271002?gh_jid=8743271002"],
  ["Samsara",    "samsara",    "8131784",     "https://www.samsara.com/company/careers/roles/8131784?gh_jid=8131784"],
  // The control: this employer's stored URL is ALREADY a Greenhouse form,
  // so derivation must reproduce it exactly rather than changing it.
  ["Affirm",     "affirm",     "7833173003",  "https://job-boards.greenhouse.io/affirm/jobs/7833173003"],
];

console.log("\nderiving a form url from the board token and job id");
for (const [employer, token, id, stored] of CASES) {
  const r = greenhouseFormUrl(token, id);
  const expected = `https://job-boards.greenhouse.io/embed/job_app?for=${token}&token=${id}`;
  check(`${employer}: embed/job_app?for=${token}&token=${id}`,
    r.ok && r.url === expected, r.ok ? r.url : r.why);
  // The board route is NOT the form. It answers 200 and redirects to the
  // employer's description page, which is what broke the first attempt.
  check(`  and it is not the board description route`,
    r.ok && r.url !== greenhouseBoardUrl(token, id));
  check(`  and it is not the stored careers page`, r.ok && r.url !== stored);
}

console.log("\nthe token is never taken from a hostname");
check("a hostname is not a token", !greenhouseFormUrl("stripe.com", "7844214").ok);
check("a url is not a token", !greenhouseFormUrl("https://job-boards.greenhouse.io/stripe", "7844214").ok);
check("a path traversal is not a token", !greenhouseFormUrl("stripe/../spothero", "7844214").ok);
check("a token with a slash is refused", !greenhouseFormUrl("stripe/jobs", "7844214").ok);

console.log("\nbad inputs fail closed rather than producing a url");
check("no token", !greenhouseFormUrl(null, "7844214").ok);
check("no job id", !greenhouseFormUrl("stripe", null).ok);
check("a non-numeric job id", !greenhouseFormUrl("stripe", "abc123").ok);
check("a job id that is a path", !greenhouseFormUrl("stripe", "7844214/apply").ok);
check("an empty token", !greenhouseFormUrl("   ", "7844214").ok);

console.log("\nemployer identity, for catching a token that points elsewhere");
check("Stripe matches Stripe", sameEmployer("Stripe", "Stripe"));
check("suffixes and punctuation do not matter", sameEmployer("Genius One, Inc.", "Genius One"));
check("Stripe does not match SpotHero", !sameEmployer("Stripe", "SpotHero"));
check("Toast does not match Toast Takeout only by prefix reversal", sameEmployer("Toast", "Toast, Inc."));
check("an empty name never matches", !sameEmployer("Stripe", null));

if (!live) {
  console.log(`\n${failures === 0 ? "offline cases passed" : failures + " FAILED"}; pass --live to verify against the boards API`);
  process.exit(failures === 0 ? 0 : 1);
}

console.log("\nverifying each derived url against the live boards API");
for (const [employer, token, id] of CASES) {
  const r = await verifyGreenhouseForm(token, id);
  check(`${employer} ${token}/${id} resolves to the same job id`,
    r.ok && String(r.job.id) === id, r.ok ? `id ${r.job.id}` : r.why);
  if (r.ok) {
    check(`  and the board reports the employer as ${employer}`,
      sameEmployer(r.job.companyName, employer), `board says ${JSON.stringify(r.job.companyName)}`);
  }
}

// The one that would send an application to the wrong company.
console.log("\none employer's job id must not resolve on another employer's board");
const CROSS: Array<[string, string, string]> = [
  ["stripe", "8010894", "SpotHero's job id on Stripe's board"],
  ["spothero", "7844214", "Stripe's job id on SpotHero's board"],
  ["toast", "8743271002", "Brex's job id on Toast's board"],
  ["brex", "8131784", "Samsara's job id on Brex's board"],
];
for (const [token, id, what] of CROSS) {
  const r = await verifyGreenhouseForm(token, id);
  check(what + " is refused", !r.ok, r.ok ? `RESOLVED to ${r.job.companyName} "${r.job.title}"` : r.why);
}

// The check that was missing the first time.
//
// The board route answered 200 and its HTML contained the job title, so
// it looked right and was not. What it actually does is redirect to the
// employer's description page. Reading a status code proves nothing; the
// effective URL and the presence of a form do.
console.log("\nthe derived url serves a form and is not redirected away");
for (const [employer, token, id] of CASES) {
  const built = greenhouseFormUrl(token, id);
  if (!built.ok) { check(`${employer}: derivable`, false, built.why); continue; }
  const p = await verifyFormPage(built.url, employer);
  check(`${employer}: the form page is a form, titled for ${employer}`,
    p.ok, p.ok ? p.title : p.why);
}

console.log("\nthe board description route is rejected as a form");
for (const [employer, token, id] of CASES.slice(0, 3)) {
  const p = await verifyFormPage(greenhouseBoardUrl(token, id), employer);
  check(`${employer}: /${token}/jobs/${id} is refused as a form`,
    !p.ok, p.ok ? `ACCEPTED "${p.title}"` : p.why);
}

console.log("\na board that does not exist fails closed");
const nonsense = await verifyGreenhouseForm("no-such-board-xyzzy", "7844214");
check("an unknown board is refused", !nonsense.ok, nonsense.ok ? "it resolved" : nonsense.why);

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
