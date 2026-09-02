/**
 * Reading a Lever form, against the structures the live boards actually use.
 *
 *   node scripts/lever-snapshot-selftest.ts
 *
 * Fixtures are served at jobs.lever.co so the code under test is the code
 * that runs in production. Every case here is a shape that was observed
 * on Palantir's or Spotify's real application form, and most of them are
 * traps: a card that holds two questions, a checkbox group whose members
 * each claim to be required, a survey that only exists once an office is
 * chosen, and a signature nobody should ever autofill.
 */
import { chromium, type Browser, type Page } from "playwright";
import { snapshotLeverForm, stabilizeLeverForm, leverSnapshotShape } from "../lib/browser/providers/lever.ts";
import { launchBrowser, newPreparedContext, newPreparedPage } from "../lib/browser/launch.ts";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

const ORIGIN = "https://jobs.lever.co";
const shell = (body: string) => `<!doctype html><meta charset="utf-8"><body><form>${body}</form></body>`;

const CORE = `
  <li class="application-question"><div class="application-label">Resume/CV ✱</div>
    <input type="file" name="resume"></li>
  <li class="application-question"><div class="application-label">Full name✱</div>
    <input type="text" name="name" required></li>
  <li class="application-question"><div class="application-label">Email✱</div>
    <input type="email" name="email" required></li>
  <li class="application-question"><div class="application-label">Current location ✱</div>
    <input type="text" name="location" required><input type="hidden" name="selectedLocation"></li>
  <li class="application-question"><div class="application-label">Current company</div>
    <input type="text" name="org"></li>
  <li class="application-question"><div class="application-label">LinkedIn URL</div>
    <input type="text" name="urls[LinkedIn]"></li>`;

// Palantir's card 1c719ca9: ONE card, TWO different legal questions.
const TWO_IN_ONE_CARD = `
  <li class="application-question">
    <div class="application-label">Work authorization✱</div>
    <div class="field"><label for="a0">Are you legally authorized to work in the country for which you are applying?</label>
      <input id="a0" type="radio" name="cards[1c719ca9][field0]" required><label>Yes</label>
      <input type="radio" name="cards[1c719ca9][field0]" required><label>No</label></div>
    <div class="field"><label for="a1">Will you now or in the future require sponsorship for employment visa status?</label>
      <input id="a1" type="radio" name="cards[1c719ca9][field1]" required><label>Yes</label>
      <input type="radio" name="cards[1c719ca9][field1]" required><label>No</label></div>
  </li>`;

// Every member carries `required`, and it means "pick at least one".
const CHECKBOX_GROUP = `
  <li class="application-question"><div class="application-label">Language Skill(s) (Check all that apply)✱</div>
    <label for="l0">English (ENG)</label><input id="l0" type="checkbox" name="cards[a69a985a][field0]" required>
    <label for="l1">Spanish (SPA)</label><input id="l1" type="checkbox" name="cards[a69a985a][field0]" required>
    <label for="l2">French (FRA)</label><input id="l2" type="checkbox" name="cards[a69a985a][field0]" required>
  </li>`;

const SIGNATURE = `
  <li class="application-question"><div class="application-label">Disability signature</div>
    <input type="text" name="eeo[disabilitySignature]"></li>
  <li class="application-question"><div class="application-label">Date</div>
    <input type="text" name="eeo[disabilitySignatureDate]"></li>`;

const browser: Browser = await launchBrowser();
async function open(body: string, after?: string): Promise<Page> {
  const page = await newPreparedPage(browser, { viewport: { width: 1200, height: 900 } });
  let served = shell(body);
  await page.route(`${ORIGIN}/**`, (r) => r.fulfill({ status: 200, contentType: "text/html", body: served }));
  await page.goto(`${ORIGIN}/acme/abc/apply`, { waitUntil: "domcontentloaded" });
  if (after) (page as any).__swap = () => { served = shell(after); };
  return page;
}

