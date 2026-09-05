/**
 * Resume/CV upload recognition (prepare.ts binding gate).
 *
 * A resume field binds to THIS application's exact tailored artifact. It is
 * recognized by the visible label OR by Ashby's canonical `_systemfield_resume`
 * key. The key path is defense-in-depth so a customized label still binds; it
 * must NOT generalize to other `_systemfield_*` fields, and an arbitrary/custom
 * file field (e.g. the real "Overview Application") must remain an employer-form
 * handoff, never assumed to be a resume.
 *
 *   node scripts/resume-field-recognition-selftest.ts
 */
import { isResumeUploadField, ASHBY_RESUME_KEY } from "../lib/applications/intents.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

check("the Ashby key constant is exactly _systemfield_resume", ASHBY_RESUME_KEY === "_systemfield_resume");

// Positive: label-based recognition still works.
check("label 'Resume' is recognized", isResumeUploadField({ key: "custom_123", label: "Resume" }));
check("label 'Upload your CV' is recognized", isResumeUploadField({ key: "abc", label: "Upload your CV" }));
check("label 'Curriculum Vitae' is recognized", isResumeUploadField({ key: "abc", label: "Curriculum Vitae" }));

// Positive: key-based recognition binds even when the visible label changed and
// would NOT match on its own.
check("the label alone would NOT match here",
  !/\b(resume|cv|curriculum vitae)\b/i.test("Attach your application document"));
check("_systemfield_resume binds even when its label is customized away from 'Resume'",
  isResumeUploadField({ key: "_systemfield_resume", label: "Attach your application document" }));

// Negative: the real dead-end field. A custom file field is NOT a resume.
check("custom 'Overview Application' file field is NOT a resume (stays employer-form handoff)",
  !isResumeUploadField({ key: "Overview Application", label: "Overview Application" }));

// Negative: recognition does not generalize to other _systemfield_* keys.
check("_systemfield_cover_letter is NOT a resume",
  !isResumeUploadField({ key: "_systemfield_cover_letter", label: "Cover Letter" }));
check("an unrelated _systemfield_* file field is NOT a resume",
  !isResumeUploadField({ key: "_systemfield_portfolio", label: "Upload a file" }));
check("a bare unknown file field is NOT a resume",
  !isResumeUploadField({ key: "additional_docs", label: "Additional documents" }));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("resume-field recognition holds: label OR exact Ashby key, nothing else");
