/**
 * The Ashby anonymous react-select combobox resolver, tested at the seams
 * that carry the safety: the guard's option-fetch allowance, the marking of
 * which fields are comboboxes, and the DOM anchor that binds an anonymous
 * combobox to exactly one question container (fail closed otherwise). The
 * exact-option / geo / demographic MATCH decisions are covered by
 * chooseSingleOption, the geography matchers, and resolveEeoOption; the live
 * click + read-back is exercised by the supervised --validate run.
 */
import { chromium } from "playwright";
import { mayFetchWhileFilling, isBenignBlocked, blockedIndicatesSubmission, classifyUploadOp } from "../lib/browser/submitGuard.ts";
import { markAshbyComboboxes, readAshbyComboboxes } from "../lib/browser/ashbyForm.ts";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };
const BASE = "https://jobs.ashbyhq.com/api/non-user-graphql";

console.log("guard: only the geo read and the resume-upload handle are allowed while filling:");
ok(mayFetchWhileFilling(`${BASE}?op=ApiAutocompleteGeoLocation`) === true, "the geo autocomplete read is allowed");
ok(mayFetchWhileFilling(`${BASE}?op=ApiAutocompleteGeoLocation&x=1`) === true, "  ...with trailing params too");
ok(mayFetchWhileFilling(`${BASE}?op=ApiCreateFileUploadHandle`) === false, "the upload ops are NOT statically allowed (context-gated, not blanket)");
ok(mayFetchWhileFilling(`${BASE}?op=ApiSetFormValue`) === false, "per-field autosave is NOT allowed (stays blocked)");
ok(mayFetchWhileFilling(`${BASE}?op=SubmitApplicationForm`) === false, "a submit-like operation is NOT allowed (stays blocked)");
ok(mayFetchWhileFilling(`${BASE}?op=CreateApplication`) === false, "any other application mutation is NOT allowed");
ok(mayFetchWhileFilling(`${BASE}?op=ApiAutocompleteGeoLocationEvil`) === false, "a look-alike geo op is not allowed (anchored match)");
ok(mayFetchWhileFilling(`${BASE}?op=UpdateApplicationForm`) === false, "an autosave-shaped mutation is not allowed");

console.log("\nclassifyUploadOp: the resume upload is gated to an open upload window, in order:");
const H = `${BASE}?op=ApiCreateFileUploadHandle`, F = `${BASE}?op=ApiSetFormValueToFile`;
ok(classifyUploadOp(H, { resumeUpload: true, handleSeen: false }) === "allow-handle", "handle op allowed once the upload window is open");
ok(classifyUploadOp(F, { resumeUpload: true, handleSeen: true }) === "allow-attach", "set-to-file (finalize) allowed AFTER the handle, in the window");
ok(classifyUploadOp(F, { resumeUpload: true, handleSeen: false }) === null, "set-to-file WITHOUT a preceding handle -> blocked");
ok(classifyUploadOp(F, { resumeUpload: false, handleSeen: true }) === null, "set-to-file with NO upload window -> blocked (no arbitrary file writes)");
ok(classifyUploadOp(H, { resumeUpload: false, handleSeen: false }) === null, "handle op with no window -> blocked");
ok(classifyUploadOp(`${BASE}?op=ApiSetFormValue`, { resumeUpload: true, handleSeen: true }) === null, "ordinary autosave is never an upload op -> blocked");
ok(classifyUploadOp(`${BASE}?op=SubmitApplicationForm`, { resumeUpload: true, handleSeen: true }) === null, "the submit mutation is never an upload op -> blocked");
ok(classifyUploadOp(`${BASE}?op=ApiSetFormValueToFileX`, { resumeUpload: true, handleSeen: true }) === null, "a look-alike finalize op -> blocked (anchored match)");
ok(blockedIndicatesSubmission([F]) === true, "a BLOCKED set-to-file (fired outside the window) -> trips the guard (fails closed)");
ok(blockedIndicatesSubmission([H]) === true, "a BLOCKED handle op (outside the window) -> trips the guard (fails closed)");