console.log("core fields");
{
  const page = await open(CORE);
  const s = await snapshotLeverForm(page);
  const key = (k: string) => s.fields.find((f) => f.key === k);
  check("the resume is a file control", key("resume")?.kind === "file");
  check("location is its own kind, not text", key("location")?.kind === "location", key("location")?.kind);
  check("and records that it commits elsewhere", key("location")?.commitsTo === "selectedLocation");
  check("the hidden commit target is not itself a field", !key("selectedLocation"));
  check("a bracketed url field keeps its full name", Boolean(key("urls[LinkedIn]")));
  check("required is read from the attribute", key("name")?.required === true);
  check("and from the heavy asterisk when there is no attribute", key("resume")?.required === true);
  check("an optional field is not required", key("org")?.required === false);
  check("core fields are in the core namespace", key("email")?.namespace === "core");
  await page.close();
}

console.log("\ntwo questions inside one card");
{
  const page = await open(TWO_IN_ONE_CARD);
  const s = await snapshotLeverForm(page);
  const f0 = s.fields.find((f) => f.key === "cards[1c719ca9][field0]");
  const f1 = s.fields.find((f) => f.key === "cards[1c719ca9][field1]");
  check("both fields are snapshotted separately", Boolean(f0) && Boolean(f1));
  check("they are two fields, not one card", s.fields.filter((f) => f.namespace === "card").length === 2);
  // The whole point: answering field1 with field0's answer is a false
  // legal statement, so their labels must differ.
  check("field0 is the authorization question", /authorized to work/i.test(f0?.label ?? ""), f0?.label);
  check("field1 is the sponsorship question", /sponsorship/i.test(f1?.label ?? ""), f1?.label);
  check("their labels are not the same", f0?.label !== f1?.label);
  check("both share the block id", f0?.blockId === f1?.blockId && f0?.blockId === "1c719ca9");
  check("the card heading is kept separately", /Work authorization/i.test(f0?.blockLabel ?? ""));
  check("each is a radio group", f0?.kind === "radio_group" && f1?.kind === "radio_group");
  await page.close();
}

// The fixture above passes even with the bug, because it puts an
// explicit label[for] ahead of each group. Palantir's real markup does
// not: the labels sit AFTER each radio and are the options, so reading
// the nearest label returned "Yes" as the question for both legal
// questions. This reproduces that markup.
console.log("\nreal-world markup: option labels follow the inputs");
{
  const page = await open(`
    <li class="application-question">
      <div class="application-label">Work eligibility✱</div>
      <div class="field"><span class="text">Are you legally authorized to work in the country for which you are applying?</span>
        <input type="radio" name="cards[x][field0]" required><label>Yes</label>
        <input type="radio" name="cards[x][field0]" required><label>No</label></div>
      <div class="field"><span class="text">Will you now or in the future require sponsorship?</span>
        <input type="radio" name="cards[x][field1]" required><label>Yes</label>
        <input type="radio" name="cards[x][field1]" required><label>No</label></div>
    </li>`);
  const s = await snapshotLeverForm(page);
  const f0 = s.fields.find((f) => f.key === "cards[x][field0]");
  const f1 = s.fields.find((f) => f.key === "cards[x][field1]");
  check("the question is not the first option", f0?.label !== "Yes", f0?.label);
  check("field0 reads as the authorization question", /authorized to work/i.test(f0?.label ?? ""), f0?.label);
  check("field1 reads as the sponsorship question", /sponsorship/i.test(f1?.label ?? ""), f1?.label);
  check("the two remain distinguishable", f0?.label !== f1?.label);
  check("options are Yes and No", JSON.stringify(f0?.options) === JSON.stringify(["Yes", "No"]), JSON.stringify(f0?.options));
  await page.close();
}

