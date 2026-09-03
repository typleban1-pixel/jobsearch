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

// ---- the Stripe phone widget: a container mistaken for one input -----
// A bare input with no label of its own falls through to the whole
// personal-information card as its "label", arriving as a 2+-asterisk
// blob that (a) can never be answered and (b) contains "Country", which
// made the real telephone input read it as a dial-code dependency and
// refuse to fill. The blob must be dropped; the real controls must stay.
{
  const s: any = await snap(`
    <div>
      <label for="fn">First Name*</label><input id="fn" name="fn" />
      <label for="em">Email*</label><input id="em" name="em" />
      <label for="country">Phone Country*</label><input id="country" name="country" />
      <label for="phone">Phone*</label><input id="phone" name="phone" type="tel" />
    </div>
    <input />`);
  const blob = s.fields.filter((f: any) => String(f.label || "").length > 40 || (String(f.label||"").match(/\*/g)||[]).length >= 2);
  ok(blob.length === 0, `the container blob is dropped (got ${blob.length}: ${JSON.stringify(blob.map((b:any)=>String(b.label).slice(0,30)))})`);
  ok(s.fields.some((f: any) => f.selector === "#phone" && f.htmlType === "tel"), "the real telephone input survives");
  ok(s.fields.some((f: any) => f.selector === "#country"), "the real dial-code control survives");
}

// ---- a real, long question with a strong selector is NEVER dropped ---
// "Please select the country or countries you anticipate working in..."
// is a legitimate question reached by id; only label-only blobs go.
{
  const long = "Please select the country or countries you anticipate working in for the next twelve months.";
  const s: any = await snap(`<label for="q1">${long}</label><input id="q1" name="q1" />`);
  ok(s.fields.some((f: any) => f.selector === "#q1"), "a long question with a real selector is kept");
}

await browser.close();
console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
