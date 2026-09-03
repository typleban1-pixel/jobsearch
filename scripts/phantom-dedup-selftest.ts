/**
 * The Samsara location field was discovered TWICE: once as its real
 * react-select input (#candidate-location, id selector) and once as a
 * phantom with only a label selector that getByLabel could not resolve.
 * The main fill filled the real one, then hit the phantom, whose
 * selector matched zero, and stopped the whole submission at Location
 * (City) -- six fields in, resume already uploaded, before any Submit.
 *
 * Verified against the live Samsara form's real discovery.
 */
import { chromium } from "playwright";
import { snapshotLive } from "../lib/browser/liveSnapshot.ts";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
const snap = async (html: string) => { await page.setContent(`<body>${html}</body>`); return await snapshotLive(page.mainFrame() as any); };

// ---- the exact shape: a real input plus a label-only phantom ---------
{
  // Two controls that discovery labels identically: one with an id, one
  // that is a bare labelled container with no id/name.
  const s: any = await snap(`
    <label for="candidate-location">Location (City)</label>
    <input id="candidate-location" role="combobox" />
    <div aria-label="Location (City)" role="combobox">Cleveland, Ohio, United States</div>`);
  const loc = s.fields.filter((f: any) => f.label === "Location (City)");
  ok(loc.length === 1, `the phantom is dropped, one Location field remains (got ${loc.length})`);
  ok(loc[0]?.selectorKind !== "label", "the surviving field keeps the strong (id) selector");
  ok(loc[0]?.selector === "#candidate-location", `and it is the real input (${loc[0]?.selector})`);
}

// ---- two genuinely different fields are BOTH kept --------------------
{
  const s: any = await snap(`
    <label for="a">First Name</label><input id="a" name="firstA" />
    <label for="b">Last Name</label><input id="b" name="lastB" />`);
  ok(s.fields.length === 2, "distinct fields with distinct labels are untouched");
}

// ---- same label but BOTH strong selectors: keep both (do not guess) --
{
  const s: any = await snap(`
    <label for="p1">Phone</label><input id="p1" name="home" />
    <label for="p2">Phone</label><input id="p2" name="mobile" />`);
  const phones = s.fields.filter((f: any) => f.label === "Phone");
  ok(phones.length === 2, "two same-labelled fields that BOTH have strong selectors are both kept");
}

// ---- a lone label-only field is never dropped -----------------------
// A textarea discovered by its wrapping label, with no strong sibling
// sharing that label: dedup must not touch it (group size 1).
{
  const s: any = await snap(`<label>Additional details<textarea></textarea></label>`);
  const df = s.fields.filter((f: any) => /Additional details/.test(f.label));
  ok(df.length === 1, "a lone field is kept, whatever its selector kind (dedup never drops a group of one)");
}

await browser.close();
console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
