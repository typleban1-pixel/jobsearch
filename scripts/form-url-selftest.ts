import { resolveFormUrl } from "../lib/applications/formUrl.ts";
let bad = 0; const ok = (c: boolean, w: string) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}`); if (!c) bad++; };
ok(resolveFormUrl({ source: "GREENHOUSE", application_form_url: "https://boards.gh/x" }) === "https://boards.gh/x", "Greenhouse uses application_form_url");
ok(resolveFormUrl({ source: "ASHBY", application_form_url: null, apply_url: "https://jobs.ashbyhq.com/x/y/application" }) === "https://jobs.ashbyhq.com/x/y/application", "Ashby falls back to apply_url");
ok(resolveFormUrl({ source: "ASHBY", application_form_url: null, apply_url: null, url: "https://jobs.ashbyhq.com/x" }) === "https://jobs.ashbyhq.com/x", "Ashby falls back to url when apply_url missing");
ok(resolveFormUrl({ source: "GREENHOUSE", application_form_url: null, apply_url: "https://co/careers" }) === null, "non-Ashby with no board form -> null (do not guess)");
ok(resolveFormUrl({ source: "ASHBY", application_form_url: "https://boards/x", apply_url: "https://a/y" }) === "https://boards/x", "explicit application_form_url wins even for Ashby");
// Greenhouse: derive the embed form URL from a job-boards apply/canonical URL
// when application_form_url was not captured. Verified 910/910 against real data.
ok(resolveFormUrl({ source: "GREENHOUSE", application_form_url: null, apply_url: "https://job-boards.greenhouse.io/enova/jobs/8108974" }) === "https://job-boards.greenhouse.io/embed/job_app?for=enova&token=8108974", "Greenhouse derives embed form URL from job-boards apply_url");
ok(resolveFormUrl({ source: "GREENHOUSE", application_form_url: null, apply_url: null, url: "https://job-boards.greenhouse.io/alpaca/jobs/5993822004" }) === "https://job-boards.greenhouse.io/embed/job_app?for=alpaca&token=5993822004", "Greenhouse derives from canonical url when apply_url missing");
ok(resolveFormUrl({ source: "GREENHOUSE", application_form_url: null, apply_url: "https://careers.toasttab.com/jobs?gh_jid=8147833" }) === null, "Greenhouse company-hosted apply URL (no token in path) stays null -> fail-closed");
ok(resolveFormUrl({ source: "GREENHOUSE", application_form_url: "https://job-boards.greenhouse.io/embed/job_app?for=x&token=1", apply_url: "https://job-boards.greenhouse.io/x/jobs/1" }) === "https://job-boards.greenhouse.io/embed/job_app?for=x&token=1", "explicit application_form_url still wins over derivation");
console.log(bad ? `\n${bad} FAILED` : `\nform-url-selftest: ALL PASS`); process.exit(bad ? 1 : 0);
