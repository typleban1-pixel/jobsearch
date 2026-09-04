/**
 * The Ashby assisted-preparation path, tested without a browser.
 *
 * snapshotAshbyLive itself needs a live page, so this exercises the pure
 * rules it is built from -- the fail-closed decision, the field mapping,
 * the "is this a form" check -- plus the re-prepare guard and how a parked
 * Ashby row presents on /apply. An optional live leg runs the real snapshot
 * against ASHBY_TEST_URL when one is provided.
 *
 *   node scripts/ashby-prepare-selftest.ts
 *   ASHBY_TEST_URL="https://jobs.ashbyhq.com/<org>/<id>" node scripts/ashby-prepare-selftest.ts
 */
import { decideAshby } from "../lib/browser/ashbyPrepare.ts";
import { looksLikeForm, toFormField, groupAshbyChoices, mergeChoiceGroups, dropFileHeaderArtifacts } from "../lib/browser/ashbyForm.ts";
import { reprepareGuard } from "../lib/applications/reprepareGuard.ts";
import { present, type ApplicationFacts } from "../lib/portal/presentationState.ts";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

const live = (o: Partial<any> = {}): any => ({
  fields: [], widgetHelpers: [], loginWall: false, captcha: false,
  captchaBadgeOnly: false, ssoPrompt: false, formCount: 1, ...o,
});
const field = (o: Partial<any> = {}): any => ({
  key: "k", label: "L", type: "text", required: false, selector: "#k", selectorKind: "id",
  unlabelled: false, groupKey: null, htmlType: "text", associated: [], ...o,
});
const goodForm = live({ fields: [
  field({ key: "_systemfield_name", label: "Name", type: "text", required: true }),
  field({ key: "_systemfield_email", label: "Email", type: "text", required: true }),
  field({ key: "_systemfield_resume", label: "Resume", type: "file", required: true }),
  field({ key: "q_auth", label: "Are you authorized to work in the US?", type: "select", required: true, options: ["Yes", "No"] }),
]});

console.log("decideAshby (fail closed on what we do not support):");
ok(decideAshby(live({ loginWall: true, fields: goodForm.fields }), false).ok === false, "sign-in wall fails closed");
ok(/finished by hand/.test((decideAshby(live({ loginWall: true }), false) as any).reason ?? ""), "  ...and says so honestly");
ok(decideAshby(live({ ssoPrompt: true, fields: goodForm.fields }), false).ok === false, "SSO prompt fails closed");
ok(decideAshby(live({ captcha: true, fields: goodForm.fields }), false).ok === false, "CAPTCHA challenge fails closed");
ok(decideAshby(live({ fields: [field({ label: "" })] }), false).ok === false, "no form found fails closed");
ok(decideAshby(goodForm, true).ok === false, "multi-step fails closed");
ok(/multi-step/.test((decideAshby(goodForm, true) as any).reason ?? ""), "  ...naming multi-step as the reason");
ok(decideAshby(goodForm, false).ok === true, "a public single-page form is accepted");

console.log("\nlooksLikeForm:");
ok(looksLikeForm({ fields: [field({ type: "file" })] }) === true, "a file (resume) control alone is enough");
ok(looksLikeForm({ fields: [field({ label: "a" }), field({ label: "b" })] }) === false, "two labelled fields is not a form");
ok(looksLikeForm({ fields: [field({ label: "a" }), field({ label: "b" }), field({ label: "c" })] }) === true, "three labelled fields is a form");

console.log("\ntoFormField (live field projected onto the form vocabulary):");
const cbg = toFormField(field({ type: "checkbox-group", options: ["X", "Y"] }) as any);
ok(cbg.type === "select" && (cbg.options?.length ?? 0) === 2, "checkbox-group becomes select with its options");
const sel = toFormField(field({ type: "select", options: ["Yes", "No"], required: true }) as any);
ok(sel.type === "select" && sel.required === true && sel.options?.[0] === "Yes", "select keeps options and required");
ok(!("options" in toFormField(field({ type: "text" }) as any)), "a plain text field carries no options key");

