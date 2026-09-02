/**
 * The summary, selected for the job rather than written once.
 *
 * The master summary was a single paragraph shipped to every employer,
 * and it had two problems. It enumerated the whole career, so a
 * marketing role was told about physical product development and a
 * product role was told about video. And its first sentence said the
 * same thing three times: "problem to practical solution", "idea
 * through implementation" and "troubleshooting challenges along the way"
 * are one operating pattern described three ways, which reads as padding.
 *
 * The structure here is fixed at three sentences and the contents are
 * chosen per job:
 *
 *   1. identity and how he works
 *   2. the breadth that is relevant HERE, with a proof point when one
 *      actually strengthens this application
 *   3. one differentiator that matters for this posting
 *
 * Every fragment carries the evidence rows it came from, and nothing is
 * emitted whose rows are absent from the frozen set. The identity is
 * composed rather than copied: "cross-functional product and operations
 * professional" does not require that string to exist in a past title,
 * it requires the product work and the operations work to be in the
 * record. The guards stop unsupported specialization; they are not there
 * to force a resume to recite job titles.
 */
import type { FrozenRow, ResumeLine } from "./resume.ts";
import { profileFor, scoreCapability, type RelevanceProfile } from "./relevance.ts";

export const SUMMARY_VERSION = 1;

/** A functional area, the words that signal it, and what proves it. */
interface Area {
  key: string;
  /** How it reads inside an identity phrase. */
  identity: string;
  /** Atomic terms for the breadth list. Joined with commas, so each one
   *  must read on its own: a phrase containing "and" produces
   *  "marketing and ecommerce and video and creative production". */
  breadth: string[];
  /** Terms that make this area relevant to a posting. */
  signals: string[];
  /** Employment rows that must be present for this to be claimed. */
  needs: (r: FrozenRow) => boolean;
}

const employer = (name: string) => (r: FrozenRow) =>
  r.source_table === "employment_records" && String(r.row_data.employer ?? "").includes(name);

const AREAS: Area[] = [
  { key: "marketing", identity: "marketing", breadth: ["marketing", "ecommerce"],
    signals: ["marketing", "campaign", "brand", "content", "seo", "email", "demand", "growth", "communications"],
    needs: employer("Genius One") },
  { key: "product", identity: "product", breadth: ["product development"],
    signals: ["product", "roadmap", "discovery", "prototype", "feature", "user"],
    needs: employer("Genius One") },
  { key: "operations", identity: "operations", breadth: ["operations", "program coordination"],
    signals: ["operations", "operational", "process", "program", "project", "coordination", "workflow", "intake", "logistics"],
    needs: employer("Genius One") },
  { key: "creative", identity: "creative production", breadth: ["video and creative production"],
    signals: ["video", "creative", "production", "editing", "motion", "brand", "media"],
    needs: employer("Anytime Picture") },
];

/** A proof point, used only where it strengthens THIS application. */
interface Proof {
  key: string;
  text: (wording: string) => string;
  signals: string[];
  /** Finds the row that carries the approved wording. */
  find: (rows: FrozenRow[]) => FrozenRow | undefined;
}

const PROOFS: Proof[] = [
  {
    key: "email-list",
    signals: ["email", "marketing", "campaign", "crm", "lifecycle", "audience", "communications", "newsletter"],
    find: (rows) => rows.find((r) => r.source_table === "metrics"
      && /segmented email|100,?000|contacts/i.test(String(r.row_data.approved_wording ?? ""))),
    text: (w) => w.charAt(0).toLowerCase() + w.slice(1),
  },
  {
    key: "rentpup-arr",
    signals: ["product", "saas", "revenue", "startup", "founder", "platform", "software", "growth"],
    find: (rows) => rows.find((r) => r.source_table === "metrics"
      && /\$?70,?000|ARR|recurring revenue/i.test(String(r.row_data.approved_wording ?? ""))),
    text: (w) => w.charAt(0).toLowerCase() + w.slice(1),
  },
  {
    key: "supervision",
    signals: ["lead", "manage", "supervise", "mentor", "team", "training", "instruction"],
    find: (rows) => rows.find((r) => r.source_table === "metrics"
      && /supervis/i.test(String(r.row_data.approved_wording ?? ""))),
    text: (w) => w.charAt(0).toLowerCase() + w.slice(1),
  },
];

/** A closing differentiator, chosen for the posting. */
interface Differentiator {
  key: string;
  signals: string[];
  text: string;
  needs: (rows: FrozenRow[]) => FrozenRow | undefined;
}

const DIFFERENTIATORS: Differentiator[] = [
  {
    key: "independent-product",
    signals: ["product", "software", "technical", "platform", "saas", "ai", "data", "automation"],
    text: "Also builds and operates an independent software product outside of full-time work, "
        + "covering the whole path from problem to running system.",
    needs: (rows) => rows.find((r) => r.source_table === "projects" && r.row_data.name === "RentPup"),
  },
  {
    key: "small-team-scope",
    signals: ["startup", "small team", "generalist", "wear many hats", "scrappy", "early", "cross-functional", "owner"],
    text: "Used to small teams where the same person scopes the work, decides the approach, and delivers it.",
    needs: (rows) => rows.find((r) => r.source_table === "employment_records"
      && String(r.row_data.employer ?? "").includes("Genius One")),
  },
  {
    key: "stakeholder-translation",
    signals: ["stakeholder", "client", "partner", "communication", "training", "cross-department", "instruction"],
    text: "Comfortable translating between technical and non-technical stakeholders, from clients and partners "
        + "to internal teams.",
    needs: (rows) => rows.find((r) => r.source_table === "employment_records"
      && String(r.row_data.employer ?? "").includes("Lorain")),
  },
];

