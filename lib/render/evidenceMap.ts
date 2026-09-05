/**
 * Resume Builder v2, Step 2a: map job themes to VERIFIED evidence.
 *
 * A theme existing in a posting says nothing about whether the profile holds
 * it. Coverage is classified INDEPENDENTLY, by semantic entailment against
 * verified evidence -- not by keyword/token overlap, which both under-credits
 * genuine capability and over-credits noise.
 *
 *   DIRECT       the verified evidence actually ENTAILS the requirement: an
 *                exact skill, a composite whose every required component is
 *                verified, or an entailment rule whose evidence establishes it.
 *   TRANSFERABLE a closely relevant verified capability that does not
 *                establish the exact requirement (a relation adjacency, a
 *                composite with some-but-not-all components, or a
 *                deliberately-conservative entailment rule).
 *   WEAK         only loose token overlap -- suggestive, never enough for
 *                employer-facing terminology.
 *   NONE         nothing verified speaks to it.
 *
 * Only DIRECT and TRANSFERABLE are ever "covered"; token overlap never rises
 * above WEAK, so a gap can never be laundered into coverage.
 *
 * The rules are GENERAL: they key on requirement concepts that recur across
 * postings and reference verified evidence TYPES (named skills, grounded
 * master-résumé statements), not one job's wording. The index is purely
 * referential -- ids/refs only, shared across themes, never a factual claim.
 */
import { norm, relationResolve, type Resolution } from "../scoring/conceptRelations.ts";

export type Coverage = "DIRECT" | "TRANSFERABLE" | "WEAK" | "NONE";

/** One verified evidence item. `text` is what it is matched on. `source` is
 *  its type: "skills" | "master" (a grounded résumé statement) | "projects"
 *  | "metrics" | ... */
export interface EvidenceItem { ref: string; source: string; text: string; }
export interface VerifiedPool { items: EvidenceItem[]; skillNames: string[]; }

export interface EvidenceRef { ref: string; source: string; strength: number; }
export interface ThemeCoverage { themeId: string; coverage: Coverage; evidence: EvidenceRef[]; }
export interface EvidenceIndex { byTheme: Map<string, ThemeCoverage>; }

const STOP = new Set([
  "and", "or", "of", "the", "a", "to", "in", "for", "with", "on", "other", "skills",
  "experience", "ability", "strong", "proficiency", "platforms", "related", "field",
  "using", "within", "across", "including", "etc",
]);
const toks = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));

/**
 * Composite (conjunctive) requirements. A posting that asks for
 * "PowerPoint, Excel AND Word" is only fully met when every materially
 * required component is verified. DIRECT requires all groups; some-but-not-all
 * is TRANSFERABLE; none is left to fall through. An umbrella may never grant
 * DIRECT while a required component is missing.
 */
const COMPOSITES: { match: RegExp; groups: string[][] }[] = [
  {
    match: /^(microsoft office|ms office|office suite)$/,
    groups: [
      ["excel", "microsoft excel", "google sheets", "spreadsheets"],
      ["powerpoint", "microsoft powerpoint", "google slides", "keynote"],
      ["word", "microsoft word", "google docs", "word processing"],
    ],
  },
];

type Cond = { anySkill?: string[]; allGroups?: string[][]; evidenceSignature?: RegExp };
interface EntailmentRule { id: string; match: RegExp; direct?: Cond[]; transferable?: Cond[]; }

/**
 * General semantic entailment rules. Each keys on a recurring requirement
 * concept and names the verified evidence that ESTABLISHES it (direct) or is
 * merely adjacent (transferable). Executive reporting is deliberately absent:
 * teaching/presentation evidence supports communication, NOT executive
 * reporting, so it stays uncovered.
 */
const ENTAILMENT: EntailmentRule[] = [
  {
    id: "communication",
    match: /\bcommunicat|verbal|written communication|presentation communication$/,
    // Teaching 250+ students, client-facing solutioning and phone sales each
    // require and demonstrate professional verbal/written/presentation
    // communication. External partnership coordination is deliberately NOT
    // here: coordinating a partnership is not, on its own, evidence of
    // professional communication as a job requirement.
    direct: [{ anySkill: ["teaching and mentoring", "client needs assessment", "phone sales", "customer support"] }],
  },
  {
    id: "problem-solving",
    match: /problem[- ]solv|analytical mindset|analytical$/,
    // Solution development and client needs assessment ARE applied
    // problem-solving; the contract solutioning evidence establishes it.
    direct: [
      { anySkill: ["solution development", "client needs assessment"] },
      { evidenceSignature: /troubleshoot|develop solutions|translat[^.]*(goal|need)[^.]*solution|within[^.]*(budget|constraint)/i },
    ],
  },
  {
    id: "cross-functional-project",
    match: /cross[- ]functional|cross[- ]department/,
    // Cross-functional project experience is established by holding an
    // INTERNAL cross-team collaboration capability AND a project-execution
    // capability. External partnership coordination (an external partnership)
    // is not internal cross-functional collaboration and is excluded here.
    direct: [{ allGroups: [["cross-department collaboration"], ["project coordination"]] }],
  },
  {
    id: "multitasking",
    match: /multitask|multiple priorities|manage multiple|competing priorities|concurrent workload|multiple projects/,
    // Routed through the verified capability "Managing concurrent priorities"
    // (a real skill, tagged on the bullet that establishes it), NOT a text
    // signature. This keeps the coverage provenance structural.
    direct: [{ anySkill: ["managing concurrent priorities"] }],
  },
  {
    id: "milestone-tracking",
    match: /milestone|action items|risks? (and|&) dependenc|dependenc/,
    // Conservative: automating project workflows (state/progression) is
    // adjacent to milestone/risk/dependency tracking, but generic project
    // coordination is NOT sufficient adjacency and is excluded. Transferable
    // only, never DIRECT.
    transferable: [{ anySkill: ["workflow automation", "asana"] }],
  },
];

