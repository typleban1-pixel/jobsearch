/**
 * dropContainerBlobs, tested with the real fields captured from Stripe's
 * live Greenhouse form. The phone widget's internal <input> resolved its
 * label to the whole personal-information card -- a 299-character,
 * seven-asterisk blob reached only by a label selector -- which arrived
 * as an unanswerable required field AND, because the blob contains
 * "Country", made the real telephone input refuse to fill. Pure and
 * offline: no browser, so it runs anywhere.
 */
import { dropContainerBlobs } from "../lib/browser/liveSnapshot.ts";
import type { LiveField } from "../lib/browser/liveSnapshot.ts";

let n = 0, bad = 0;
const ok = (c: boolean, w: string) => { n++; if (!c) { bad++; console.error(`FAIL ${w}`); } };

const f = (o: Partial<LiveField>): LiveField => ({
  key: o.label ?? "", label: "", selector: "", selectorKind: "id", unlabelled: false,
  groupKey: null, htmlType: "text", associated: [], options: [], required: false, ...o,
} as LiveField);

// The exact live capture: real controls (id/name selectors) + the blob.
const BLOB = "First Name* Last Name* Preferred First Name Email* Phone Country* Phone* Location (City)* Locate me Resume/CV* Attach Attach Dropbox Enter manually Enter manually Accepted file types: pdf, doc, docx, txt, rtf Cover Letter Attach Attach Dropbox Enter manually Enter manually Accepted file types: pdf,";
const fields: LiveField[] = [
  f({ label: "First Name", selector: "#first_name", selectorKind: "id" }),
  f({ label: "Email", selector: "#email", selectorKind: "id" }),
  f({ label: "Country", selector: "#country", selectorKind: "id", groupKey: "Phone" }),
  f({ label: "Phone", selector: "#phone", selectorKind: "id", htmlType: "tel", groupKey: "Phone" }),
  f({ label: BLOB, selector: BLOB.slice(0, 70), selectorKind: "label", htmlType: "input" }),
];

const out = dropContainerBlobs(fields);
ok(!out.some((x) => x.label === BLOB), "the 299-char blob phantom is dropped");
ok(out.some((x) => x.selector === "#phone" && x.htmlType === "tel"), "the real telephone input survives");
ok(out.some((x) => x.selector === "#country"), "the real dial-code control survives");
ok(out.length === 4, `exactly the four real controls remain (got ${out.length})`);

// Signal 1: two required-asterisks on a label-only field is enough.
ok(dropContainerBlobs([f({ label: "A* B*", selectorKind: "label" })]).length === 0,
  "a label-only field with two required markers is dropped");

// Signal 2: a label-only field literally containing two other real
// controls' labels is a container, even with no asterisks.
{
  const set = [
    f({ label: "Salary", selector: "#salary", selectorKind: "id" }),
    f({ label: "Start Date", selector: "#start", selectorKind: "id" }),
    f({ label: "Salary Start Date extra", selectorKind: "label" }),
  ];
  ok(dropContainerBlobs(set).length === 2, "a label-only field containing two real labels is dropped");
}

// Never drops a real control: a long question reached by a strong selector.
{
  const long = "Please select the country or countries you anticipate working in for the next twelve months. *";
  ok(dropContainerBlobs([f({ label: long, selector: "#q1", selectorKind: "id" })]).length === 1,
    "a long, asterisked question with a real id selector is kept");
}

// A single required marker is a normal field, not a blob.
ok(dropContainerBlobs([f({ label: "Email *", selectorKind: "label" })]).length === 1,
  "one required marker on a label-only field is kept");

// ---- the School react-select echo phantoms (Rule B) ------------------
// Real School (#school--0, htmlType text) plus the widget's value/
// placeholder echoes, which arrive as bare typeless <input>s reachable
// only by their text: "School* Select…" before selection, "School*
// option … selected" after. Both must go; the real control stays.
{
  const set = [
    f({ label: "School", selector: "#school--0", selectorKind: "id", htmlType: "text", required: true }),
    f({ label: "Degree", selector: "#degree--0", selectorKind: "id", htmlType: "text", required: true }),
    f({ label: "School* Select...", selectorKind: "label", htmlType: "input", required: true }),
    f({ label: "School* option Western Governors University, selected. Western Governors University", selectorKind: "label", htmlType: "input", required: true }),
  ];
  const out = dropContainerBlobs(set);
  ok(out.length === 2, `both School echoes dropped, real School+Degree kept (got ${out.length})`);
  ok(out.some((x) => x.selector === "#school--0"), "the real School control survives");
  ok(!out.some((x) => String(x.label).includes("Select...") || String(x.label).includes("option Western")), "no School echo remains");
}

// Rule B is gated on htmlType "input": a REAL typed field whose label
// happens to start with another field's label is never dropped.
{
  const set = [
    f({ label: "School", selector: "#school", selectorKind: "id", htmlType: "text" }),
    f({ label: "School District Name", selector: "", selectorKind: "label", htmlType: "text" }),
  ];
  ok(dropContainerBlobs(set).length === 2, "a real typed field with a prefix-matching label is kept (htmlType gate)");
}

// A lone label-only field with no aggregation signal is kept.
ok(dropContainerBlobs([f({ label: "Additional details", selectorKind: "label" })]).length === 1,
  "a plain label-only field is kept");

console.log(`${n - bad}/${n} assertions passed`);
process.exit(bad ? 1 : 0);
