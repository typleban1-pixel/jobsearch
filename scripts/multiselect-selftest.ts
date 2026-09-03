/**
 * A multi-select is one question rendered as many controls. Getting that
 * wrong put "Australia" forward as a question with a selector matching 30
 * elements; getting the option mapping wrong would put a different
 * country on a real application.
 */
import { chromium } from "playwright";
import { snapshotLive } from "../lib/browser/liveSnapshot.ts";
import { matchCountryOption, matchesAnticipatedWorkCountry, ANTICIPATED_WORK_COUNTRY }
  from "../lib/applications/workCountry.ts";

let n = 0, bad = 0;
const ok = (c: boolean, what: string) => { n++; if (!c) { bad++; console.error(`FAIL ${what}`); } };

// Stripe's real list.
const STRIPE = ["Australia","Belgium","Brazil","Canada","France","Germany","India","Indonesia",
  "Ireland","Israel","Italy","Japan","Luxembourg","Malaysia","Mexico","New Zealand","Poland",
  "Portugal","Romania","Singapore","South Korea","Spain","Sweden","Switzerland","Taiwan",
  "Thailand","The Netherlands","UAE","UK","US"];

// ---- 1. the answer maps to the employer's own spelling ---------------
{
  const m = matchCountryOption(STRIPE, ANTICIPATED_WORK_COUNTRY);
  ok(m.ok, "United States resolves against a list that spells it US");
  ok(m.ok && m.option === "US", `the exact option is US (got ${m.ok ? m.option : "-"})`);
  ok(!m.ok || m.how.includes("country name"), "and it says how it matched");
}
ok(matchCountryOption(STRIPE, "US").ok, "the abbreviation matches itself exactly");
{
  const uk = matchCountryOption(STRIPE, "United Kingdom");
  ok(uk.ok && uk.option === "UK", "United Kingdom maps to UK, not to US");
  const ae = matchCountryOption(STRIPE, "United Arab Emirates");
  ok(ae.ok && ae.option === "UAE", "United Arab Emirates maps to UAE");
  const nl = matchCountryOption(STRIPE, "Netherlands");
  ok(nl.ok && nl.option === "The Netherlands", "Netherlands maps to The Netherlands");
}

// ---- 2. it fails closed rather than approximating --------------------
{
  const none = matchCountryOption(STRIPE, "Norway");
  ok(!none.ok, "a country not offered does not resolve");
  ok(!none.ok && none.candidates.length === 30, "and the full list is reported for a person to read");
  ok(!matchCountryOption([], "United States").ok, "an empty option list fails closed");
  const dupe = matchCountryOption(["US", "US", "Canada"], "United States");
  ok(!dupe.ok, "two identical options are an ambiguity, not a tie to break");
}
// Never substring: "Ireland" must not answer for "Northern Ireland".
{
  const m = matchCountryOption(["Northern Ireland", "Iceland"], "Ireland");
  ok(!m.ok, "Ireland does not match Northern Ireland by containment");
  const m2 = matchCountryOption(["Taiwan, China"], "China");
  ok(!m2.ok, "China does not match Taiwan, China by containment");
}

// ---- 3. the question boundary ----------------------------------------
const covered = (t: string) => ok(matchesAnticipatedWorkCountry(t).covered, `COVERED: ${t}`);
const not = (t: string) => ok(!matchesAnticipatedWorkCountry(t).covered, `NOT COVERED: ${t}`);
covered("Please select the country or countries you anticipate working in for the role in which you are applying.");
covered("In which country do you anticipate working?");
covered("Which countries do you expect to work in?");
covered("What country do you plan to work from?");
not("Please select the country where you currently reside.");
not("Are you authorized to work in the location(s) you selected?");
not("Will you require Stripe to sponsor you for a work permit now or in the future?");
not("What is your country of citizenship?");
not("What is your nationality?");
not("Are you willing to travel internationally?");
not("Do you require a visa to work in this country?");
not("Are you willing to relocate?");
not("First Name");
not("");

// ---- 4. the live DOM shape, collapsed correctly ----------------------
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
const snap = async (html: string) => { await page.setContent(`<body>${html}</body>`); return await snapshotLive(page.mainFrame() as any); };
{
  const boxes = STRIPE.map((c, i) =>
    `<div class="checkbox__wrapper"><input type="checkbox" id="q[]_${i}" name="q[]" value="${700 + i}">
     <label for="q[]_${i}">${c}</label></div>`).join("");
  const s: any = await snap(`<fieldset><legend>Please select the country or countries you anticipate working in.</legend>${boxes}</fieldset>`);
  const f = s.fields.find((x: any) => x.key === "q[]");
  ok(s.fields.length === 1, `thirty checkboxes are one question (got ${s.fields.length})`);
  ok(Boolean(f), "the group is present");
  ok(f?.label?.startsWith("Please select the country"), `the label is the legend, not an option (got ${f?.label})`);
  ok(f?.label !== "Australia", "the first option's label never becomes the question");
  ok(f?.htmlType === "checkbox-group", "it reports as a checkbox group");
  ok((f?.options ?? []).length === 30, `all options are carried (got ${(f?.options ?? []).length})`);
  ok(Boolean(f?.optionSelectors?.["US"]), "US has a selector of its own");
  const sel = f.optionSelectors["US"];
  ok(await page.locator(sel).count() === 1, `the US selector resolves to exactly one control (${sel})`);
  ok(await page.locator(f.selector).count() === 30, "the group selector still reaches all 30, which is why it is not used to click");
}
// A single lone checkbox is not a group.
{
  const s: any = await snap(`<input type="checkbox" id="agree" name="agree"><label for="agree">I agree</label>`);
  ok(s.fields.length === 1 && s.fields[0].htmlType === "checkbox",
     `a lone checkbox stays a checkbox (got ${s.fields[0]?.htmlType})`);
}

await browser.close();
console.log(`${n - bad}/${n} assertions passed`);
process.exit(bad ? 1 : 0);
