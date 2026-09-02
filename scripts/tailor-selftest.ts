/**
 * Adversarial tests for the grounding guards.
 *
 * These attack the guards DIRECTLY with hand-written candidate claims.
 * Testing by generating resumes and inspecting them would only prove the
 * model happened not to attack that day; it would say nothing about
 * whether the guard works. So every known-unsafe claim is written out
 * here, paired with the evidence it would cite, and asserted to be
 * rejected.
 *
 * The suite proves two things independently:
 *
 *   1. known unsupported or escalated claims are deterministically rejected
 *   2. known legitimate reframings are deterministically accepted
 *
 * Both matter. A guard that rejects everything is not safe, it is broken,
 * and it would push a person to disable it. So the accept cases are as
 * load-bearing as the reject ones.
 *
 * BOUNDARY PAIRS are the real test. Each pair uses near-identical
 * sentences against the same evidence, where one is honest and the other
 * escalates by a word. A guard that passes the pair is reading the
 * assertion; a guard that fails it is blacklisting vocabulary.
 *
 * Permanent regression suite: a change to the tailoring engine or the
 * guards must not be able to resurrect any of these quietly.
 *
 *   node scripts/tailor-selftest.ts
 */
import { checkGrounding } from "../lib/render/grounding.ts";

const KNOWN_ENTITIES = [
  "Lorain County Community College", "Genius One", "Holley Performance", "Anytime Picture",
  "Western Governors University", "Sportsman Network", "Cleveland Clinic", "Amazon",
  "Adobe Creative Suite", "Vimeo OTT", "RentPup", "Onshape", "Shopify", "Genius Academy",
];

const APPROVED_METRICS = [
  "Played a substantial hands-on role in developing, launching, and operating Genius Academy, an education-focused offering that reached a peak of more than $70,000 in annual recurring revenue in 2022",
  "Supervised the day-to-day work of three student employees",
  "Taught and mentored 250+ students",
  "Designed marketing emails and built and managed segmented email marketing funnels for an audience of approximately 100,000 contacts",
  "Coordinated a college and industry collaboration involving 10+ video deliverables",
];

/** Evidence texts, as they exist in profile version 5. */
const EV = {
  lccc: "Coordinated a collaboration with a nationally broadcast television show that aired three seasons on the Sportsman Network, giving students production and editing opportunities, and personally edited portions of the show and created motion graphics for it",
  lcccTeach: "Taught and mentored students, translating technical concepts and professional workflows into hands-on instruction",
  lcccSupervise: "Supervised three staff members",
  lcccOps: "Managed day-to-day lab operations and maintained professional production technology. Coordinated cross-department projects supporting college programs, marketing, community partnerships, and outreach.",
  anytime: "Worked personally on a video project for Cleveland Clinic showcasing a new laboratory: planning, filming, editing, motion graphics and graphic design",
  anytimeLead: "Led hands-on production and post-production across video editing, compositing, motion graphics, and graphic design using Adobe Creative Suite",
  geniusProduct: "Design, prototype, test, and refine physical products using FDM 3D printing, parametric CAD/Onshape, slicer configuration, material selection, tolerance testing, and iterative functional testing",
  geniusContribute: "Contribute directly to product ideation and development, including identifying product opportunities and developing original concepts",
  geniusAcademy: "Built and supported Genius Academy, an education-focused offering",
  rentpup: "A property-compliance monitoring product helping Cleveland rental-property owners identify regulatory issues and upcoming compliance risks. Pre-revenue with no verified customer traction.",
  education: "Bachelor of Science, Health Science, Western Governors University, Leavitt School of Health",
  linkedin: "Passed LinkedIn Skill Assessments in Adobe Premiere Pro and Adobe After Effects. These are not Adobe or vendor certifications.",
  shopify: "Shopify, EXPERIENCED. Built and managed online storefronts.",
  githubSkill: "GitHub, EXPOSURE level.",
  holley: "Produced creative work across multiple brands, internal teams, and concurrent projects with shifting priorities and deadlines",
};

interface Case {
  name: string;
  claim: string;
  source: string;
  shouldPass: boolean;
  /** For rejections, the check that must be the one to catch it. */
  expectCheck?: string;
}

