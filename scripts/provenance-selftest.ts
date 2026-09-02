/**
 * A claim is supported by the evidence it CITES, or it is not supported.
 *
 * The distinction this suite exists for: a sentence can be entirely true
 * about the person and still point at rows that do not carry it. That is
 * not a small bookkeeping fault. The citation is what a reader follows
 * to check the sentence, and one that does not reach the support cannot
 * be checked by anyone, including us.
 *
 * Runs offline against fixtures.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { auditClaim, substantiveTokens, droppedQualifiers, proceedsAutomatically,
         type CitedSource } from "../lib/render/provenance.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
};

const METRIC: CitedSource = { id: "m-students", text: "Taught and mentored 250+ students" };
const LCCC: CitedSource = { id: "e-lccc", text:
  "Video Production Lab Instructor. Teaching and mentoring, technical concepts, professional workflows, "
  + "hands-on instruction, supervision of student employees, managed day-to-day lab operations, "
  + "coordinated cross-department projects, helped with outreach." };
const HOLLEY: CitedSource = { id: "e-holley", text:
  "Videographer and Editor. Produced creative work across multiple brands, internal teams and concurrent "
  + "projects. Collaborated with marketing. Supported broader marketing initiatives." };
const GENIUS: CitedSource = { id: "e-genius", text:
  "Execute marketing, product, ecommerce and operational initiatives based on company priorities. "
  + "Coordinate with the owner, a small internal team, partners, instructors and customers." };
const PROFILE = [METRIC, LCCC, HOLLEY, GENIUS];

// ---- 1. Provenance completeness ------------------------------------
{
  const under = auditClaim({
    claim: "Mentored over 250 students in technical concepts and professional workflows.",
    cited: [METRIC], profile: PROFILE,
  });
  check("a claim resting on a row it does not cite is UNDER_PROVENANCED",
    under.verdict === "UNDER_PROVENANCED", `${under.verdict}: ${under.reason}`);
  check("and the audit names the row that would settle it",
    under.wouldBeCoveredBy.includes("e-lccc"), JSON.stringify(under.wouldBeCoveredBy));
  check("and names what is uncovered",
    under.uncovered.some((u) => u.startsWith("workflow")), JSON.stringify(under.uncovered));

  const fixed = auditClaim({
    claim: "Mentored over 250 students in technical concepts and professional workflows.",
    cited: [METRIC, LCCC], profile: PROFILE,
  });
  check("citing that row settles it", fixed.verdict === "SUPPORTED", `${fixed.verdict}: ${fixed.reason}`);

  // The heart of it: uncited evidence never rescues a claim.
  check("a claim cannot borrow support from an uncited row",
    under.verdict !== "SUPPORTED", under.verdict);
  const isolated = auditClaim({
    claim: "Mentored over 250 students in technical concepts and professional workflows.",
    cited: [METRIC], profile: [METRIC],
  });
  check("with the supporting row absent from the profile entirely, it is UNSUPPORTED",
    isolated.verdict === "UNSUPPORTED", `${isolated.verdict}: ${isolated.reason}`);
  check("the two cases are told apart, which is what makes one of them fixable",
    under.verdict === "UNDER_PROVENANCED" && isolated.verdict === "UNSUPPORTED", "");
}

// ---- 2. Nothing cited, and words cited nowhere ----------------------
{
  check("a claim citing no evidence is UNSUPPORTED",
    auditClaim({ claim: "Led the migration.", cited: [], profile: PROFILE }).verdict === "UNSUPPORTED", "");
  const invented = auditClaim({
    claim: "Managed pricing strategy for a fintech portfolio.", cited: [HOLLEY], profile: PROFILE });
  check("a domain the profile never mentions is UNSUPPORTED",
    invented.verdict === "UNSUPPORTED", `${invented.verdict}: ${invented.reason}`);
  check("and the audit says which words have no anchor",
    invented.uncovered.some((u) => u.startsWith("pric")), JSON.stringify(invented.uncovered));
}

// ---- 3. Qualifiers: measured, not assumed --------------------------
//
// An evidence row mentioning the owner and a small internal team does
// not oblige every sentence drawn from it to repeat those words. What it
// does mean is that a rule cannot settle whether a positional claim over
// the same work is fair, so the audit stops instead of choosing.
{
  const positional = auditClaim({
    claim: "Coordinated implementation across internal teams, partners, instructors, and customers.",
    cited: [GENIUS], profile: PROFILE,
  });
  check("a positional claim over work the evidence bounds is HUMAN_REVIEW",
    positional.verdict === "HUMAN_REVIEW", `${positional.verdict}: ${positional.reason}`);
  check("and the bounding words are reported for the person reading it",
    positional.droppedQualifiers.includes("owner"), JSON.stringify(positional.droppedQualifiers));

  // The same evidence, a claim that does not reposition the actor.
  const plain = auditClaim({
    claim: "Executed marketing, product and ecommerce initiatives based on company priorities.",
    cited: [GENIUS], profile: PROFILE,
  });
  check("an ordinary claim from the same row is SUPPORTED, qualifiers and all",
    plain.verdict === "SUPPORTED", `${plain.verdict}: ${plain.reason}`);
  check("and the audit still records the qualifiers it saw as context",
    plain.droppedQualifiers.length > 0 && /contextual detail/.test(plain.reason), plain.reason);
  check("so a dropped qualifier alone never decides the verdict",
    plain.verdict === "SUPPORTED" && positional.verdict === "HUMAN_REVIEW", "");
}

// ---- 4. The verdicts mean what they say -----------------------------
{
  check("only SUPPORTED proceeds automatically",
    proceedsAutomatically("SUPPORTED")
    && !proceedsAutomatically("UNDER_PROVENANCED")
    && !proceedsAutomatically("UNSUPPORTED")
    && !proceedsAutomatically("HUMAN_REVIEW"), "");
  check("uncertainty is never resolved into support",
    auditClaim({ claim: "Coordinated the work of the small internal team.", cited: [GENIUS], profile: PROFILE })
      .verdict !== "SUPPORTED", "");
}

// ---- 5. Ordinary vocabulary is not a claim --------------------------
{
  const tokens = substantiveTokens("Collaborated with the marketing team on several projects across the business.");
  check("general resume vocabulary is not treated as a substantive claim",
    !tokens.includes("team") && !tokens.includes("project") && !tokens.includes("busines"),
    JSON.stringify(tokens));
  const light = substantiveTokens("Took loosely defined objectives and moved them through implementation.");
  check("connective and light verbs are not either",
    !light.includes("took") && !light.includes("mov"), JSON.stringify(light));
  check("but a domain word is",
    substantiveTokens("Built pricing models for vendor negotiations.").some((t) => t.startsWith("pric")), "");

  // Morphology is not meaning.
  check("a word matches a form of itself in the evidence",
    auditClaim({ claim: "Refinement of the prototype followed testing.",
      cited: [{ id: "x", text: "Design, prototype, test and refine physical products." }], profile: PROFILE })
      .verdict === "SUPPORTED", "");
  check("but a short word still has to match exactly",
    droppedQualifiers("nothing here", [{ id: "y", text: "portions of the show" }]).includes("portions?"), "");
}

// ---- 6. Qualifiers are read from the statement, not the whole row ---
//
// An employment record holds several responsibilities about different
// work. Treating a qualifier in one of them as a bound on a sentence
// drawn from another flagged seven claims that restate a recorded
// responsibility word for word.
{
  const ROW: CitedSource = {
    id: "e-row",
    text: "Execute marketing initiatives. Coordinate with the owner, a small internal team, partners, "
        + "instructors and customers. Supported broader marketing work. Helped develop the website.",
    statements: [
      "Execute marketing initiatives",
      "Coordinate with the owner, a small internal team, partners, instructors and customers",
      "Supported broader marketing work",
      "Helped develop the website",
    ],
  };
  const verbatim = auditClaim({
    claim: "Coordinated with the owner, a small internal team, partners, instructors and customers.",
    cited: [ROW], profile: [ROW] });
  check("a claim restating one recorded statement is SUPPORTED, whatever the rest of the row says",
    verbatim.verdict === "SUPPORTED", `${verbatim.verdict}: ${verbatim.reason}`);
  check("and the qualifiers of unrelated statements are not read as bounds on it",
    !verbatim.droppedQualifiers.includes("supported") && !verbatim.droppedQualifiers.includes("helped"),
    JSON.stringify(verbatim.droppedQualifiers));

  const repositioned = auditClaim({
    claim: "Coordinated implementation across internal teams, partners, instructors and customers.",
    cited: [ROW], profile: [ROW] });
  check("dropping a bound from the statement the claim DOES rest on still stops",
    repositioned.verdict === "HUMAN_REVIEW", `${repositioned.verdict}: ${repositioned.reason}`);
  check("and names the bounds that went missing",
    repositioned.droppedQualifiers.includes("owner") && repositioned.droppedQualifiers.includes("small"),
    JSON.stringify(repositioned.droppedQualifiers));

  // A row with no statements recorded behaves as it did before.
  const coarse = auditClaim({
    claim: "Coordinated implementation across internal teams.",
    cited: [{ id: ROW.id, text: ROW.text }], profile: [ROW] });
  check("a row that records no separate statements falls back to the whole row",
    coarse.verdict === "HUMAN_REVIEW", `${coarse.verdict}: ${coarse.reason}`);
}

// ---- 7. The failure this gate was built from ------------------------
//
// A live rewrite for the SpotHero posting read "Executed product
// development initiatives from concept through implementation,
// including designing and conducting tests for manufacturing". Every
// tailoring guard accepted it: no new numbers, no proper nouns, a
// supported verb, no posting phrase copied. Its cited row records
// designing, prototyping, testing and refining physical products, and
// says nothing about conducting anything or about manufacturing.
{
  const PRODUCT: CitedSource = {
    id: "e-genius-old",
    text: "Design, prototype, test, and refine physical products using FDM 3D printing, parametric CAD/Onshape, "
        + "slicer configuration, material selection, tolerance testing, and iterative functional testing",
    statements: ["Design, prototype, test, and refine physical products using FDM 3D printing, parametric "
        + "CAD/Onshape, slicer configuration, material selection, tolerance testing, and iterative functional testing"],
  };
  const OTHER: CitedSource = { id: "e-other", text: "Manufacturing partners were coordinated separately.",
    statements: ["Manufacturing partners were coordinated separately."] };

  const live = auditClaim({
    claim: "Executed product development initiatives from concept through implementation, including designing and conducting tests for manufacturing.",
    cited: [PRODUCT], profile: [PRODUCT, OTHER],
  });
  check("the live rewrite that every tailoring guard accepted is refused here",
    live.verdict !== "SUPPORTED", `${live.verdict}: ${live.reason}`);
  check("and the audit names the words the cited row does not carry",
    live.uncovered.some((u) => u.startsWith("conduct")), JSON.stringify(live.uncovered));

  const master = auditClaim({
    claim: "Designed, prototyped, tested, and refined physical products using FDM 3D printing, parametric CAD in Onshape, "
      + "slicer configuration, material selection, tolerance testing, and iterative functional testing.",
    cited: [PRODUCT], profile: [PRODUCT, OTHER],
  });
  check("the master wording it falls back to is SUPPORTED",
    master.verdict === "SUPPORTED", `${master.verdict}: ${master.reason}`);
  check("so the fallback is a real remedy rather than a second guess",
    live.verdict !== "SUPPORTED" && master.verdict === "SUPPORTED", "");

  // And when there is no supported wording, nothing may proceed.
  const hopeless = auditClaim({
    claim: "Directed a manufacturing line across three plants.", cited: [PRODUCT], profile: [PRODUCT] });
  check("a claim with no supported wording anywhere cannot proceed",
    !proceedsAutomatically(hopeless.verdict), hopeless.verdict);
}

// ---- 8. The gate is wired into production generation ----------------
{
  const src = readFileSync("lib/applications/prepare.ts", "utf8");
  check("preparation runs the provenance audit on every tailored claim",
    /auditClaim\(/.test(src) && /for \(const a of result\.accepted\)/.test(src), "");
  check("an unsupported rewrite falls back to the master wording",
    /generation: "SELECTED"/.test(src) && /revertedForProvenance/.test(src), "");
  check("and preparation fails closed when the fallback is unsupported too",
    /provenanceFailure/.test(src) && /refusedReason: `provenance gate/.test(src), "");
  check("the gate runs before anything is stored",
    src.indexOf("auditClaim(") < src.indexOf(`from("resumes").insert`), "");
  check("it audits against the frozen version's rows, not the live tables",
    /auditSources: CitedSource\[\] = rows\.map/.test(src), "");
}

// ---- 9. One extractor, not one per script ---------------------------
//
// master-claim-audit.ts had its own copy that omitted `summary` and
// `detail`, which are the only two fields an evidence row carries. Every
// evidence citation therefore resolved to an empty source, and the audit
// reported supported claims as inventions. The bug is invisible in the
// output: a blind audit and a strict one look identical.
{
  const dir = (d: string): string[] => readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? dir(join(d, e.name)) : [join(d, e.name)]));
  const files = ["lib", "scripts", "app"].filter((d) => existsSync(d)).flatMap(dir)
    .filter((f) => /\.tsx?$/.test(f) && f !== "lib/render/evidenceText.ts");
  // Catching the name is not enough: the copy that caused this was
  // called textOf. What identifies a private extractor is building a
  // CitedSource without importing the canonical readers, whatever the
  // local names happen to be.
  const rolled = files.filter((f) => {
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (!/\bstatements:\s*\w/.test(src)) return false;
    if (/statements:\s*\[/.test(src) && !/\bstatements:\s*(?!\[)\w/.test(src)) return false; // literals in fixtures
    return !/from\s+"[^"]*render\/evidenceText\.ts"/.test(src);
  });
  check("nothing builds a cited source with its own row-text extractor",
    rolled.length === 0, rolled.join(", "));

  const audit = readFileSync("scripts/diag/master-claim-audit.ts", "utf8");
  check("the master-claim audit reads rows the way production reads them",
    /evidenceTextOf\(r\.source_table, r\.row_data\)/.test(audit)
    && /provenanceStatements\(r\.row_data\)/.test(audit), "");
  check("and it audits the current version rather than a pinned one",
    !/eq\("profile_version", \d+\)/.test(audit), "");
}

console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
