/**
 * A control nobody discovers is left blank and the form is still called
 * complete. That is how State/Province went missing on Northern Trust, so
 * these cases run the real snapshotLive against DOMs that reproduce the
 * shapes involved.
 */
import { chromium } from "playwright";
import { snapshotLive } from "../lib/browser/liveSnapshot.ts";

let n = 0, bad = 0;
const ok = (c: boolean, what: string) => { n++; if (!c) { bad++; console.error(`FAIL ${what}`); } };

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
const snap = async (html: string) => {
  await page.setContent(`<body>${html}</body>`);
  return await snapshotLive(page.mainFrame() as any);
};
const labels = (s: any) => (s.fields ?? []).map((f: any) => f.label);
const find = (s: any, l: string) => (s.fields ?? []).find((f: any) => f.label === l);

// ---- 1. the Workday address block, as it actually renders -------------
{
  const s = await snap(`
    <label for="addressLine1">Address Line 1</label>
    <input id="addressLine1" name="addressLine1">
    <label for="city">City</label><input id="city" name="city">
    <div id="ctry-l">Country</div>
    <button data-automation-id="country--country" aria-haspopup="listbox"
            aria-labelledby="ctry-l">United States of America</button>
    <div id="st-l">State</div>
    <button data-automation-id="countryRegion" aria-haspopup="listbox"
            aria-labelledby="st-l">Select One</button>
    <label for="postalCode">Postal Code</label><input id="postalCode" name="postalCode">`);
  ok(labels(s).includes("State"), "the State listbox button is discovered");
  ok(labels(s).includes("Country"), "the Country listbox button is discovered");
  ok(labels(s).includes("Address Line 1"), "native inputs are still discovered");
  ok(labels(s).includes("Postal Code"), "postal code survives the change");
  const st = find(s, "State");
  ok(st?.htmlType === "select", "a listbox button is typed as a dropdown");
  ok(String(st?.selector).includes("countryRegion"),
     `State is targeted by its automation id (got ${st?.selector})`);
}

// ---- 2. widget chrome is not a second question ------------------------
{
  const s = await snap(`
    <label for="src">How Did You Hear About Us?</label>
    <div role="combobox" aria-haspopup="listbox" data-automation-id="sourceWrapper">
      <select id="src" name="source"><option>Web Site</option></select>
    </div>`);
  ok((s.fields ?? []).length === 1,
     `a wrapper around a real select is not counted twice (got ${(s.fields ?? []).length})`);
  ok(find(s, "How Did You Hear About Us?")?.htmlType === "select", "the native select is the one kept");
}

// ---- 3. invisible and unidentifiable widgets stay out -----------------
{
  const s = await snap(`
    <div id="a">Hidden State</div>
    <button data-automation-id="hiddenRegion" aria-haspopup="listbox"
            aria-labelledby="a" style="display:none">x</button>
    <div role="combobox">no identity at all</div>
    <label for="c">City</label><input id="c" name="city">`);
  ok(!labels(s).includes("Hidden State"), "a hidden listbox is not discovered");
  ok((s.fields ?? []).length === 1, `only the real control is kept (got ${(s.fields ?? []).length})`);
}

// ---- 3b. an OPEN dropdown does not become thirty new questions -------
// This is the Greenhouse regression: an opened country list turned every
// option into a field, one labelled "Australia" with a label-only
// selector that matched 30 controls.
{
  const s = await snap(`
    <div id="cl">Country</div>
    <button data-automation-id="country" aria-haspopup="listbox" aria-labelledby="cl">Select</button>
    <ul role="listbox">
      <li role="option" aria-label="Australia">Australia</li>
      <li role="option" aria-label="Austria">Austria</li>
      <li role="option" aria-label="United States">United States</li>
    </ul>`);
  ok(!labels(s).includes("Australia"), "an option in an open list is not a field");
  ok(!labels(s).includes("United States"), "no option becomes a field");
  ok(labels(s).includes("Country"), "the trigger itself is still discovered");
  ok((s.fields ?? []).length === 1, `an open dropdown is one question (got ${(s.fields ?? []).length})`);
}

// ---- 3c. a widget with no targetable identity is skipped -------------
{
  const s = await snap(`
    <div role="combobox" aria-label="Australia">Australia</div>
    <label for="c2">City</label><input id="c2" name="city">`);
  ok(!labels(s).includes("Australia"),
     "aria-label alone is not identity: a label-only selector is what matched 30 controls");
  ok((s.fields ?? []).length === 1, "only the identifiable control is kept");
}

// ---- 4. a plain native form is completely unchanged -------------------
{
  const s = await snap(`
    <label for="f">First Name</label><input id="f" name="first">
    <label for="l">Last Name</label><input id="l" name="last">
    <label for="s">State</label>
    <select id="s" name="state"><option>Ohio</option></select>
    <label for="r">Resume</label><input id="r" name="resume" type="file">`);
  ok((s.fields ?? []).length === 4, `native forms are unaffected (got ${(s.fields ?? []).length})`);
  ok(find(s, "State")?.htmlType === "select", "a real select is still a select");
  ok(labels(s).includes("Resume"), "the hidden file input exemption still holds");
}

// ---- 5. the selector actually resolves on the page --------------------
{
  await page.setContent(`<body><div id="l">State</div>
    <button data-automation-id="countryRegion" aria-haspopup="listbox" aria-labelledby="l">Select One</button></body>`);
  const s = await snapshotLive(page.mainFrame() as any);
  const sel = String(find(s, "State")?.selector ?? "");
  ok(sel.length > 0, "a selector was produced");
  ok(await page.locator(sel).count() === 1, `the recorded selector resolves to exactly one element (${sel})`);
}

await browser.close();
console.log(`${n - bad}/${n} assertions passed`);
process.exit(bad ? 1 : 0);
