import { resolveFormUrl } from "../lib/applications/formUrl.ts";
let bad = 0; const ok = (c: boolean, w: string) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}`); if (!c) bad++; };
ok(resolveFormUrl({ source: "GREENHOUSE", application_form_url: "https://boards.gh/x" }) === "https://boards.gh/x", "Greenhouse uses application_form_url");
ok(resolveFormUrl({ source: "ASHBY", application_form_url: null, apply_url: "https://jobs.ashbyhq.com/x/y/application" }) === "https://jobs.ashbyhq.com/x/y/application", "Ashby falls back to apply_url");
ok(resolveFormUrl({ source: "ASHBY", application_form_url: null, apply_url: null, url: "https://jobs.ashbyhq.com/x" }) === "https://jobs.ashbyhq.com/x", "Ashby falls back to url when apply_url missing");
ok(resolveFormUrl({ source: "GREENHOUSE", application_form_url: null, apply_url: "https://co/careers" }) === null, "non-Ashby with no board form -> null (do not guess)");
ok(resolveFormUrl({ source: "ASHBY", application_form_url: "https://boards/x", apply_url: "https://a/y" }) === "https://boards/x", "explicit application_form_url wins even for Ashby");
console.log(bad ? `\n${bad} FAILED` : `\nform-url-selftest: ALL PASS`); process.exit(bad ? 1 : 0);