console.log("\nreprepareGuard (only a parked live DRAFT is re-preparable):");
const base = { status: "DRAFT", blocked_reason: "parked", prepare_started_at: null, submitted_at: null };
ok(reprepareGuard(base, "ASHBY").ok === true, "parked Ashby DRAFT is re-preparable");
ok(reprepareGuard(base, "LEVER").ok === true, "parked Lever DRAFT is re-preparable");
ok(reprepareGuard(base, "GREENHOUSE").ok === false, "Greenhouse has no browser path -> refused");
ok(reprepareGuard({ ...base, submitted_at: "2026-01-01" }, "ASHBY").ok === false, "a submitted row is never re-prepared");
ok(reprepareGuard({ ...base, status: "AWAITING_REVIEW" }, "ASHBY").ok === false, "a non-DRAFT is refused");
ok(reprepareGuard({ ...base, prepare_started_at: "2026-01-01" }, "ASHBY").ok === false, "a row already being prepared is refused");
ok(reprepareGuard({ ...base, blocked_reason: null }, "ASHBY").ok === false, "a row that is not parked has nothing to re-prepare");

console.log("\npresent() -- how a parked Ashby row reads on /apply:");
const facts = (o: Partial<ApplicationFacts> = {}): ApplicationFacts => ({
  status: "DRAFT", humanApproved: false, allFieldsConfident: false, blockedAnswers: 0,
  discoveredFields: 0, submittedAt: null, confirmationReceived: false, provider: "ASHBY",
  refusals: [], handoff: false, applyUrl: "https://jobs.ashbyhq.com/aleph/x",
  handoffReason: null, submitQueued: false, submitRunning: false, submitOutcome: null,
  activelyPreparing: false, blockedReason: null, ...o,
});
const NOT_SNAPPED = "Ashby does not publish application forms without an employer API key. This form has to be snapshotted locally in the browser before the application can be prepared.";
const CAPTCHA = "a CAPTCHA challenge is displayed on the Ashby apply page. This one has to be finished by hand.";

const parked = present(facts({ blockedReason: NOT_SNAPPED }), "app-1");
ok(parked.state === "NEEDS_YOU", "parked-not-snapshotted -> Needs you");
ok(parked.reprepare === true, "  ...primary action re-prepares through the worker");
ok(parked.action?.label === "Continue on Ashby", "  ...labelled Continue on Ashby");
ok(parked.secondaryAction?.label === "Open on Ashby" && parked.secondaryAction?.href === facts().applyUrl, "  ...with a secondary Open on Ashby escape hatch");
ok(/Nothing is submitted/.test(parked.summary), "  ...and states plainly that nothing is submitted");
ok(parked.action?.label !== "Submit application", "  ...it is never a submit action");

const handoff = present(facts({ blockedReason: CAPTCHA, handoffReason: CAPTCHA }), "app-2");
ok(!handoff.reprepare, "a CAPTCHA-parked Ashby row does NOT offer re-prepare (a re-prepare cannot fix it)");
ok(handoff.action?.href === facts().applyUrl, "  ...it stays a plain external handoff to the Ashby form");

const humanOnly = present(facts({ status: "BLOCKED_NEEDS_INPUT", blockedAnswers: 1, discoveredFields: 5 }), "app-3");
ok(humanOnly.state === "NEEDS_YOU" && humanOnly.action?.href === "/apply/questions", "an unanswered (HUMAN_ONLY) field -> Needs you, Answer questions");
ok(!humanOnly.reprepare, "  ...and is not a re-prepare");

const preparing = present(facts({ activelyPreparing: true }), "app-4");
ok(preparing.state === "PREPARING" && preparing.action === null, "a claimed row reads Preparing with nothing to click");

console.log("\ngroupAshbyChoices -- Aleph-style choice fieldsets collapse to one question each:");
// UUID_UUID option-control names, the shape Ashby actually renders. Each
// option carries its own unique name and a derived selector.
const U = (a: string, b: string) => `${a.padEnd(36, "0")}_${b.padEnd(36, "0")}`;
const opt = (name: string, label: string, kind: "radio" | "checkbox", required: boolean) =>
  ({ name, label, kind, required, selector: `input[name="${name}"]` });
