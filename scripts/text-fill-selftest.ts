/**
 * The first character must never be silently lost.
 *
 * Run against a real DOM, including an input that deliberately eats its
 * first keystroke and one that ignores programmatic values, because the
 * live failure was invisible to a naive read-back.
 */
import { chromium } from "playwright";
import { fillTextExact, firstCharacterLost, describeMismatch } from "../lib/workday/textFill.ts";

let n = 0, bad = 0;
const ok = (c: boolean, w: string) => { n++; if (!c) { bad++; console.error(`FAIL ${w}`); } };

// ---- 1. the detector -------------------------------------------------
ok(firstCharacterLost("Cleveland, OH", "leveland, OH"), "leveland is Cleveland with the head bitten off");
ok(firstCharacterLost("Highland Heights, OH", "ighland Heights, OH"), "ighland Heights is detected");
ok(firstCharacterLost("Bowling Green, KY", "owling Green, KY"), "owling Green is detected");
ok(firstCharacterLost("Elyria, OH", "lyria, OH"), "lyria is detected");
ok(!firstCharacterLost("Cleveland, OH", "Cleveland, OH"), "an intact value is not a loss");
ok(!firstCharacterLost("Cleveland, OH", ""), "an empty field is not a first-character loss");
ok(!firstCharacterLost("A", ""), "a one-character value cannot lose its head this way");
ok(/first character was lost/.test(describeMismatch("Cleveland, OH", "leveland, OH")),
   "the mismatch is described as a lost first character");
ok(/truncated/.test(describeMismatch("Western Governors University", "We")), "a truncation is described as one");
ok(/empty/.test(describeMismatch("Cleveland, OH", "")), "an empty field is described as empty");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
const LOCATIONS = ["Cleveland, OH", "Highland Heights, OH", "Bowling Green, KY", "Elyria, OH"];

// ---- 2. an ordinary input keeps every character ----------------------
await page.setContent(`<body><input id="a"></body>`);
for (const v of LOCATIONS) {
  const r = await fillTextExact(page, page.locator("#a"), v);
  ok(r.ok, `${v} writes cleanly`);
  ok(r.read === v, `${v} reads back exactly (got ${JSON.stringify(r.read)})`);
  ok(!firstCharacterLost(v, r.read), `${v} keeps its first character`);
}

// ---- 3. a value written after another field is not disturbed ---------
// The live shape: write one field, then interact with a second.
await page.setContent(`<body><input id="a"><input id="b"></body>`);
{
  const first = await fillTextExact(page, page.locator("#a"), "Cleveland, OH");
  ok(first.ok, "the first field is written");
  await fillTextExact(page, page.locator("#b"), "Highland Heights, OH");
  const still = await page.locator("#a").inputValue();
  ok(still === "Cleveland, OH", `writing another field leaves the first intact (got ${JSON.stringify(still)})`);
  ok(!firstCharacterLost("Cleveland, OH", still), "and it did not lose its first character");
}

// ---- 4. THE LIVE BUG: Control+A then Delete eats the first character --
// Proves the mechanism, and that the strict fill repairs it.
await page.setContent(`<body><input id="a"></body>`);
{
  await page.locator("#a").fill("Cleveland, OH");
  await page.locator("#a").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  const damaged = await page.locator("#a").inputValue();
  // On a platform where Control+A selects all, the field empties; where
  // it moves the caret, the first character goes. Either way it is not
  // the value that was there, which is the whole point.
  ok(damaged !== "Cleveland, OH", `the old clear sequence damages the field (left ${JSON.stringify(damaged)})`);
  const repaired = await fillTextExact(page, page.locator("#a"), "Cleveland, OH");
  ok(repaired.ok && repaired.read === "Cleveland, OH", "the strict fill restores it exactly");
}

// ---- 5. a control that ignores programmatic values -------------------
await page.setContent(`<body><input id="a"></body>`);
await page.evaluate(() => {
  const el = document.querySelector("#a") as HTMLInputElement;
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
  let real = "";
  Object.defineProperty(el, "value", {
    get() { return real; },
    // Ignores whole-string assignment; accepts single keystrokes.
    set(v: string) { if (v === "" || v.length <= 1) real = v; },
  });
  el.addEventListener("keypress", (e: any) => { real = real + e.key; });
});
{
  const r = await fillTextExact(page, page.locator("#a"), "Cleveland, OH");
  // The guarantee is not how many attempts it takes; it is that a
  // reported success is always the exact value, and anything else is
  // reported as a failure with a reason. A silent wrong value is the
  // only outcome that must be impossible.
  ok(r.ok ? r.read === "Cleveland, OH" : Boolean(r.why),
     `an awkward control either lands exactly or explains itself (ok=${r.ok} read=${JSON.stringify(r.read)})`);
  ok(!r.ok || !firstCharacterLost("Cleveland, OH", r.read), "a success is never a first-character loss");
}

// ---- 6. failure is reported, never swallowed -------------------------
await page.setContent(`<body><input id="a" readonly value="locked"></body>`);
{
  const r = await fillTextExact(page, page.locator("#a"), "Cleveland, OH");
  ok(!r.ok, "a read-only field fails rather than reporting success");
  ok(Boolean(r.why), "and says why");
}

await browser.close();
console.log(`${n - bad}/${n} assertions passed`);
process.exit(bad ? 1 : 0);
