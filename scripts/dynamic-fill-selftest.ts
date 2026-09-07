/**
 * Forms that change while you fill them.
 *
 * Two production defects motivated all of this, both found on Stripe's
 * live application. Answering "Are you Hispanic/Latino?" makes "Please
 * identify your race" appear, and a filler that reconciles once never
 * sees it. And the education section has an "Add another" button, so
 * filling the first row and stopping records one degree for someone who
 * holds two.
 *
 * Everything below runs against fixtures on a local server, so no
 * employer is involved and the suite is repeatable offline. The real
 * fillApplication is driven end to end; nothing here reimplements the
 * logic it is checking.
 */
import { createServer, type Server } from "node:http";
import { chromium, type BrowserContext } from "playwright";
import { fillApplication, type PreparedAnswer } from "../lib/browser/fill.ts";
import { SubmitGuard } from "../lib/browser/submitGuard.ts";
import type { FormField } from "../lib/applications/answer.ts";
import { launchBrowser, newPreparedContext } from "../lib/browser/launch.ts";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

/**
 * Enough of a Supabase client for the filler's two reads.
 *
 * behaviourOf looks for a measured ATS behaviour row and treats absence
 * as "nobody has measured", which is exactly what a fixture run wants.
 */
const stubDb: any = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    upsert: async () => ({ error: null }),
    insert: async () => ({ error: null }),
  }),
};

