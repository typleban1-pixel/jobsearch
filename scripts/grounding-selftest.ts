/**
 * Reframing versus inventing, on the sentences that actually got this
 * wrong.
 *
 * Every unsafe case here was accepted by the guards at some point, most
 * of them by a live model on a real posting. Every safe case is a
 * rewrite that must keep working, because a guard that refuses ordinary
 * reframing forces the resume to copy its evidence word for word, and
 * then tailoring does nothing at all.
 *
 * Runs offline. The evidence text is inlined from profile version 8.
 */
import { checkGrounding } from "../lib/render/grounding.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
};

const EVIDENCE: Record<string, string> = {
 "geniusNow": "Same role and employer as stint 1. Currently part-time. Execute marketing, product, ecommerce, creative, and operational initiatives based on company priorities Contribute to product ideation and development Execute digital marketing and ecommerce work",
 "holley": "User states the title understates the role: worked across multiple teams and simultaneous fast-paced projects and supported broader marketing initiatives. Produced creative work across multiple brands, internal teams, and concurrent projects with shifting priorities and deadlines Collaborated cross-functionally with marketing and other teams to determine creative approaches and execute projects from planning through delivery Produced automotive documentaries, product launches, interviews, event coverage, promotional content, graphics, and motion graphics using Adobe Creative Suite Supported broader marketing initiatives through creative production, scripts, content publishing, and SEO-oriented metadata",
 "geniusOld": "User states explicitly: did not own Genius One's overall COMPANY marketing strategy. The owner established overall priorities and delegated objectives; the role was heavily execution-oriented, determining how to accomplish them, sometimes requiring research and learning something new. Also contributed original ideas including product ideas. SCOPE: this narrows one company and one level of ownership. It is not evidence of lacking marketing-strategy capability generally. Execute marketing, product, ecommerce, creative, and operational initiatives based on company priorities, taking loosely defined objectives from idea through implementation Contribute directly to product ideation and development, including identifying product opportunities and developing original concepts Design, prototype, test, and refine physical products using FDM 3D printing, parametric CAD/Onshape, slicer configuration, material selection, tolerance testing, and iterative functional testing Execute digital marketing and ecommerce work across websites, SEO, email, analytics, content, creative production, and online storefronts Attend industry trade shows to research emerging products, technologies, equipment, competitors, and trends Coordinate with the owner, a small internal team, partners, instructors, customers, and other stakeholders Built and supported Genius Academy, an education-focused offering",
 "anytime": "User states the role involved more than camera and edit work: client discovery, feasibility assessment within budget and timeline, approach development, problem solving, plus client acquisition and phone closing, website contribution, technology research, graphics and motion graphics. CLIENT SCOPE: on the Cleveland Clinic and Amazon projects specifically, someone else at Anytime Picture owned the client relationship. Both may be named; there is no NDA on either. The exact stint for these two projects is not established, so neither is dated. Translated client goals into practical production solutions within budget, timeline, creative, and technical constraints Worked directly with clients to understand business needs, develop solutions, troubleshoot challenges, and deliver finished projects Led hands-on production and post-production across video editing, compositing, motion graphics, and graphic design using Adobe Creative Suite Supported client acquisition and sales by speaking with prospects, assessing needs, recommending solutions, and closing projects over the phone Helped develop the company website and researched emerging technologies at industry trade shows Worked personally on a video project for Cleveland Clinic showcasing a new laboratory: planning, filming, editing, motion graphics and graphic design Worked personally on a video project for Amazon showcasing a newly opened warehouse: planning, filming, editing, motion graphics and graphic design",
 "lccc": "User states the significance extends beyond video: supervision, teaching and mentoring, troubleshooting, program creation, technology evaluation and implementation, cross-department collaboration, and managing a production-lab environment. Managed day-to-day lab operations and maintained and troubleshot professional production technology Supervised three staff members Taught and mentored students, translating technical concepts and professional workflows into hands-on instruction Researched and evaluated emerging technology and helped lead a major equipment modernization initiative Coordinated cross-department projects supporting college programs, marketing, community partnerships, and outreach Coordinated a collaboration with a nationally broadcast television show that aired three seasons on the Sportsman Network, giving students production and editing opportunities, and personally edited portions of the show and created motion graphics for it",
 "metric:Student employees supervised": "Supervised the day-to-day work of three student employees",
 "metric:Genius Academy annual recurring revenue": "Played a substantial hands-on role in developing, launching, and operating Genius Academy, an education-focused offering that reached a peak of more than $70,000 in annual recurring revenue in 2022",
 "metric:Video deliverables in the national television collaboration": "Coordinated a college and industry collaboration involving 10+ video deliverables",
 "metric:Email audience size worked with at Genius One": "Designed marketing emails and built and managed segmented email marketing funnels for an audience of approximately 100,000 contacts",
 "metric:Students taught and mentored": "Taught and mentored 250+ students"
};