// A single-question card is named by its heading, not by its first option.
console.log("\na one-question card takes its heading");
{
  const page = await open(`
    <li class="application-question"><div class="application-label">Language Skill(s) (Check all that apply)✱</div>
      <input type="checkbox" name="cards[y][field0]" required><label>English (ENG)</label>
      <input type="checkbox" name="cards[y][field0]" required><label>Spanish (SPA)</label></li>`);
  const s = await snapshotLeverForm(page);
  const g = s.fields.find((f) => f.key === "cards[y][field0]");
  check("labelled by the card heading", /Language Skill/i.test(g?.label ?? ""), g?.label);
  check("not by its first option", !/English/i.test(g?.label ?? ""));
  await page.close();
}

console.log("\ncheckbox group semantics");
{
  const page = await open(CHECKBOX_GROUP);
  const s = await snapshotLeverForm(page);
  const g = s.fields.filter((f) => f.key === "cards[a69a985a][field0]");
  check("thirty boxes are one question, not thirty", g.length === 1, `${g.length} fields`);
  check("it is a checkbox group", g[0]?.kind === "checkbox_group");
  check("every option is captured", g[0]?.options.length === 3, JSON.stringify(g[0]?.options));
  check("the group is required once", g[0]?.required === true);
  await page.close();
}

console.log("\nsignatures are never fields to fill");
{
  const page = await open(SIGNATURE);
  const s = await snapshotLeverForm(page);
  const sig = s.fields.find((f) => f.key === "eeo[disabilitySignature]");
  check("a signature control is marked as such", sig?.kind === "signature", sig?.kind);
  check("and listed for handoff", s.signatureKeys.includes("eeo[disabilitySignature]"));
  await page.close();
}

console.log("\nhCaptcha");
{
  const page = await open(CORE + `<iframe src="https://hcaptcha.com/captcha/v1/x/anchor"></iframe>`);
  const s = await snapshotLeverForm(page);
  check("a loaded widget is detected", s.captchaPresent);
  check("but an invisible widget is not a challenge", !s.captchaChallengeVisible);
  await page.close();
}
{
  const page = await open(CORE
    + `<iframe src="https://hcaptcha.com/captcha/v1/x/bframe" style="width:400px;height:500px"></iframe>`);
  const s = await snapshotLeverForm(page);
  check("a displayed challenge frame is detected", s.captchaChallengeVisible);
  await page.close();
}

console.log("\nsnapshot drift");
{
  const a = await open(CORE);
  const before = leverSnapshotShape(await snapshotLeverForm(a));
  await a.close();
  const b = await open(CORE + CHECKBOX_GROUP);
  const after = leverSnapshotShape(await snapshotLeverForm(b));
  await b.close();
  check("adding a required question changes the shape", before !== after);
  const c = await open(CORE);
  const again = leverSnapshotShape(await snapshotLeverForm(c));
  await c.close();
  check("and an unchanged form hashes identically", before === again);
}

console.log("\noffice selection is deterministic or it stops");
{
  const two = `<select name="opportunityLocationId">
      <option value=""></option><option value="a">Chicago, IL</option><option value="b">New York, NY</option>
    </select>` + CORE;
  const p1 = await open(two);
  const amb = await stabilizeLeverForm(p1, {});
  check("two offices and no reviewed choice stops", amb.chose === null && /person must choose/.test(amb.reason), amb.reason);
  await p1.close();

  const p2 = await open(two);
  const exact = await stabilizeLeverForm(p2, { preferLocation: "Chicago, IL" });
  check("an exact reviewed office is used", exact.chose === "Chicago, IL", JSON.stringify(exact));
  check("and the reason says why", /exact match/.test(exact.reason), exact.reason);
  await p2.close();

  const p3 = await open(two);
  const near = await stabilizeLeverForm(p3, { preferLocation: "Chicago" });
  check("a near match is not good enough", near.chose === null, JSON.stringify(near));
  await p3.close();

  const p4 = await open(`<select name="opportunityLocationId"><option value="a">Chicago, IL</option></select>` + CORE);
  const only = await stabilizeLeverForm(p4, {});
  check("a single office needs no choice", only.chose === "Chicago, IL", JSON.stringify(only));
  await p4.close();
}

await browser.close();
console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
