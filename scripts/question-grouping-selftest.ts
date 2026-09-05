/**
 * Grouping questions that are the same question with different choices.
 *
 *   node scripts/question-grouping-selftest.ts
 *
 * The three option lists below are the REAL ones, copied from the frozen
 * form snapshots of three live Samsara postings. They matter because the
 * earlier version of this fix was tested against a tidy synthetic
 * example, passed, and was still wrong on every real record. The shapes
 * here are 23, 20 and 22 choices with 20 identical across all three and
 * three diversity-org entries that only some postings carry.
 *
 * The properties being held:
 *
 *   the same question asked by three employers is ONE question to read;
 *   an answer is written only where that employer's own form offers it;
 *   an employer that does not offer it stays blocked and keeps asking;
 *   and two questions that share wording but no option never merge,
 *   because no single answer could have served both.
 */
import {
  groupBlockedQuestions, applicabilityFor, intentKey, questionKey,
  summarize, type BlockedField,
} from "../lib/portal/questionGroups.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

// The 20 every Samsara posting offers.
const SHARED = [
  "Samsara Careers Site", "LinkedIn Jobs", "LinkedIn Post",
  "LinkedIn InMail / Message from a Recruiter or Hiring Manager",
  "Direct Email / Call/ Text from a Recruiter or Hiring Manager",
  "Indeed / Glassdoor", "Reddit Ad", "BuiltIn", "RepVue", "Women in Sales Club",
  "Wellfound", "Just Join IT", "Industry Conference or Event", "Samsara Hosted Event",
  "Instahyre", "Naukri", "University / Campus Recruiting",
  "School Alumni Job Board or LinkedIn Group",
  "Company Alumni Job Board or LinkedIn Group", "Hardware FYI",
];
// The real per-posting variations.
const A = [...SHARED, "Blacktechfest", "Colorintech", "Circa / Miratech / DiversityJobs"]; // 23
const B = [...SHARED];                                                                     // 20
const C = [...SHARED, "Blacktechfest", "Colorintech"];                                     // 22

const field = (app: string, options: string[], label = "How did you hear about this opportunity?"): BlockedField => ({
  applicationId: app,
  applicationLabel: `Samsara — role ${app}`,
  fieldKey: "how_did_you_hear",
  label,
  questionText: label,
  options,
  type: "select",
  required: true,
  category: "D_SENSITIVE",
  blockKind: "UNKNOWN",
  blockedReason: "How you heard about the role is never inferred.",
});

console.log("\nthe three real Samsara shapes:");
const samsara = [field("app-a", A), field("app-b", B), field("app-c", C)];
check("the three option lists are genuinely different sizes",
  A.length === 23 && B.length === 20 && C.length === 22, `${A.length}/${B.length}/${C.length}`);
check("their exact option sets are NOT identical",
  new Set([questionKey(samsara[0]!), questionKey(samsara[1]!), questionKey(samsara[2]!)]).size === 3,
  "the strict keys collided, so this test proves nothing");
check("but their intent is identical",
  new Set(samsara.map(intentKey)).size === 1, samsara.map(intentKey).join(" | "));

const groups = groupBlockedQuestions(samsara);
check("they present as ONE question", groups.length === 1, `${groups.length} groups`);

const g = groups[0]!;
check("all three applications hang off it", g.fields.length === 3, `${g.fields.length}`);
check("the reader is shown the union of choices", g.options.length === 23, `${g.options.length}`);
check("the 20 shared choices are marked as resolving all three",
  g.universalOptions.length === 20, `${g.universalOptions.length}`);
check("the group is flagged as having varying options", g.optionsVary === true, String(g.optionsVary));
check("and says so in words", /only to the applications whose own form lists it/.test(g.reuseNote ?? ""), String(g.reuseNote));
check("each application keeps its own option list",
  g.fields.map((f) => f.options.length).join(",") === "23,20,22",
  g.fields.map((f) => f.options.length).join(","));
check("coverage is recorded per option",
  g.optionCoverage["LinkedIn Jobs"]?.length === 3
  && g.optionCoverage["Circa / Miratech / DiversityJobs"]?.length === 1,
  JSON.stringify(g.optionCoverage["Circa / Miratech / DiversityJobs"]));

console.log("\nanswering with a choice every form offers:");
{
  const { compatible, incompatible } = applicabilityFor(g, "LinkedIn Jobs");
  check("all three resolve from one answer", compatible.length === 3, `${compatible.length}`);
  check("none is left behind", incompatible.length === 0, `${incompatible.length}`);
}

console.log("\nanswering with a choice only some forms offer:");
{
  const { compatible, incompatible } = applicabilityFor(g, "Colorintech");
  check("only the two that offer it are written",
    compatible.length === 2 && compatible.every((f) => f.options.includes("Colorintech")),
    compatible.map((f) => f.applicationId).join(","));
  check("the one that does not offer it stays blocked",
    incompatible.length === 1 && incompatible[0]!.applicationId === "app-b",
    incompatible.map((f) => f.applicationId).join(","));
}
{
  const { compatible, incompatible } = applicabilityFor(g, "Circa / Miratech / DiversityJobs");
  check("a choice only one form offers resolves only that one",
    compatible.length === 1 && compatible[0]!.applicationId === "app-a",
    compatible.map((f) => f.applicationId).join(","));
  check("and the other two keep asking", incompatible.length === 2, `${incompatible.length}`);
}
{
  // The rule that stops "close enough".
  const { compatible, incompatible } = applicabilityFor(g, "LinkedIn");
  check("a near-miss string matches nothing and is never substituted",
    compatible.length === 0 && incompatible.length === 3,
    `${compatible.length} compatible`);
}

