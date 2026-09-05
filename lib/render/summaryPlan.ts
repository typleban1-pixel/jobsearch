/**
 * Resume Builder v2, Step 3B: deterministic summary framing.
 *
 * The summary is generated from the NarrativePlan and the Step 3A selection --
 * no model call. It leads with the target role's dominant qualification story
 * (plan.primaryStory), NOT the historically highest-scoring functional area;
 * it draws only on themes with STRONG (DIRECT) verified evidence; it never
 * mentions a gap and never implies domain experience the profile lacks; and it
 * includes a metric only when a selected verified accomplishment materially
 * strengthens the story (never mechanically). It is recruiter-facing prose
 * that answers "why this person fits this kind of work", not a capability list.
 *
 * Import-inert; wired by nothing yet. No em dashes (employer-facing copy).
 */
import type { NarrativePlan } from "./narrativePlan.ts";
import type { SelectionResult } from "./coverageSelect.ts";

/** The lead sentence per dominant story. Deliberate, role-shaped, no lists. */
const AREA_LEAD: Record<string, string> = {
  coordination: "Operations and project-coordination specialist who takes loosely defined initiatives from planning through execution across cross-functional teams.",
  marketing: "Marketing and growth specialist who takes campaigns and funnels from strategy through execution and measurement.",
  product: "Product-minded builder who takes offerings from concept through launch and ongoing operation.",
  analysis: "Analytical operator who turns research and data into decisions and follow-through.",
  communication: "Client-facing operator who translates goals into delivered outcomes across teams.",
  other: "Versatile operator who takes loosely defined objectives from idea through implementation.",
};

/** Short verb phrases so the second sentence reads as strengths, not a dump. */
const PHRASE: Record<string, string> = {
  "project coordination": "coordinating projects to delivery",
  "collaboration": "working across functions",
  "cross-functional project experience": "running cross-functional initiatives",
  "process improvement": "improving the process along the way",
  "communication skills": "communicating with stakeholders",
  "multitasking": "managing concurrent priorities",
  "problem-solving": "solving problems under real constraints",
  "microsoft office": "building reporting in Excel and PowerPoint",
  "seo": "driving organic search growth",
  "paid search": "running paid acquisition",
  "digital marketing": "executing digital campaigns end to end",
  "email marketing": "building and running email funnels",
  "audience segmentation": "segmenting audiences",
  "campaign execution": "executing campaigns",
  "product ideation": "shaping product ideas",
  "iterative product development": "developing products iteratively",
  "requirements definition": "defining requirements",
  "product launch": "launching new offerings",
  "solution development": "developing solutions",
  "ai workflow automation": "automating workflows",
};
const phraseOf = (id: string) => PHRASE[id] ?? id;


export interface SummaryResult {
  text: string;
  leadArea: string;
  /** themes that drove the summary, with the plan's supporting evidence refs. */
  drivingThemes: { id: string; evidence: string[] }[];
  /** a selected quantitative accomplishment, only when it strengthens the story. */
  metric: { text: string; strengthens: string } | null;
  /** gap themes deliberately kept out of the summary. */
  gapsExcluded: string[];
}

/** A compact, standalone verified metric statement, tagged with the themes it
 *  strengthens. NOT a reframe of an experience bullet. */
export interface MetricPhrase { phrase: string; themes: string[] }

export function buildSummary(plan: NarrativePlan, selection: SelectionResult, metrics: MetricPhrase[] = []): SummaryResult {
  const strong = new Set(plan.themes.filter((t) => t.coverage === "DIRECT").map((t) => t.id));
  const primary = plan.primaryStory.themeIds.filter((id) => strong.has(id));
  const support = plan.supportingThemes.filter((id) => strong.has(id) && !plan.primaryStory.themeIds.includes(id));

  // Driving set: up to two primary strengths plus up to two supporting, so the
  // second sentence stays a focused claim rather than a capability list.
  const drivingIds = [...primary.slice(0, 2), ...support.slice(0, 2)];
  const lead = AREA_LEAD[plan.primaryStory.areaId] ?? AREA_LEAD.other;

  let text = lead!;
  const phrases = drivingIds.map(phraseOf).slice(0, 3);
  if (phrases.length) {
    const joined = phrases.length === 1 ? phrases[0]
      : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
    text += ` Comfortable ${joined}.`;
  }

  // Metric: a COMPACT, standalone verified metric statement that covers a
  // PRIMARY story theme. Never a reframe of a selected experience bullet, and
  // never a duplicate of one -- so the render's no-duplicate guard always
  // passes and the summary reads tightly. Never forced; omitted when none
  // qualifies.
  const primarySet = new Set(plan.primaryStory.themeIds);
  const selectedLower = selection.selected.map((s) => s.text.toLowerCase());
  const duplicates = (p: string) => { const pl = p.toLowerCase().replace(/\s+/g, " ").trim(); return selectedLower.some((t) => { const tl = t.replace(/\s+/g, " ").trim(); return tl.includes(pl) || pl.includes(tl); }); };
  const metricCand = metrics
    .filter((m) => m.themes.some((t) => primarySet.has(t)) && !duplicates(m.phrase))
    .sort((a, b) => b.themes.filter((t) => primarySet.has(t)).length - a.themes.filter((t) => primarySet.has(t)).length)[0];
  let metric: SummaryResult["metric"] = null;
  if (metricCand) {
    const strengthens = metricCand.themes.find((t) => primarySet.has(t))!;
    metric = { text: metricCand.phrase, strengthens };
    text += ` ${metricCand.phrase}`;
  }

  const evByTheme = new Map(plan.themes.map((t) => [t.id, t.evidence.map((e) => e.ref)]));
  return {
    text,
    leadArea: plan.primaryStory.areaId,
    drivingThemes: drivingIds.map((id) => ({ id, evidence: evByTheme.get(id) ?? [] })),
    metric,
    gapsExcluded: plan.gaps.map((g) => g.themeId),
  };
}