export function mapThemesToEvidence(themes: { term: string }[], pool: VerifiedPool): EvidenceIndex {
  const skillItems = pool.items.filter((i) => i.source === "skills");
  const skillsMatching = (name: string): EvidenceItem[] => {
    const q = norm(name);
    return skillItems.filter((i) => { const n = norm(i.text); return n === q || n.includes(q) || q.includes(n); });
  };
  const hasSkill = (name: string) => skillsMatching(name).length > 0;
  const has = (name: string) => hasSkill(name);
  const skillByName = new Map(skillItems.map((i) => [norm(i.text), i]));

  const condRefs = (c: Cond): EvidenceRef[] | null => {
    if (c.anySkill) {
      const hit = c.anySkill.flatMap((s) => skillsMatching(s));
      return hit.length ? hit.map((i) => ({ ref: i.ref, source: i.source, strength: 1 })) : null;
    }
    if (c.allGroups) {
      const refs: EvidenceRef[] = [];
      for (const group of c.allGroups) {
        const hit = group.flatMap((s) => skillsMatching(s))[0];
        if (!hit) return null;                       // a required group is unmet
        refs.push({ ref: hit.ref, source: hit.source, strength: 1 });
      }
      return refs;
    }
    if (c.evidenceSignature) {
      const hit = pool.items.filter((i) => c.evidenceSignature!.test(i.text));
      return hit.length ? hit.slice(0, 3).map((i) => ({ ref: i.ref, source: i.source, strength: 1 })) : null;
    }
    return null;
  };

  const byTheme = new Map<string, ThemeCoverage>();
  for (const th of themes) {
    const term = th.term;
    if (byTheme.has(term)) continue;
    const q = norm(term);
    const set = (coverage: Coverage, evidence: EvidenceRef[]) => byTheme.set(term, { themeId: term, coverage, evidence });

    // 1. Composite/conjunctive requirement: every required component must be verified for DIRECT.
    const comp = COMPOSITES.find((c) => c.match.test(q));
    if (comp) {
      const met: EvidenceRef[] = [];
      let missing = 0;
      for (const group of comp.groups) {
        const hit = group.flatMap((g) => skillsMatching(g))[0];
        if (hit) met.push({ ref: hit.ref, source: hit.source, strength: 1 }); else missing++;
      }
      if (met.length === 0) set("NONE", []);
      else if (missing === 0) set("DIRECT", met);
      else set("TRANSFERABLE", met);           // some-but-not-all: never DIRECT
      continue;
    }

    // 2. Direct possession: a verified skill IS this theme, or is MORE SPECIFIC
    //    than it (a specific capability entails the broader requirement).
    //    e.g. requirement "excel" is satisfied by capability "microsoft excel".
    const direct = skillItems.filter((i) => { const n = norm(i.text); return n === q || n.includes(q); });
    if (direct.length) { set("DIRECT", direct.map((s) => ({ ref: s.ref, source: s.source, strength: 1 }))); continue; }

    // 3. Semantic entailment rules (direct, then transferable).
    const rule = ENTAILMENT.find((r) => r.match.test(q));
    if (rule) {
      let done = false;
      for (const c of rule.direct ?? []) { const refs = condRefs(c); if (refs) { set("DIRECT", refs); done = true; break; } }
      if (done) continue;
      for (const c of rule.transferable ?? []) { const refs = condRefs(c); if (refs) { set("TRANSFERABLE", refs); done = true; break; } }
      if (done) continue;
    }

    // 4. Deterministic concept relation over verified skills.
    const rr = relationResolve(term, "ABSENT" as Resolution, has);
    if (rr.resolution === "DIRECT" || rr.resolution === "TRANSFERABLE") {
      const refs = (rr.via ?? []).map((n) => skillByName.get(norm(n))).filter((it): it is EvidenceItem => !!it)
        .map((it) => ({ ref: it.ref, source: it.source, strength: rr.resolution === "DIRECT" ? 1 : 0.6 }));
      set(rr.resolution, refs);
      continue;
    }

    // 4b. A capability BROADER than the requirement (the requirement text
    //     contains the capability, e.g. requirement "ai workflow automation"
    //     vs capability "workflow automation") is a legitimate adjacency, but
    //     must NOT be promoted to DIRECT -- it is TRANSFERABLE.
    const broader = skillItems.filter((i) => { const n = norm(i.text); return n.length >= 5 && n !== q && q.includes(n); });
    if (broader.length) { set("TRANSFERABLE", broader.map((s) => ({ ref: s.ref, source: s.source, strength: 0.6 }))); continue; }

    // 5. Loose token overlap -> never above WEAK.
    const tset = toks(term);
    const scored = pool.items.map((i) => ({ i, overlap: tset.filter((t) => toks(i.text).includes(t)).length }))
      .filter((x) => x.overlap > 0).sort((a, b) => b.overlap - a.overlap);
    if (scored.length) { set("WEAK", scored.slice(0, 3).map((x) => ({ ref: x.i.ref, source: x.i.source, strength: 0.25 }))); continue; }

    set("NONE", []);
  }

  return { byTheme };
}

export const isCovered = (c: Coverage): boolean => c === "DIRECT" || c === "TRANSFERABLE";