const METRICS = Object.entries(EVIDENCE).filter(([k]) => k.startsWith("metric:")).map(([, v]) => v);
const ENTITIES = ["Genius One", "Holley Performance", "Anytime Picture", "Lorain County Community College",
  "Genius Academy", "Adobe Creative Suite", "Cleveland Clinic", "Amazon", "Sportsman Network", "RentPup", "Onshape"];

type DefectClass = "SAFE_REFRAME" | "PREDICATE_DRIFT" | "SCOPE_ESCALATION"
  | "TARGET_TERMINOLOGY_INJECTION" | "QUALIFIER_LOSS" | "TEMPORAL_DRIFT";
interface Case { name: string; klass: DefectClass; before: string; after: string;
  evidenceKeys: string[]; jobText: string; why: string }

const STRIPE_PRICING = "Portfolio Pricing Strategist. Delivering Pricing, Go-to-Market, or Product recommendations, "
  + "or working on highly strategic projects. Experience conducting qualitative and quantitative user research on "
  + "product needs and value perceptions, as well as competitive benchmarking.";
const AFFIRM_TPM = "Staff Technical Program Manager. Track record of strong stakeholder management with Engineering, "
  + "Product, Design, Analytics, and business teams. Experience driving strategy and cross-functional programs.";
const SAMSARA_CS = "Customer Success Manager II. 2-4+ years in customer success, account management, sales, or "
  + "strategic consulting. Diplomacy, tact, and poise under pressure when working through customer issues.";
const LEGAL_OPS = "Legal Operations Specialist. Support legal operations workflows, contract lifecycle management, "
  + "and vendor management for the legal team.";
const CREATIVE = "Forward Deployed Creative Designer, Ads. Performance marketing literacy. Brand and campaign work "
  + "across multiple brands and concurrent projects.";