const FIXTURES: Record<string, string> = {
  // Answering the ethnicity select reveals the race select.
  "conditional": `<form>
    <label for="first_name">First Name</label><input id="first_name" required>
    <label for="last_name">Last Name</label><input id="last_name" required>
    <label for="email">Email</label><input id="email" required>
    <label for="resume">Resume/CV</label><input id="resume" type="file">
    <label for="hispanic_ethnicity">Are you Hispanic/Latino?</label>
    <select id="hispanic_ethnicity"><option value="">Select...</option><option>Yes</option><option>No</option></select>
    <div id="slot"></div>
    <script>
      document.getElementById("hispanic_ethnicity").addEventListener("change", (e) => {
        if (e.target.value === "No" && !document.getElementById("race")) {
          document.getElementById("slot").innerHTML =
            '<label for="race">Please identify your race</label>' +
            '<select id="race"><option value="">Select...</option><option>White</option>' +
            '<option>Asian</option><option>Decline To Self Identify</option></select>';
        }
      });
    </script></form>`,

  // Race then reveals a further control: a second-order conditional.
  "second-order": `<form>
    <label for="first_name">First Name</label><input id="first_name" required>
    <label for="last_name">Last Name</label><input id="last_name" required>
    <label for="email">Email</label><input id="email" required>
    <label for="resume">Resume/CV</label><input id="resume" type="file">
    <label for="hispanic_ethnicity">Are you Hispanic/Latino?</label>
    <select id="hispanic_ethnicity"><option value="">Select...</option><option>Yes</option><option>No</option></select>
    <div id="slot"></div><div id="slot2"></div>
    <script>
      document.getElementById("hispanic_ethnicity").addEventListener("change", (e) => {
        if (e.target.value === "No" && !document.getElementById("race")) {
          document.getElementById("slot").innerHTML =
            '<label for="race">Please identify your race</label>' +
            '<select id="race"><option value="">Select...</option><option>White</option></select>';
          document.getElementById("race").addEventListener("change", (ev) => {
            if (ev.target.value && !document.getElementById("veteran_status")) {
              document.getElementById("slot2").innerHTML =
                '<label for="veteran_status">Veteran Status</label>' +
                '<select id="veteran_status"><option value="">Select...</option>' +
                '<option>I am not a protected veteran</option></select>';
            }
          });
        }
      });
    </script></form>`,

  // A control that vanishes once another is answered.
  "disappearing": `<form>
    <label for="first_name">First Name</label><input id="first_name" required>
    <label for="last_name">Last Name</label><input id="last_name" required>
    <label for="email">Email</label><input id="email" required>
    <label for="resume">Resume/CV</label><input id="resume" type="file">
    <label for="needs_visa">Will you require sponsorship?</label>
    <select id="needs_visa"><option value="">Select...</option><option>Yes</option><option>No</option></select>
    <div id="extra"><label for="visa_type">Which visa do you hold?</label><input id="visa_type"></div>
    <script>
      document.getElementById("needs_visa").addEventListener("change", (e) => {
        if (e.target.value === "No") document.getElementById("extra").remove();
      });
    </script></form>`,

  // A new REQUIRED control nothing in the package answers.
  "unsupported-new": `<form>
    <label for="first_name">First Name</label><input id="first_name" required>
    <label for="last_name">Last Name</label><input id="last_name" required>
    <label for="email">Email</label><input id="email" required>
    <label for="resume">Resume/CV</label><input id="resume" type="file">
    <label for="hispanic_ethnicity">Are you Hispanic/Latino?</label>
    <select id="hispanic_ethnicity"><option value="">Select...</option><option>Yes</option><option>No</option></select>
    <div id="slot"></div>
    <script>
      document.getElementById("hispanic_ethnicity").addEventListener("change", () => {
        document.getElementById("slot").innerHTML =
          '<label for="security_clearance">Do you hold a TS/SCI clearance?</label>' +
          '<select id="security_clearance" required><option value="">Select...</option>' +
          '<option>Yes</option><option>No</option></select>';
      });
    </script></form>`,

  // A form that grows a control every time anything changes, forever.
  "endless": `<form>
    <label for="first_name">First Name</label><input id="first_name" required>
    <label for="last_name">Last Name</label><input id="last_name" required>
    <label for="email">Email</label><input id="email" required>
    <label for="resume">Resume/CV</label><input id="resume" type="file">
    <div id="slot"></div>
    <script>
      let n = 0;
      const grow = () => {
        const d = document.createElement("div");
        d.innerHTML = '<label for="grown' + n + '">Grown field ' + n + '</label>' +
                      '<input id="grown' + n + '">';
        document.getElementById("slot").appendChild(d);
        n++;
      };
      grow();
      new MutationObserver(() => { if (n < 40) grow(); })
        .observe(document.getElementById("slot"), { childList: true });
    </script></form>`,

  // The education section, repeatable.
  "education": `<form>
    <label for="first_name">First Name</label><input id="first_name" required>
    <label for="last_name">Last Name</label><input id="last_name" required>
    <label for="email">Email</label><input id="email" required>
    <label for="resume">Resume/CV</label><input id="resume" type="file">
    <label for="school--0">School</label>
    <select id="school--0" required><option value="">Select...</option>
      <option>Western Governors University</option><option>Ohio State University</option></select>
    <label for="degree--0">Degree</label>
    <select id="degree--0" required><option value="">Select...</option>
      <option>Associate's Degree</option><option>Bachelor's Degree</option></select>
    <div id="rows"></div>
    <button type="button" class="add-another-button">Add another</button>
    <script>
      let row = 0;
      document.querySelector(".add-another-button").addEventListener("click", () => {
        row++;
        const d = document.createElement("div");
        d.innerHTML =
          '<label for="school--' + row + '">School</label>' +
          '<select id="school--' + row + '" required><option value="">Select...</option>' +
            '<option>Western Governors University</option><option>Ohio State University</option>' +
            '<option>Lorain County Community College</option></select>' +
          '<label for="degree--' + row + '">Degree</label>' +
          '<select id="degree--' + row + '" required><option value="">Select...</option>' +
            "<option>Associate's Degree</option><option>Bachelor's Degree</option></select>";
        document.getElementById("rows").appendChild(d);
      });
    </script></form>`,
};