const CASES: Case[] = [
  // ---- the twelve named attacks -----------------------------------
  { name: "ATTACK: contributed -> led", claim: "Led product ideation and development at Genius One, identifying product opportunities and developing original concepts.",
    source: EV.geniusContribute, shouldPass: false, expectCheck: "NO_SCOPE_ESCALATION" },
  { name: "ATTACK: collaboration -> ownership", claim: "Owned the relationship with a nationally broadcast television show on the Sportsman Network.",
    source: EV.lccc, shouldPass: false, expectCheck: "NO_SCOPE_ESCALATION" },
  { name: "ATTACK: invented metric", claim: "Supervised three staff members, improving lab throughput by 35%.",
    source: EV.lcccSupervise, shouldPass: false, expectCheck: "NO_NEW_NUMBERS" },
  { name: "ATTACK: altered approved metric", claim: "Taught and mentored over 400 students.",
    source: EV.lcccTeach, shouldPass: false, expectCheck: "NO_NEW_NUMBERS" },
  { name: "ATTACK: invented years of experience", claim: "Coordinated a collaboration with a nationally broadcast television show over eight years.",
    source: EV.lccc, shouldPass: false, expectCheck: "NO_NEW_NUMBERS" },
  { name: "ATTACK: duration without a numeral", claim: "Produced creative work across multiple brands for over a decade.",
    source: EV.holley, shouldPass: false, expectCheck: "NO_NEW_NUMBERS" },
  { name: "ATTACK: expertise from EXPERIENCED skill", claim: "Recognised industry expert in Shopify storefront architecture.",
    source: EV.shopify, shouldPass: false, expectCheck: "NO_INTENSITY_ESCALATION" },
  { name: "ATTACK: expertise from EXPOSURE skill", claim: "Deep expertise in GitHub-based collaboration workflows.",
    source: EV.githubSkill, shouldPass: false, expectCheck: "NO_INTENSITY_ESCALATION" },
  { name: "ATTACK: Health Science -> clinical experience", claim: "Bachelor of Science in Health Science with clinical experience as a licensed practitioner.",
    source: EV.education, shouldPass: false, expectCheck: "CLAIM_GUARDS" },
  { name: "ATTACK: RentPup as employment", claim: "Senior software engineer at RentPup, building property-compliance monitoring.",
    source: EV.rentpup, shouldPass: false, expectCheck: "CLAIM_GUARDS" },
  { name: "ATTACK: RentPup as revenue business", claim: "Built and grew RentPup, acquiring customers across Cleveland.",
    source: EV.rentpup, shouldPass: false, expectCheck: "CLAIM_GUARDS" },
  { name: "ATTACK: client-project -> account ownership", claim: "Directed the Cleveland Clinic account, managing the client relationship end to end.",
    source: EV.anytime, shouldPass: false, expectCheck: "NO_SCOPE_ESCALATION" },
  { name: "ATTACK: FDM work -> engineering credential", claim: "Mechanical engineer specialising in FDM 3D printing and parametric CAD.",
    source: EV.geniusProduct, shouldPass: false, expectCheck: "NO_UNBACKED_CREDENTIALS" },
  { name: "ATTACK: retracted LCCC program creation", claim: "Created the Video Program internship program from the ground up at LCCC.",
    source: EV.lccc, shouldPass: false, expectCheck: "CLAIM_GUARDS" },
  { name: "ATTACK: LinkedIn assessment -> Adobe certification", claim: "Adobe certified in Premiere Pro and After Effects.",
    source: EV.linkedin, shouldPass: false, expectCheck: "CLAIM_GUARDS" },
  { name: "ATTACK: invented client", claim: "Worked personally on video projects for Cleveland Clinic and Nike.",
    source: EV.anytime, shouldPass: false, expectCheck: "NO_NEW_ENTITIES" },
  { name: "ATTACK: no evidence cited at all", claim: "Delivered outstanding results across every engagement.",
    source: "", shouldPass: false, expectCheck: "CITES_EVIDENCE" },

  // Found in live validation, not invented here: a model rewrite of the
  // Genius Academy bullet turned the offering's ARR into revenue he
  // generated, and survived because the guard required a sentence start
  // or a pronoun before the verb. One relative pronoun away from caught.
  { name: "ATTACK (found live): approved metric paraphrased into personal attribution",
    claim: "Developed and operated Genius Academy, an education-focused offering that generated more than $70,000 in annual recurring revenue.",
    source: EV.geniusAcademy, shouldPass: false, expectCheck: "METRICS_VERBATIM" },
  { name: "ATTACK (found live): same figure, plain attribution",
    claim: "Generated $70,000 in annual recurring revenue at Genius Academy.",
    source: EV.geniusAcademy, shouldPass: false, expectCheck: "METRICS_VERBATIM" },

  // ---- boundary pairs ---------------------------------------------
  // Same evidence, one word apart. If the guard blacklists vocabulary
  // rather than reading the assertion, it fails one half of each pair.
  { name: "PAIR 1a: coordinated, as the evidence says", claim: "Coordinated a collaboration with a nationally broadcast television show on the Sportsman Network.",
    source: EV.lccc, shouldPass: true },
  { name: "PAIR 1b: led, which the evidence does not say", claim: "Led a collaboration with a nationally broadcast television show on the Sportsman Network.",
    source: EV.lccc, shouldPass: false, expectCheck: "NO_SCOPE_ESCALATION" },

  { name: "PAIR 2a: led production, where the evidence leads", claim: "Led hands-on production and post-production across video editing, compositing, and motion graphics.",
    source: EV.anytimeLead, shouldPass: true },
  { name: "PAIR 2b: founded, one rung above leading", claim: "Founded the production and post-production practice covering video editing and motion graphics.",
    source: EV.anytimeLead, shouldPass: false, expectCheck: "NO_SCOPE_ESCALATION" },

  { name: "PAIR 3a: three staff, the figure in the evidence", claim: "Supervised three staff members.",
    source: EV.lcccSupervise, shouldPass: true },
  { name: "PAIR 3b: thirteen staff, a figure that is not", claim: "Supervised thirteen staff members.",
    source: EV.lcccSupervise, shouldPass: false, expectCheck: "NO_NEW_NUMBERS" },

  { name: "PAIR 4a: worked on a Cleveland Clinic project", claim: "Worked personally on a video project for Cleveland Clinic covering planning, filming, editing, and motion graphics.",
    source: EV.anytime, shouldPass: true },
  { name: "PAIR 4b: managed the Cleveland Clinic account", claim: "Managed the Cleveland Clinic account across planning, filming, and editing.",
    source: EV.anytime, shouldPass: false, expectCheck: "NO_SCOPE_ESCALATION" },

  { name: "PAIR 5a: designs and tests physical products", claim: "Designed, prototyped, and tested physical products using FDM 3D printing and parametric CAD in Onshape.",
    source: EV.geniusProduct, shouldPass: true },
  { name: "PAIR 5b: same work, asserted as a credential", claim: "Designed and tested physical products as a certified mechanical engineer.",
    source: EV.geniusProduct, shouldPass: false, expectCheck: "NO_UNBACKED_CREDENTIALS" },

  { name: "PAIR 6a: built storefronts on Shopify", claim: "Built and managed online storefronts on Shopify.",
    source: EV.shopify, shouldPass: true },
  { name: "PAIR 6b: the same work, asserted as mastery", claim: "Built online storefronts with mastery of the Shopify platform.",
    source: EV.shopify, shouldPass: false, expectCheck: "NO_INTENSITY_ESCALATION" },

  { name: "PAIR 7a: built and supported Genius Academy", claim: "Built and supported Genius Academy, an education-focused offering.",
    source: EV.geniusAcademy, shouldPass: true },
  { name: "PAIR 7b: same, with an invented revenue figure", claim: "Built and supported Genius Academy, an education-focused offering generating $250,000 annually.",
    source: EV.geniusAcademy, shouldPass: false, expectCheck: "NO_NEW_NUMBERS" },

  // ---- predicate scope: the verb is not enough --------------------
  // The evidence applies "managed" to lab operations and "coordinated" to
  // cross-department projects. A rewrite that swaps which verb governs
  // which object is an escalation even though both words are present.
  { name: "PAIR 8a: managed, applied to what the evidence managed", claim: "Managed day-to-day lab operations and maintained professional production technology.",
    source: EV.lcccOps, shouldPass: true },
  { name: "PAIR 8b: managed, applied to something else", claim: "Managed cross-department projects supporting college programs and outreach.",
    source: EV.lcccOps, shouldPass: false, expectCheck: "NO_PREDICATE_DRIFT" },
  { name: "PAIR 9a: narrowing the object is allowed", claim: "Managed lab operations.",
    source: EV.lcccOps, shouldPass: true },
  { name: "PAIR 9b: widening the object is not", claim: "Managed the marketing function.",
    source: EV.lcccOps, shouldPass: false, expectCheck: "NO_PREDICATE_DRIFT" },
  { name: "PAIR 10a: coordinated stays with its own object", claim: "Coordinated cross-department projects supporting college programs, marketing, and outreach.",
    source: EV.lcccOps, shouldPass: true },
  { name: "PAIR 10b: coordinated object promoted to managed", claim: "Managed community partnerships and outreach.",
    source: EV.lcccOps, shouldPass: false, expectCheck: "NO_PREDICATE_DRIFT" },
  { name: "OK: supervising exactly what was supervised", claim: "Supervised three staff members.",
    source: EV.lcccSupervise, shouldPass: true },

  // ---- legitimate reframings that MUST survive --------------------
  // Reordered, condensed and rephrased, all within the evidence.
  { name: "OK: condensed teaching claim", claim: "Taught and mentored students, translating technical concepts into hands-on instruction.",
    source: EV.lcccTeach, shouldPass: true },
  { name: "OK: reordered production claim", claim: "Across video editing, compositing, motion graphics, and graphic design, led hands-on production and post-production using Adobe Creative Suite.",
    source: EV.anytimeLead, shouldPass: true },
  { name: "OK: approved metric used verbatim", claim: "Supervised the day-to-day work of three student employees",
    source: EV.lcccSupervise, shouldPass: true },
  { name: "OK: RentPup described within its scope", claim: "Independent product built outside of full-time work: a property-compliance monitoring system for Cleveland rental-property owners.",
    source: EV.rentpup, shouldPass: true },
  { name: "OK: contribution stated as contribution", claim: "Contributed directly to product ideation and development, identifying product opportunities and developing original concepts.",
    source: EV.geniusContribute, shouldPass: true },
  { name: "OK: education stated plainly", claim: "Bachelor of Science, Health Science, Western Governors University.",
    source: EV.education, shouldPass: true },
  { name: "OK: LinkedIn assessments stated accurately", claim: "Passed LinkedIn Skill Assessments in Adobe Premiere Pro and Adobe After Effects.",
    source: EV.linkedin, shouldPass: true },
];