const CASES: Case[] = [
  // ---- the live failure that started this ---------------------------
  {
    name: "pricing strategy and go-to-market, from a row that mentions neither",
    klass: "TARGET_TERMINOLOGY_INJECTION",
    before: "Execute marketing, product, ecommerce, creative, and operational initiatives against company priorities, taking loosely defined objectives from idea through implementation.",
    after: "Developed pricing strategy and go-to-market initiatives by collaborating across marketing, product, and operations teams to translate business objectives into executable plans.",
    evidenceKeys: ["geniusNow"], jobText: STRIPE_PRICING,
    why: "the evidence row contains no pricing, no go-to-market and no strategy; a reader concludes he did pricing strategy work",
  },
  {
    // The guard is given the wording the MASTER resume holds, never the
    // previous pass's output. Comparing against the previous pass would
    // let an accepted invention become the baseline for the next one,
    // which is how a second pass launders a first-pass mistake.
    name: "a second pass cannot inherit the first pass's invention",
    klass: "TARGET_TERMINOLOGY_INJECTION",
    before: "Execute marketing, product, ecommerce, creative, and operational initiatives against company priorities, taking loosely defined objectives from idea through implementation.",
    after: "Collaborated across marketing, product, and operations teams to develop pricing strategy and go-to-market initiatives that translated business objectives into executable plans.",
    evidenceKeys: ["geniusNow"], jobText: STRIPE_PRICING,
    why: "the second pass inherits the first pass's invention and launders it further",
  },
  {
    name: "legal operations attached to teaching students",
    klass: "TARGET_TERMINOLOGY_INJECTION",
    before: "Taught and mentored 250+ students.",
    after: "Mentored over 250 students in technical concepts and professional workflows applicable to legal operations.",
    evidenceKeys: ["metric:Students taught and mentored"], jobText: LEGAL_OPS,
    why: "the workflows he taught were whatever they were; the posting decided they were legal operations",
  },

  // ---- verbs that move from taking part to organising ---------------
  {
    name: "collaborated becomes coordinated",
    klass: "SCOPE_ESCALATION",
    before: "Collaborated cross-functionally with marketing and other teams to set creative approaches and run projects from planning through delivery.",
    after: "Coordinated across marketing and multiple teams to develop creative strategies and execute projects from conception through completion.",
    evidenceKeys: ["holley"], jobText: AFFIRM_TPM,
    why: "collaborating with teams and coordinating them are different roles, and the evidence says the first",
  },
  {
    name: "produced creative work becomes coordinated creative production",
    klass: "SCOPE_ESCALATION",
    before: "Produced creative work across multiple brands, internal teams, and concurrent projects with shifting priorities and deadlines.",
    after: "Coordinated creative production across multiple internal teams and concurrent projects while supporting broader marketing initiatives.",
    evidenceKeys: ["holley"], jobText: AFFIRM_TPM,
    why: "doing the work became directing the people who do it",
  },
  {
    name: "approaches become strategies",
    klass: "SCOPE_ESCALATION",
    before: "Collaborated cross-functionally with marketing and other teams to set creative approaches and run projects from planning through delivery.",
    after: "Collaborated cross-functionally with marketing and other teams to develop creative strategies and run projects from planning through delivery.",
    evidenceKeys: ["holley"], jobText: AFFIRM_TPM,
    why: "an approach is how a piece of work was done; a strategy is a claim about owning direction",
  },

  // ---- bounding language that disappears -----------------------------
  {
    name: "the owner disappears from a coordination claim",
    klass: "QUALIFIER_LOSS",
    before: "Coordinated with the owner, a small internal team, partners, instructors, customers, and other stakeholders, and researched emerging products and technologies at industry trade shows.",
    after: "Researched emerging products and technologies at industry trade shows and coordinated cross-functional execution with internal teams, partners, instructors, and customers.",
    evidenceKeys: ["geniusOld"], jobText: SAMSARA_CS,
    why: "coordinating WITH the owner and coordinating execution are different; the owner set direction and the evidence says so",
  },
  {
    name: "multiple brands is dropped",
    klass: "QUALIFIER_LOSS",
    before: "Produced creative work across multiple brands, internal teams, and concurrent projects with shifting priorities and deadlines.",
    after: "Produced creative work across internal teams and concurrent projects with shifting priorities and deadlines.",
    evidenceKeys: ["holley"], jobText: CREATIVE,
    why: "dropping a scope word is usually harmless; this one is the breadth the sentence was about",
  },
  {
    name: "personally edited portions becomes edited the show",
    klass: "QUALIFIER_LOSS",
    before: "Personally edited portions of the show and created motion graphics for it.",
    after: "Edited the show and created motion graphics for it.",
    evidenceKeys: ["lccc"], jobText: CREATIVE,
    why: "portions is the whole difference between contributing to an edit and being the editor",
  },
  {
    name: "played a substantial hands-on role becomes built",
    klass: "SCOPE_ESCALATION",
    before: "Played a substantial hands-on role in developing, launching, and operating Genius Academy.",
    after: "Developed, launched, and operated Genius Academy.",
    evidenceKeys: ["metric:Genius Academy annual recurring revenue"], jobText: AFFIRM_TPM,
    why: "the approved wording says a role in it; the rewrite says he did it",
  },

  // ---- when it happened ---------------------------------------------
  {
    name: "a current role becomes past tense",
    klass: "TEMPORAL_DRIFT",
    before: "Execute marketing, product, ecommerce, creative, and operational initiatives against company priorities.",
    after: "Executed marketing, product, ecommerce, creative, and operational initiatives against company priorities.",
    evidenceKeys: ["geniusNow"], jobText: STRIPE_PRICING,
    why: "the role is current; past tense reads as finished work at a former employer",
  },

  // ---- reframings that must keep working ----------------------------
  {
    name: "plainer words, same claim",
    klass: "SAFE_REFRAME",
    before: "Collaborated cross-functionally with marketing and other teams to set creative approaches and run projects from planning through delivery.",
    after: "Worked with marketing and other teams to set creative approaches and to run projects from planning through delivery.",
    evidenceKeys: ["holley"], jobText: AFFIRM_TPM,
    why: "nothing added, nothing dropped, ordinary synonym",
  },
  {
    name: "reordered for emphasis",
    klass: "SAFE_REFRAME",
    before: "Coordinated with the owner, a small internal team, partners, instructors, customers, and other stakeholders, and researched emerging products and technologies at industry trade shows.",
    after: "Researched emerging products and technologies at industry trade shows, and coordinated with the owner, a small internal team, partners, instructors, customers, and other stakeholders.",
    evidenceKeys: ["geniusOld"], jobText: SAMSARA_CS,
    why: "the same two claims, in the other order",
  },
  {
    name: "compressed without loss",
    klass: "SAFE_REFRAME",
    before: "Designed marketing emails and built and managed segmented email marketing funnels for an audience of approximately 100,000 contacts.",
    after: "Designed marketing emails and built segmented email marketing funnels for an audience of approximately 100,000 contacts.",
    evidenceKeys: ["metric:Email audience size worked with at Genius One"], jobText: AFFIRM_TPM,
    why: "drops managed, which narrows the claim rather than widening it",
  },
  {
    name: "the truthful version of the students sentence",
    klass: "SAFE_REFRAME",
    before: "Taught and mentored 250+ students.",
    after: "Taught and mentored more than 250 students.",
    evidenceKeys: ["metric:Students taught and mentored"], jobText: LEGAL_OPS,
    why: "same number, same verb, different words for the same thing",
  },
  {
    name: "evidence vocabulary the posting happens to share",
    klass: "SAFE_REFRAME",
    before: "Produced creative work across multiple brands, internal teams, and concurrent projects with shifting priorities and deadlines.",
    after: "Produced creative work for multiple brands and concurrent projects under shifting priorities and deadlines.",
    evidenceKeys: ["holley"], jobText: CREATIVE,
    why: "brands and projects are the posting's words AND the evidence's, so using them is not contamination",
  },
];