console.log("\nterminal submission-attempt classification of BLOCKED ops (all stay blocked):");
ok(isBenignBlocked(`${BASE}?op=ApiSetFormValue`) === true, "a blocked ApiSetFormValue (autosave) is known-benign");
ok(isBenignBlocked(`${BASE}?op=ApiAutocompleteGeoLocation`) === true, "a blocked geo fetch is known-benign");
ok(isBenignBlocked(`${BASE}?op=SubmitApplicationForm`) === false, "the submit mutation is NOT benign");
ok(isBenignBlocked(`${BASE}?op=SomethingUnknown`) === false, "an unknown op is NOT benign");
ok(blockedIndicatesSubmission([`${BASE}?op=ApiSetFormValue`]) === false, "blocked ApiSetFormValue alone -> does NOT trip submission detection");
ok(blockedIndicatesSubmission([`${BASE}?op=ApiAutocompleteGeoLocation`]) === false, "blocked geo fetch alone -> does NOT trip");
ok(blockedIndicatesSubmission([`${BASE}?op=SubmitApplicationForm`]) === true, "blocked submit mutation -> STILL trips (fails closed)");
ok(blockedIndicatesSubmission([`${BASE}?op=ApiSubmitApplication`]) === true, "an alternate submit op name -> STILL trips");
ok(blockedIndicatesSubmission([`${BASE}?op=WhoKnows`]) === true, "blocked unknown Ashby POST -> STILL trips (fails closed)");
ok(blockedIndicatesSubmission([`${BASE}?op=ApiSetFormValue`, `${BASE}?op=SubmitApplicationForm`]) === true, "benign + a submit op together -> trips (any non-benign trips)");
ok(blockedIndicatesSubmission([]) === false, "nothing blocked -> nothing tripped");

console.log("\nmarkAshbyComboboxes: re-tags only the matching question, preserving everything else:");
const fields: any[] = [
  { key: "_systemfield_name", label: "Full Name", type: "text", htmlType: "text", required: true },
  { key: "How would you describe your ethnic or cultural background?", label: "How would you describe your ethnic or cultural background?", type: "text", htmlType: "input", required: false },
  { key: "grp", label: "Pick one", type: "select", htmlType: "radio-group", required: true, options: ["A", "B"] },
  { key: "_systemfield_resume", label: "Resume", type: "file", htmlType: "file", required: true },
];
const marked = markAshbyComboboxes(fields, ["How would you describe your ethnic or cultural background?"]);
const eth = marked.find((f) => /ethnic/.test(f.label));
ok(!!eth && eth.htmlType === "ashby-combobox" && eth.type === "select", "the matching text field becomes an ashby-combobox select");
ok(marked.find((f) => f.key === "_systemfield_name")?.htmlType === "text", "a non-matching text field is untouched");
ok(!!marked.find((f) => f.htmlType === "radio-group"), "a grouped choice question is never re-tagged as a combobox");
ok(!!marked.find((f) => f.type === "file"), "a file field is never re-tagged");
ok(markAshbyComboboxes(fields, []).every((f, i) => f.htmlType === fields[i].htmlType), "no combo questions -> nothing changes");

console.log("\nreadAshbyComboboxes (DOM anchor): bound to a unique container, ambiguous ones excluded:");
const U = "11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222";
const html = `<!doctype html><html><body>
  <div class="_fieldEntry_ab1"><label>Please list the city of your current residence.</label>
    <input role="combobox" placeholder="Start typing..."></div>
  <div class="_fieldEntry_ab2"><label>Two comboboxes in one container?</label>
    <input role="combobox"><input role="combobox"></div>
  <fieldset class="_fieldEntry_ab3"><div>A choice question</div>
    <input type="radio" name="${U}"><input type="radio" name="${U.replace('2222','3333')}"></fieldset>
  <div class="_fieldEntry_ab4"><div>Combobox beside a choice group</div>
    <input role="combobox"><input type="radio" name="${U}"><input type="radio" name="${U.replace('2222','4444')}"></div>
</body></html>`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(html);
  const combos = await readAshbyComboboxes(page);
  ok(combos.includes("Please list the city of your current residence."), "a lone combobox is bound to its question heading", combos.join(" | "));
  ok(!combos.some((q) => /Two comboboxes/.test(q)), "two comboboxes in one container -> excluded (ambiguous, fail closed)");
  ok(!combos.some((q) => /A choice question/.test(q)), "a choice fieldset is not a combobox");
  ok(!combos.some((q) => /beside a choice group/.test(q)), "a combobox mixed with a choice group -> excluded");
  ok(combos.length === 1, "exactly the one unambiguous combobox question is returned", String(combos.length));
} finally { await browser.close(); }

console.log(bad ? `\n${bad} FAILED` : `\nashby-combobox-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