const relevance = (signals: string[], profile: RelevanceProfile): number =>
  signals.reduce((best, s) => Math.max(best, scoreCapability(s, profile)), 0);

export interface SummarySelection {
  line: ResumeLine;
  /** What was chosen and why, for the audit trail. */
  chose: { areas: string[]; proof: string | null; differentiator: string | null; words: number };
}

/**
 * Builds the summary for one posting.
 *
 * Falls back to the broadest supported identity when a posting matches
 * nothing, because a resume with no summary is worse than a general one.
 */
export function selectSummary(
  rows: FrozenRow[],
  roleTitle: string,
  requirementTerms: string[],
): SummarySelection {
  const profile = profileFor(roleTitle, requirementTerms);
  const sources = new Set<string>();

  // 1. Identity: the two or three relevant areas the record supports.
  const available = AREAS.filter((a) => rows.some(a.needs));
  const ranked = available
    .map((a) => ({ a, score: relevance(a.signals, profile) }))
    .sort((x, y) => y.score - x.score);
  const picked = ranked.filter((r) => r.score > 0).slice(0, 3);
  // Never empty. A posting that matches no signal still gets the
  // broadest supported identity, because "Work spanning undefined" is
  // what an unguarded fallback produces and it would have shipped.
  const chosenAreas = (picked.length >= 2 ? picked : ranked.slice(0, 2))
    .map((r) => r.a)
    .filter(Boolean);
  if (chosenAreas.length === 0) chosenAreas.push(...available.slice(0, 2));
  if (chosenAreas.length === 0) {
    // Nothing in the frozen set supports any area. There is no honest
    // summary to write, and inventing one is the failure this whole
    // system exists to prevent.
    return {
      line: { text: "", sources: [] },
      chose: { areas: [], proof: null, differentiator: null, words: 0 },
    };
  }
  for (const a of chosenAreas) {
    const row = rows.find(a.needs);
    if (row) sources.add(row.row_id);
  }
  const identityWords = chosenAreas.map((a) => a.identity);
  const identity = identityWords.length === 1 ? identityWords[0]!
    : `${identityWords.slice(0, -1).join(", ")}${identityWords.length > 2 ? "," : ""} and ${identityWords[identityWords.length - 1]}`;

  const first = `Cross-functional ${identity} professional who takes loosely defined objectives from idea `
    + `through implementation.`;

  // 2. Breadth, relevant here only.
  const list = (xs: string[]) => xs.length === 1 ? xs[0]!
    : `${xs.slice(0, -1).join(", ")}${xs.length > 2 ? "," : ""} and ${xs[xs.length - 1]}`;

  // 3. Either a proof point or a differentiator, never both.
  //
  // Both would make four sentences and push past the word budget, and of
  // the two a verified number does more for an application than a
  // statement about how he works. The differentiator is what closes when
  // no metric is relevant to this posting.
  const proof = PROOFS
    .map((p) => ({ p, score: relevance(p.signals, profile), row: p.find(rows) }))
    .filter((x) => x.row && x.score > 0)
    .sort((x, y) => y.score - x.score)[0];

  const diff = DIFFERENTIATORS
    .map((d) => ({ d, score: relevance(d.signals, profile), row: d.needs(rows) }))
    .filter((x) => x.row && x.score > 0)
    .sort((x, y) => y.score - x.score)[0];
  const fallback = DIFFERENTIATORS.find((d) => d.key === "small-team-scope");
  const chosenDiff = diff?.row ? diff : (fallback && fallback.needs(rows)
    ? { d: fallback, row: fallback.needs(rows)!, score: 0 } : undefined);

  let closing = "";
  let proofKey: string | null = null;
  let diffKey: string | null = null;
  if (proof?.row) {
    // Verbatim. The wording is what was approved, and paraphrasing an
    // approved metric is how a number stops being the number that was
    // checked.
    const w = String(proof.row.row_data.approved_wording).trim().replace(/\.$/, "");
    closing = `${w}.`;
    sources.add(proof.row.row_id);
    proofKey = proof.p.key;
  } else if (chosenDiff?.row) {
    closing = chosenDiff.d.text;
    sources.add(chosenDiff.row.row_id);
    diffKey = chosenDiff.d.key;
  }

  // Fit the budget by narrowing breadth, which is the part that can lose
  // an item without losing a claim. Nothing else is trimmed: the
  // identity and the approved wording are not negotiable.
  // Deduped and capped: a summary is not an inventory.
  let terms = [...new Set(chosenAreas.flatMap((a) => a.breadth))].slice(0, 4);
  let second = "";
  let text = "";
  for (;;) {
    second = `Work spanning ${list(terms)}.`;
    text = `${first} ${second} ${closing}`.replace(/\s+/g, " ").trim();
    if (text.split(/\s+/).length <= 65 || terms.length <= 2) break;
    terms = terms.slice(0, -1);
  }


  return {
    line: { text, sources: [...sources] },
    chose: {
      areas: chosenAreas.map((a) => a.key),
      proof: proofKey,
      differentiator: diffKey,
      words: text.split(/\s+/).length,
    },
  };
}