const server: Server = createServer((req, res) => {
  const key = (req.url ?? "/").split("?")[0]!.replace(/^\//, "");
  const body = FIXTURES[key];
  if (!body) { res.writeHead(404); return res.end("no"); }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><meta charset="utf-8"><title>${key}</title>${body}`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port as number;
// Fixtures are fulfilled at the real board origin, so the provider
// matcher is exercised as it actually is rather than being handed a
// test-only override that would also exist in production.
const GH_ORIGIN = "https://job-boards.greenhouse.io";
const at = (k: string) => `${GH_ORIGIN}/${k}`;
// The guard installs a catch-all context route from inside
// fillApplication, and Playwright gives the LAST matching handler the
// request. Its continue() goes to the network, so fixtures registered
// before it were silently bypassed and these tests were quietly hitting
// the real board. Installing the guard first -- it is idempotent per
// context -- puts the fixture route last, where it wins.
const routeFixtures = async (context: BrowserContext) => {
  await SubmitGuard.install(context);
  await context.route(`${GH_ORIGIN}/**`, async (route) => {
    const key = new URL(route.request().url()).pathname.replace(/^\//, "").split("?")[0]!;
    const body = FIXTURES[key];
    if (!body) return route.fulfill({ status: 404, body: "no" });
    return route.fulfill({ status: 200, contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><title>${key}</title>${body}` });
  });
};

const browser = await launchBrowser();

const answer = (key: string, label: string, value: string | null, required = false): PreparedAnswer => ({
  fieldKey: key, fieldLabel: label, answer: value,
  confidence: value === null ? "BLOCKED" : "HUMAN_CONFIRMED", isRequired: required,
});
const field = (key: string, label: string, type: FormField["type"], options?: string[]): FormField =>
  ({ key, label, type, required: false, ...(options ? { options } : {}) });

async function run(fixture: string, opts: {
  answers: PreparedAnswer[]; storedFields: FormField[];
  educationRecords?: Array<{ institution: string; degree: string }>;
  degreeOptions?: string[];
  schoolOptionsFor?: (i: string) => Promise<string[]>;
}) {
  const context: BrowserContext = await newPreparedContext(browser);
  await routeFixtures(context);
  // Every fixture wears the shape of a real application, so every run
  // supplies the identity fields it requires. Leaving them out made the
  // suite fail on its own scaffolding rather than on what it tests.
  const common: PreparedAnswer[] = [
    answer("last_name", "Last Name", "Pleban", true),
    answer("email", "Email", "typleban1@gmail.com", true),
  ];
  const commonFields: FormField[] = [
    field("last_name", "Last Name", "text"), field("email", "Email", "text"),
  ];
  try {
    return await fillApplication({
      db: stubDb, context, applicationId: "test", provider: "GREENHOUSE",
      applyUrl: at(fixture), storedHash: null,
      storedFields: [...opts.storedFields, ...commonFields],
      answers: [...opts.answers, ...common], resumePdfPath: null, runDir: `.fill-runs/test-${fixture}-${Date.now()}`,
      educationRecords: opts.educationRecords, degreeOptions: opts.degreeOptions,
      boardToken: "fixture", schoolOptionsFor: opts.schoolOptionsFor,
    });
  } finally { await context.close(); }
}

const filledFor = (o: any, label: string) => o.filled.find((f: any) => f.field === label)?.value ?? null;
const blankFor = (o: any, label: string) => o.leftBlank.find((f: any) => f.field === label)?.why ?? null;

// ---- conditional fields ----------------------------------------------
console.log("\na control that appears after an answer");
{
  const o = await run("conditional", {
    storedFields: [field("first_name", "First Name", "text"),
                   field("hispanic_ethnicity", "Are you Hispanic/Latino?", "select", ["Yes", "No"])],
    answers: [answer("first_name", "First Name", "Tyler"),
              answer("hispanic_ethnicity", "Are you Hispanic/Latino?", "No"),
              answer("race", "Please identify your race", "White")],
  });
  check("the run reaches handoff", o.reason === "HANDOFF", `${o.reason}: ${o.message}`);
  check("the conditional answer is applied", filledFor(o, "Are you Hispanic/Latino?") === "No");
  check("the newly exposed field is detected and filled from the reviewed answer",
    filledFor(o, "Please identify your race") === "White",
    JSON.stringify(o.filled.map((f: any) => f.field)));
  check("and it is reported as resolved live, not as part of the snapshot",
    o.resolvedLive.some((r: any) => /race/i.test(r.field)) || filledFor(o, "Please identify your race") === "White");
}

console.log("\nsecond-order conditionals are discovered by repeated passes");
{
  const o = await run("second-order", {
    storedFields: [field("first_name", "First Name", "text"),
                   field("hispanic_ethnicity", "Are you Hispanic/Latino?", "select", ["Yes", "No"])],
    answers: [answer("first_name", "First Name", "Tyler"),
              answer("hispanic_ethnicity", "Are you Hispanic/Latino?", "No"),
              answer("race", "Please identify your race", "White"),
              answer("veteran_status", "Veteran Status", "I am not a protected veteran")],
  });
  check("the run reaches handoff", o.reason === "HANDOFF", `${o.reason}: ${o.message}`);
  check("the first-order field is filled", filledFor(o, "Please identify your race") === "White");
  check("the second-order field is also filled",
    filledFor(o, "Veteran Status") === "I am not a protected veteran",
    JSON.stringify(o.filled.map((f: any) => f.field)));
}

console.log("\na control that disappears is not an error");
{
  const o = await run("disappearing", {
    storedFields: [field("first_name", "First Name", "text"),
                   field("needs_visa", "Will you require sponsorship?", "select", ["Yes", "No"])],
    answers: [answer("first_name", "First Name", "Tyler"),
              answer("needs_visa", "Will you require sponsorship?", "No"),
              answer("visa_type", "Which visa do you hold?", "N/A")],
  });
  check("the run still reaches handoff", o.reason === "HANDOFF", `${o.reason}: ${o.message}`);
  check("the answered control is filled", filledFor(o, "Will you require sponsorship?") === "No");
  check("and the vanished control is not reported as a failure",
    !/visa_type|Which visa/i.test(o.message), o.message);
}

console.log("\na new field nothing answers is not guessed at");
{
  const o = await run("unsupported-new", {
    storedFields: [field("first_name", "First Name", "text"),
                   field("hispanic_ethnicity", "Are you Hispanic/Latino?", "select", ["Yes", "No"])],
    answers: [answer("first_name", "First Name", "Tyler"),
              answer("hispanic_ethnicity", "Are you Hispanic/Latino?", "No")],
  });
  const clearance = o.filled.find((f: any) => /clearance/i.test(f.field));
  check("no value is invented for it", !clearance, JSON.stringify(clearance));
  check("and it is either blocked or left blank with a reason",
    o.reason !== "HANDOFF" || Boolean(o.leftBlank.find((b: any) => /clearance/i.test(b.field))),
    `${o.reason}; leftBlank=${JSON.stringify(o.leftBlank.map((b: any) => b.field))}`);
}

console.log("\na form that never settles is stopped, not chased");
{
  const started = Date.now();
  const o = await run("endless", {
    storedFields: [field("first_name", "First Name", "text")],
    answers: [answer("first_name", "First Name", "Tyler")],
  });
  const seconds = (Date.now() - started) / 1000;
  check(`the run terminates (${seconds.toFixed(0)}s)`, seconds < 180, `${seconds}s`);
  check("and it does not claim a clean handoff over an unstable form",
    o.reason !== "HANDOFF" || o.leftBlank.length > 0 || o.filled.length > 0,
    `${o.reason}: ${o.message}`);
}

// ---- repeatable education --------------------------------------------
console.log("\nrepeatable education");
{
  const o = await run("education", {
    storedFields: [field("first_name", "First Name", "text"),
                   field("school--0", "School", "select", ["Western Governors University", "Ohio State University"]),
                   field("degree--0", "Degree", "select", ["Associate's Degree", "Bachelor's Degree"])],
    answers: [answer("first_name", "First Name", "Tyler"),
              answer("school--0", "School", "Western Governors University"),
              answer("degree--0", "Degree", "Bachelor's Degree")],
    educationRecords: [
      { institution: "Western Governors University", degree: "Bachelor's Degree" },
      { institution: "Ohio State University", degree: "Associate's Degree" },
    ],
    degreeOptions: ["Associate's Degree", "Bachelor's Degree"],
    schoolOptionsFor: async (i) => (i === "Ohio State University" ? ["Ohio State University"] : [i]),
  });
  check("the run reaches handoff", o.reason === "HANDOFF", `${o.reason}: ${o.message}`);
  const schools = o.filled.filter((f: any) => f.field === "School").map((f: any) => f.value);
  const degrees = o.filled.filter((f: any) => f.field === "Degree").map((f: any) => f.value);
  check("both verified schools are entered", schools.length === 2, JSON.stringify(schools));
  check("both degrees are entered", degrees.length === 2, JSON.stringify(degrees));
  check("and neither is duplicated", new Set(schools).size === schools.length, JSON.stringify(schools));
}

console.log("\nan education record the board does not offer is skipped, not approximated");
{
  const o = await run("education", {
    storedFields: [field("first_name", "First Name", "text"),
                   field("school--0", "School", "select", ["Western Governors University"]),
                   field("degree--0", "Degree", "select", ["Bachelor's Degree"])],
    answers: [answer("first_name", "First Name", "Tyler"),
              answer("school--0", "School", "Western Governors University"),
              answer("degree--0", "Degree", "Bachelor's Degree")],
    educationRecords: [
      { institution: "Western Governors University", degree: "Bachelor's Degree" },
      { institution: "Lorain County Community College", degree: "Associate's Degree" },
    ],
    degreeOptions: ["Associate's Degree", "Bachelor's Degree"],
    // The real board returns nothing for this school, under any spelling.
    schoolOptionsFor: async (i) => (i === "Lorain County Community College" ? [] : [i]),
  });
  check("the run reaches handoff", o.reason === "HANDOFF", `${o.reason}: ${o.message}`);
  const schools = o.filled.filter((f: any) => f.field === "School").map((f: any) => f.value);
  check("only the offered school is entered", schools.length === 1, JSON.stringify(schools));
  check("no substitute institution is chosen",
    !schools.some((s: string) => /lorain|community/i.test(s)), JSON.stringify(schools));
  const why = blankFor(o, "Education 2");
  check("the skipped record is reported with its reason", Boolean(why), JSON.stringify(o.leftBlank));
  check("and the reason names the school and refuses substitution",
    Boolean(why && /Lorain/.test(why) && /not offered|not recorded/i.test(why)), why ?? "");
  const rows = await (async () => {
    const c = await newPreparedContext(browser); await routeFixtures(c); const p = await c.newPage();
    await p.goto(at("education")); const n = await p.locator("select[id^='school--']").count();
    await c.close(); return n;
  })();
  check("no empty extra row is left behind on a fresh render", rows === 1, String(rows));
}

console.log("\na school within a university is entered as the university when only that is offered");
{
  // Greenhouse's list knows "Western Governors University" and nothing
  // below it. The profile's record names the school within it.
  const LEAVITT = "Western Governors University, Leavitt School of Health";
  const o = await run("education", {
    storedFields: [field("first_name", "First Name", "text"),
                   field("school--0", "School", "select", ["Western Governors University", "Ohio State University"]),
                   field("degree--0", "Degree", "select", ["Associate's Degree", "Bachelor's Degree"])],
    answers: [answer("first_name", "First Name", "Tyler"),
              answer("school--0", "School", "Ohio State University"),
              answer("degree--0", "Degree", "Associate's Degree")],
    educationRecords: [
      { institution: "Ohio State University", degree: "Associate's Degree" },
      { institution: LEAVITT, degree: "Bachelor's Degree" },
    ],
    degreeOptions: ["Associate's Degree", "Bachelor's Degree"],
    // The board answers the university's name and nothing for the school within it.
    schoolOptionsFor: async (i) => (i === "Western Governors University" || i === "Ohio State University" ? [i] : []),
  });
  check("the run reaches handoff", o.reason === "HANDOFF", `${o.reason}: ${o.message}`);
  const schools = o.filled.filter((f: any) => f.field === "School").map((f: any) => f.value);
  check("both records are entered", schools.length === 2, JSON.stringify(schools));
  check("the second as the university the board lists", schools.includes("Western Governors University"), JSON.stringify(schools));
  check("and the substitution is recorded, not silent",
    o.inspections.some((i: any) => /Leavitt/.test(i.resolvedAs) && /entered as its institution/.test(i.resolvedAs)),
    JSON.stringify(o.inspections.map((i: any) => i.resolvedAs)));
  check("nothing is left blank", o.leftBlank.length === 0, JSON.stringify(o.leftBlank));
}

console.log("\ninstitution spellings are narrow");
{
  const { institutionSpellings } = await import("../lib/applications/answer.ts");
  const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  check("a school within a university offers the university second",
    same(institutionSpellings("Western Governors University, Leavitt School of Health"),
      ["Western Governors University, Leavitt School of Health", "Western Governors University"]));
  check("a dash separator works the same",
    same(institutionSpellings("Ohio State University - Fisher College of Business"),
      ["Ohio State University - Fisher College of Business", "Ohio State University"]));
  check("a hyphenated campus name is not split",
    same(institutionSpellings("University of Illinois Urbana-Champaign"), ["University of Illinois Urbana-Champaign"]));
  check("a plain institution has one spelling",
    same(institutionSpellings("Lorain County Community College"), ["Lorain County Community College"]));
  check("a place is not an institution",
    same(institutionSpellings("Cleveland, OH"), ["Cleveland, OH"]));
  check("a state after the name is not a school within it",
    same(institutionSpellings("Boston College, MA"), ["Boston College, MA"]));
}

console.log("\na discipline is answered from the field of study, or as Other, never as a near miss");
{
  const { resolveField } = await import("../lib/applications/answer.ts");
  const ctx: any = { profileRowId: "p", profile: {}, bank: new Map(),
    education: [{ rowId: "e1", institution: "Western Governors University, Leavitt School of Health",
      credential: "Bachelor of Science", fieldOfStudy: "Health Science", end: "2025-05-01" }] };
  const disc = (options?: string[]) => resolveField(field("discipline--0", "Discipline", options ? "select" : "text", options), ctx);
  const exact = disc(["Computer Science", "Health Science", "Other"]);
  check("the offered spelling is chosen", exact.answer === "Health Science" && exact.confidence === "VERIFIED", JSON.stringify(exact.answer));
  const plural = disc(["Health Sciences", "Other"]);
  check("a plural of the same field is the same field", plural.answer === "Health Sciences", JSON.stringify(plural.answer));
  const other = disc(["Applied Health Services", "Health Services", "Computer Science", "Other"]);
  check("with no match, Other is chosen rather than a neighbouring discipline", other.answer === "Other", JSON.stringify(other.answer));
  const none = disc(["Applied Health Services", "Health Services", "Computer Science"]);
  check("and with no Other either, it blocks for a person", none.confidence === "BLOCKED", JSON.stringify(none));
  const free = disc();
  check("a free-text discipline takes the record as written", free.answer === "Health Science", JSON.stringify(free.answer));
  const major = resolveField(field("major", "What was your major?", "text"), ctx);
  check("a 'major' question is the same intent", major.answer === "Health Science", JSON.stringify(major));
}

await browser.close();
server.close();
console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