const evidenceFor = (keys: string[]) => keys.map((k) => EVIDENCE[k]!).join(" ");

for (const c of CASES) {
  const v = checkGrounding({
    claim: c.after, evidenceIds: c.evidenceKeys, sourceText: evidenceFor(c.evidenceKeys),
    approvedMetrics: METRICS, knownEntities: ENTITIES, targetJobText: c.jobText, original: c.before,
  });
  if (c.klass === "SAFE_REFRAME") {
    check(`a legitimate reframing is accepted: ${c.name}`, v.ok,
      `${v.failedCheck}: ${v.failureDetail}`);
  } else {
    check(`${c.klass} is refused: ${c.name}`, !v.ok, `it was ACCEPTED. ${c.why}`);
  }
}

// The comparison checks only apply to rewrites. A master claim is not a
// rewrite of anything, and asking it to compare against nothing would
// refuse the whole resume.
{
  const v = checkGrounding({
    claim: "Taught and mentored 250+ students.", evidenceIds: ["m"],
    sourceText: EVIDENCE["metric:Students taught and mentored"]!,
    approvedMetrics: METRICS, knownEntities: ENTITIES,
  });
  check("with no earlier wording, the comparison checks report that rather than failing",
    v.ok && v.checks.filter((x) => /NO_QUALIFIER_LOSS|NO_TEMPORAL_DRIFT|NO_ROLE_ESCALATION/.test(x.check))
      .every((x) => x.ok && /no earlier wording/.test(x.detail)),
    JSON.stringify(v.checks.filter((x) => !x.ok)));
}

// Each hardened check is reachable on its own.
{
  const src = EVIDENCE["holley"]!;
  const common = { evidenceIds: ["h"], sourceText: src, approvedMetrics: METRICS, knownEntities: ENTITIES };
  const cases: Array<[string, string, string, string]> = [
    ["NO_QUALIFIER_LOSS", "Supported the rollout across multiple brands.", "Supported the rollout.", ""],
    ["NO_TEMPORAL_DRIFT", "Produce creative work for multiple brands.", "Produced creative work for multiple brands.", ""],
    ["NO_ROLE_ESCALATION", "Collaborated with marketing on creative work.", "Managed marketing creative work.", ""],
  ];
  for (const [expected, before, after, job] of cases) {
    const v = checkGrounding({ ...common, claim: after, original: before, targetJobText: job });
    check(`${expected} fires on its own case`, !v.ok, `accepted: ${after}`);
  }
}

// while three of those began in 2019.
{
  const { checkClaims } = await import("../lib/render/claimGuards.ts");
  const fires = (t: string) => checkClaims(t).length > 0;
  console.log("\nidentity and temporal scope");
  check("generalist is refused", fires("Generalist with broad experience."));
  check("generalists is refused", fires("We value generalists."));
  check("a year governing a list is refused",
    fires("Experience since 2016 spanning ecommerce and email marketing, physical product development, and video production."));
  check("and the from variant", fires("From 2016, spanning marketing, product development, and coordination."));
  check("a dated single fact still passes", !fires("Instructed video production at the college from 2016 to 2019."));
  check("an undated span still passes", !fires("Work spanning marketing, product development, and video production."));
  check("the shipped summary passes",
    !fires("Cross-functional marketing, product, and operations professional who takes business needs from problem "
      + "to practical solution, working through loosely defined objectives from idea through implementation and "
      + "troubleshooting challenges along the way. Work spanning marketing and ecommerce, physical product "
      + "development, video production, and an independent product built outside of full-time work."));
}



console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }