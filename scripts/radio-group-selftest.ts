/**
 * A radio option must never be matched by its label alone.
 *
 *   node scripts/radio-group-selftest.ts
 *
 * Northern Trust's "have you previously worked here" was discovered as a
 * field called "Yes", because the option label was the only text the
 * snapshot could see. The filler then looked for a control matching
 * "Yes", found three across the page, and refused. It was right to
 * refuse: on a form with several yes/no questions, picking one would
 * have answered an employment-history question at random.
 */
import { collapseRadioGroups, radioGroupKey, radioOptionSelector, humanise,
         type RawControl } from "../lib/workday/radioGroups.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}  ${d}`); }
};
const radio = (name: string, value: string, required = false): RawControl =>
  ({ label: value, htmlType: "radio", name, value, required });
const text = (label: string, selector: string): RawControl =>
  ({ label, htmlType: "text", selector, required: true });

console.log("\n1. the live case:");
{
  const page: RawControl[] = [
    text("First Name", '[name="legalName--firstName"]'),
    radio("candidateIsPreviousWorker", "Yes", true),
    radio("candidateIsPreviousWorker", "No", true),
  ];
  const r = collapseRadioGroups(page);
  check("three controls become two questions", r.length === 2, JSON.stringify(r.map((x) => x.key)));
  const g = r.find((x) => x.groupName === "candidateIsPreviousWorker")!;
  check("the group is one question", Boolean(g));
  check("its key is the group identity, not a label", g.key === radioGroupKey("candidateIsPreviousWorker"), g.key);
  check("its question is never 'Yes'", g.question !== "Yes", g.question);
  check("it carries both options", JSON.stringify(g.options) === '["Yes","No"]', JSON.stringify(g.options));
  check("required propagates from the options", g.required === true);
}

console.log("\n1b. the group's own question, from its legend:");
{
  const legend = "Have you previously worked for this organization? If Yes, please answer the questions below.*";
  const page: RawControl[] = [
    { ...radio("candidateIsPreviousWorker", "Yes"), group: legend },
    { ...radio("candidateIsPreviousWorker", "No"), group: legend },
  ];
  const g = collapseRadioGroups(page).find((x) => x.groupName === "candidateIsPreviousWorker")!;
  check("the legend is the question, without the required marker",
    g.question === "Have you previously worked for this organization? If Yes, please answer the questions below.", g.question);
  check("the required marker makes the group required", g.required === true);
  const bare = collapseRadioGroups([radio("candidateIsPreviousWorker", "Yes"), radio("candidateIsPreviousWorker", "No")])
    .find((x) => x.groupName === "candidateIsPreviousWorker")!;
  check("without a legend the humanised name stands in, as before", bare.question === humanise("candidateIsPreviousWorker"), bare.question);
  const optionAsGroup = collapseRadioGroups([{ ...radio("g", "Yes"), group: "Yes" }, { ...radio("g", "No"), group: "Yes" }])
    .find((x) => x.groupName === "g")!;
  check("a 'legend' that is just an option label is not the question", optionAsGroup.question === humanise("g"), optionAsGroup.question);
}

console.log("\n2. THE BUG: two groups on one page:");
{
  // Both offer Yes/No. A label-based selector matches four inputs.
  const page: RawControl[] = [
    radio("candidateIsPreviousWorker", "Yes"), radio("candidateIsPreviousWorker", "No"),
    radio("requiresSponsorship", "Yes"), radio("requiresSponsorship", "No"),
  ];
  const r = collapseRadioGroups(page);
  check("four inputs become two questions", r.length === 2, String(r.length));
  check("the two groups have different keys", r[0]!.key !== r[1]!.key);
  const a = radioOptionSelector("candidateIsPreviousWorker", "No");
  const b = radioOptionSelector("requiresSponsorship", "No");
  check("their 'No' selectors differ", a !== b, `${a} vs ${b}`);
  check("each names its own group", a.includes("candidateIsPreviousWorker") && b.includes("requiresSponsorship"));
  check("and each names the value", a.includes('value="No"') && b.includes('value="No"'));
  // The selector that caused the failure.
  check("a bare label is not a selector any of this produces",
    !r.some((x) => x.key === "Yes" || x.key === "No"));
}

console.log("\n3. three groups, the shape that broke it live:");
{
  const page: RawControl[] = ["a", "b", "c"].flatMap((n) => [radio(n, "Yes"), radio(n, "No")]);
  const r = collapseRadioGroups(page);
  check("six inputs become three questions", r.length === 3, String(r.length));
  check("every key is distinct", new Set(r.map((x) => x.key)).size === 3);
  const sels = r.map((x) => radioOptionSelector(x.groupName!, "No"));
  check("every 'No' selector is distinct", new Set(sels).size === 3, JSON.stringify(sels));
}

console.log("\n4. non-radio controls are untouched:");
{
  const r = collapseRadioGroups([text("City", '[name="city"]'), text("First Name", '[name="legalName--firstName"]')]);
  check("they keep their own selectors", r[0]!.key === '[name="city"]' && r[1]!.key === '[name="legalName--firstName"]');
  check("and carry no options", r.every((x) => x.options === null));
  check("and no group name", r.every((x) => !x.groupName));
}

console.log("\n5. an unnameable radio is not invented:");
{
  // No name attribute means no identity. Guessing one is exactly how the
  // original defect arose.
  const r = collapseRadioGroups([{ label: "Yes", htmlType: "radio", name: null, value: "Yes" }]);
  check("it is left as its own field rather than grouped", r.length === 1);
  check("and is not given a group identity", !r[0]!.groupName);
}

console.log("\n6. the question text is traceable, not invented wording:");
{
  check("candidateIsPreviousWorker reads back", humanise("candidateIsPreviousWorker") === "Candidate Is Previous Worker",
    humanise("candidateIsPreviousWorker"));
  check("underscores and dashes work", humanise("requires_sponsorship-now") === "Requires Sponsorship Now",
    humanise("requires_sponsorship-now"));
  check("it is never empty for a real name", humanise("x").length > 0);
}

console.log("\n7. the selector is unusable without both halves:");
{
  const s = radioOptionSelector("g", "No");
  check("it contains the name", s.includes('name="g"'));
  check("it contains the value", s.includes('value="No"'));
  check("neither half alone would be unique",
    s !== 'input[name="g"]' && s !== 'input[value="No"]');
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("a radio is identified by its group and its value, never by its label");