const YESNO: any = { questionText: "If you are based in the United States, will you now or in the future require sponsorship for an employment visa? *", inputs: [
  opt(U("11111111-1111-4111-8111", "aaaa"), "Yes", "radio", true),
  opt(U("11111111-1111-4111-8111", "bbbb"), "No", "radio", true),
]};
const SCREEN: any = { questionText: "Which best describes your Excel or Google Sheets work?", inputs: [
  opt(U("22222222-2222-4222-8222", "aaaa"), "Basic formulas and pivot tables", "radio", false),
  opt(U("22222222-2222-4222-8222", "bbbb"), "Multi-condition lookups and aggregations; SUMIFS, XLOOKUP, INDEX/MATCH across large datasets", "radio", false),
  opt(U("22222222-2222-4222-8222", "cccc"), "Light editing of models others built", "radio", false),
  opt(U("22222222-2222-4222-8222", "dddd"), "I do not use spreadsheets much", "radio", false),
]};

const g = groupAshbyChoices([YESNO, SCREEN]);
const yn = g.groups.find((q) => /sponsorship/i.test(q.label));
ok(!!yn && yn.type === "select" && yn.options?.length === 2 && yn.options[0] === "Yes" && yn.options[1] === "No",
  "a Yes/No question becomes ONE question with exactly two options", yn ? yn.options?.join("/") : "missing");
ok(!!yn && yn.htmlType === "radio-group", "  ...marked htmlType radio-group so the fill path clicks one option");
ok(!!yn && yn.optionSelectors?.["Yes"] === `input[name="${U("11111111-1111-4111-8111", "aaaa")}"]`
  && yn.optionSelectors?.["No"] === `input[name="${U("11111111-1111-4111-8111", "bbbb")}"]`,
  "  ...each option carries its own deterministic selector, keyed by exact text");
ok(!!yn && !/[*]\s*$/.test(yn.label) && /require sponsorship/.test(yn.label), "  ...question label preserved (required asterisk trimmed, wording kept)");
ok(!!yn && yn.required === true, "  ...required carried from the option controls");
const sc = g.groups.find((q) => /Excel or Google Sheets/i.test(q.label));
ok(!!sc && sc.options?.length === 4, "a multi-option screening question keeps its full, correct option list", sc ? String(sc.options?.length) : "missing");
ok(!!sc && sc.options?.includes("Multi-condition lookups and aggregations; SUMIFS, XLOOKUP, INDEX/MATCH across large datasets") === true,
  "  ...each offered option's exact text is preserved verbatim");
ok(!!sc && Object.keys(sc.optionSelectors ?? {}).length === 4, "  ...with a selector for every option");
ok(g.groups.length === 2, "two fieldsets -> two questions, never merged across fieldsets", String(g.groups.length));

console.log("\ngroupAshbyChoices -- fail safe, leave the uncertain separate:");
const lone: any = { questionText: "Do you consent?", inputs: [opt(U("33333333-3333-4333-8333", "aaaa"), "I consent", "radio", false)] };
ok(groupAshbyChoices([lone]).groups.length === 0, "a single-option fieldset is NOT grouped (not a proven choice set)");
const noLegend: any = { questionText: null, inputs: YESNO.inputs };
ok(groupAshbyChoices([noLegend]).groups.length === 0, "no recoverable question label -> left separate, not guessed");
const notAshby: any = { questionText: "Pick any that apply", inputs: [
  opt("agree_terms", "Terms", "radio", false),
  opt("agree_privacy", "Privacy", "radio", false),
]};
ok(groupAshbyChoices([notAshby]).groups.length === 0, "controls not named the Ashby way are never grouped (no false positive)");
// A checkbox multi-select is single-select's opposite and must NOT be
// grouped as if only one option could be chosen.
const multiCheck: any = { questionText: "Which apply to you? (select all)", inputs: [
  opt(U("66666666-6666-4666-8666", "aaaa"), "Option A", "checkbox", false),
  opt(U("66666666-6666-4666-8666", "bbbb"), "Option B", "checkbox", false),
]};
ok(groupAshbyChoices([multiCheck]).groups.length === 0, "a checkbox multi-select fieldset is left ungrouped (single-select only)");