console.log("\nwhat must still NOT merge:");
{
  // Same wording, disjoint choices. No answer could serve both, so
  // grouping them would be a lie about what one answer achieves.
  const disjoint = [
    field("app-x", ["Chicago", "San Francisco"], "Location"),
    field("app-y", ["London", "Berlin"], "Location"),
  ];
  const gs = groupBlockedQuestions(disjoint);
  check("same wording with no shared option stays two questions", gs.length === 2, `${gs.length}`);
}
{
  // Overlapping but not identical: one shared option is enough, and the
  // answer then applies only where it is offered.
  const overlap = [
    field("app-x", ["Chicago", "San Francisco"], "Location"),
    field("app-y", ["Chicago", "London"], "Location"),
  ];
  const gs = groupBlockedQuestions(overlap);
  check("one shared option is enough to group", gs.length === 1, `${gs.length}`);
  check("and the shared one resolves both",
    applicabilityFor(gs[0]!, "Chicago").compatible.length === 2);
  check("while an unshared one resolves only its own",
    applicabilityFor(gs[0]!, "London").compatible.length === 1);
}
{
  // Free text has no options to compare and groups on wording alone.
  const text = [
    { ...field("app-x", []), type: "text", label: "Why here?", questionText: "Why here?" },
    { ...field("app-y", []), type: "text", label: "Why here?", questionText: "Why here?" },
  ];
  const gs = groupBlockedQuestions(text as BlockedField[]);
  check("free-text questions with the same wording group", gs.length === 1, `${gs.length}`);
  check("and one answer serves both", applicabilityFor(gs[0]!, "anything").compatible.length === 2);
}
{
  // Consent is grouped for reading but never marked reusable.
  const consent = [
    field("app-x", ["Yes", "No"], "I agree to the Processing of Personal Data"),
    field("app-y", ["Yes", "No"], "I agree to the Processing of Personal Data"),
  ];
  const gs = groupBlockedQuestions(consent);
  check("identical consent controls are shown once", gs.length === 1, `${gs.length}`);
  check("but consent is never marked reusable", gs[0]!.reusable === false, String(gs[0]!.reusable));
}

console.log("\nacknowledgement controls, including the ones without consent wording:");
{
  // Samsara's real one. No "I agree", no "terms", no "privacy policy":
  // the only signal is that its single choice is "Acknowledge/Confirm".
  const pd = [
    field("app-x", ["Acknowledge/Confirm"], "Processing of Personal Data"),
    field("app-y", ["Acknowledge/Confirm"], "Processing of Personal Data"),
    field("app-z", ["Acknowledge/Confirm"], "Processing of Personal Data"),
  ];
  const gs = groupBlockedQuestions(pd);
  check("it is shown once", gs.length === 1, `${gs.length}`);
  check("but is NOT marked reusable", gs[0]!.reusable === false, String(gs[0]!.reusable));
  check("and says why", /separate agreement/.test(gs[0]!.reuseNote ?? ""), String(gs[0]!.reuseNote));
}
{
  // The shape rule must not swallow ordinary yes/no questions.
  const yn = [field("app-x", ["Yes", "No"], "Are you willing to travel up to 20%?")];
  const gs = groupBlockedQuestions(yn);
  check("a real two-way choice stays reusable", gs[0]!.reusable === true, String(gs[0]!.reusable));
}
{
  const optin = [field("app-x", ["Yes", "No"], "Do you opt-in to receive WhatsApp messages from Stripe Recruiting?")];
  const gs = groupBlockedQuestions(optin);
  check("an opt-in is caught by wording even with two choices",
    gs[0]!.reusable === false, String(gs[0]!.reusable));
}

console.log("\nfile uploads are application-specific and never cross-app deduped:");
{
  // The real Aleph + Chartis case: both Ashby forms carry a custom file field
  // labelled "Overview Application" (key == label, type file, optional). Before
  // the fix these collapsed into one shared "1 answer across 2 applications".
  const fileField = (app: string): BlockedField => ({
    applicationId: app, applicationLabel: `co ${app} — role`,
    fieldKey: "Overview Application", label: "Overview Application",
    questionText: "Overview Application", options: [], type: "file", required: false,
    category: null, blockKind: "UNKNOWN",
    blockedReason: "nothing in the question catalog matches this wording.",
  });
  const gs = groupBlockedQuestions([fileField("aleph"), fileField("chartis")]);
  check("two employers' identical file fields stay TWO groups, never merged",
    gs.length === 2, `${gs.length}`);
  check("each file group belongs to exactly one application",
    gs.every((g) => g.fields.length === 1), gs.map((g) => g.fields.length).join(","));
  const s = summarize(gs);
  check("file uploads are counted as handoffs, not typeable answers",
    s.answersNeeded === 0 && s.handoffs === 2 && s.applications === 2, JSON.stringify(s));

  // A select question with the same wording across two apps STILL groups: the
  // file rule must not leak into ordinary questions.
  const sel = groupBlockedQuestions([
    field("app-x", ["Yes", "No"], "Are you authorized to work?"),
    field("app-y", ["Yes", "No"], "Are you authorized to work?"),
  ]);
  check("ordinary select questions still group across applications", sel.length === 1, `${sel.length}`);
}

console.log("\ncounting:");
{
  const s = summarize(groupBlockedQuestions(samsara));
  check("three blocked fields become one answer to give",
    s.blockedFields === 3 && s.answersNeeded === 1 && s.handoffs === 0 && s.applications === 3, JSON.stringify(s));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("question grouping holds against the real option lists");