let failed = 0;
const byCheck: Record<string, { caught: number; missed: number }> = {};

console.log("grounding guards, attacked directly\n");
for (const c of CASES) {
  const v = checkGrounding({
    claim: c.claim,
    evidenceIds: c.source ? ["00000000-0000-0000-0000-000000000001"] : [],
    sourceText: c.source,
    approvedMetrics: APPROVED_METRICS,
    knownEntities: KNOWN_ENTITIES,
  });

  const problems: string[] = [];
  let note = "";
  if (v.ok !== c.shouldPass) {
    problems.push(c.shouldPass
      ? `should have been ACCEPTED, rejected by ${v.failedCheck}: ${v.failureDetail}`
      : `should have been REJECTED, it was accepted`);
  } else if (!c.shouldPass && c.expectCheck && v.failedCheck !== c.expectCheck) {
    // Defence in depth is not a failure: an attack caught by a different
    // guard is still caught. Precision is enforced on the boundary pairs,
    // where the whole point is that the guard reads the assertion.
    if (c.name.startsWith("PAIR")) {
      problems.push(`rejected by ${v.failedCheck}, expected ${c.expectCheck} to be the one reading it`);
    } else {
      note = `caught by ${v.failedCheck} rather than ${c.expectCheck}; still rejected`;
    }
  }

  if (!c.shouldPass) {
    const k = v.ok ? (c.expectCheck ?? "?") : (v.failedCheck ?? "?");
    byCheck[k] ??= { caught: 0, missed: 0 };
    if (v.ok) byCheck[k]!.missed++; else byCheck[k]!.caught++;
  }

  if (problems.length) failed++;
  console.log(`  ${problems.length ? "FAIL" : "PASS"}  ${c.name}`);
  for (const p of problems) console.log(`        ${p}`);
  if (!problems.length && !c.shouldPass) console.log(`        ${note || `caught by ${v.failedCheck}`}: ${(v.failureDetail ?? "").slice(0, 84)}`);
}

console.log("\nwhich guard caught which attack");
for (const [k, v] of Object.entries(byCheck).sort()) {
  console.log(`  ${k.padEnd(26)} caught ${v.caught}, missed ${v.missed}`);
}

const attacks = CASES.filter((c) => !c.shouldPass).length;
const legit = CASES.filter((c) => c.shouldPass).length;
console.log(`\n${attacks} attacks, ${legit} legitimate reframings, ${CASES.length} cases`);
console.log(failed === 0 ? "all passed" : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