console.log("\nmergeChoiceGroups -- per-option fields replaced, everything else kept:");
const generic: any[] = [
  { key: "_systemfield_name", label: "Full Name", type: "text", required: true },
  { key: U("22222222-2222-4222-8222", "aaaa"), label: "Basic formulas and pivot tables", type: "boolean", required: false },
  { key: U("22222222-2222-4222-8222", "bbbb"), label: "Multi-condition lookups...", type: "boolean", required: false },
  { key: "Which best describes your Excel or Google Sheets work?", label: "Which best describes your Excel or Google Sheets work?", type: "text", required: false },
];
const merged = mergeChoiceGroups(generic, groupAshbyChoices([SCREEN]));
ok(merged.some((f) => f.key === "_systemfield_name"), "an unrelated field (Full Name) is kept untouched");
ok(!merged.some((f) => f.type === "boolean"), "the per-option boolean fields are removed");
ok(!merged.some((f) => f.key === "Which best describes your Excel or Google Sheets work?" && f.type === "text"), "the phantom text field carrying the question is removed");
ok(merged.filter((f) => f.type === "select" && /Excel/.test(f.label)).length === 1, "exactly one grouped select question remains for it");

console.log("\ndropFileHeaderArtifacts -- the real Ashby resume-dropzone phantom:");
// Exactly the real Aleph/Chartis structure: a bare file input reachable only
// by a label (the "Overview"/"Application" section headers), alongside the
// real, id-identified resume input.
const withPhantom: any[] = [
  { key: "_systemfield_name", label: "Full Name", type: "text", selectorKind: "name" },
  { key: "Overview Application", label: "Overview Application", type: "file", selectorKind: "label" },
  { key: "_systemfield_resume", label: "Resume", type: "file", selectorKind: "id" },
  { key: "ethnicity", label: "How would you describe your ethnic or cultural background?", type: "text", selectorKind: "label" },
];
const kept = dropFileHeaderArtifacts(withPhantom);
ok(!kept.some((f) => f.key === "Overview Application"), "the label-only file phantom is dropped");
ok(kept.some((f) => f.key === "_systemfield_resume" && f.type === "file"), "the real resume upload (id selector) is preserved");
ok(kept.filter((f) => f.type === "file").length === 1, "exactly one file field remains (the real resume)");
ok(kept.some((f) => f.key === "ethnicity"), "a label-only NON-file field is untouched (only files are considered)");
// Never suppress when there is no strong file field to prove the phantom is a duplicate.
const loneLabelFile = [{ key: "resume", label: "Resume", type: "file", selectorKind: "label" }];
ok(dropFileHeaderArtifacts(loneLabelFile).length === 1, "a lone label-only file field is KEPT (never broadly suppress Ashby files)");
// Never drop a strongly-identified file field.
const twoStrongFiles = [
  { key: "a", label: "Resume", type: "file", selectorKind: "id" },
  { key: "b", label: "Cover letter", type: "file", selectorKind: "name" },
];
ok(dropFileHeaderArtifacts(twoStrongFiles).length === 2, "two strongly-identified file fields are both kept");

// Optional live leg: a real public single-page Ashby application.
const url = process.env.ASHBY_TEST_URL;
if (url) {
  console.log(`\nlive: snapshotting ${url}`);
  const { snapshotAshbyLive } = await import("../lib/browser/ashbyPrepare.ts");
  const r = await snapshotAshbyLive({ applyUrl: url });
  if (r.ok) {
    const fs = r.snapshot?.fields ?? [];
    const selects = fs.filter((f) => f.type === "select" && (f.options?.length ?? 0) >= 2);
    ok(r.ok === true, "live Ashby form snapshotted");
    ok(fs.length >= 3, `  ...with a real field set (${fs.length} fields)`);
    ok(selects.length >= 1, `  ...choice questions grouped as select-with-options (${selects.length} grouped)`);
    ok(!fs.some((f) => f.type === "boolean" && /^(yes|no)$/i.test(f.label)),
      "  ...no leftover lone Yes/No option-fields (grouping applied)");
    ok(!fs.some((f) => /^overview application$/i.test(f.label)),
      "  ...the Overview Application header-artifact file phantom is gone");
    ok(fs.filter((f) => f.type === "file").length === 1,
      `  ...exactly one file field remains (the real resume) (${fs.filter((f) => f.type === "file").length})`);
    console.log("  fields:");
    for (const f of fs) console.log(`    - ${f.label}  [${f.type}${f.required ? " *" : ""}]${f.options?.length ? "  {" + f.options.join(" | ") + "}" : ""}`);
  } else {
    ok(false, "live Ashby form snapshotted", r.reason);
  }
} else {
  console.log("\nlive: SKIP (set ASHBY_TEST_URL to run the real single-page snapshot)");
}

console.log(bad ? `\n${bad} FAILED` : `\nashby-prepare-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
