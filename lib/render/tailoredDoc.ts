/**
 * The tailored resume as CONTENT, before anything decides how it looks.
 *
 * Two jobs, both deliberately free of presentation:
 *
 *   assemble   turn the accepted tailored claims into a ResumeDoc,
 *              substituting each line for its rewritten counterpart and
 *              dropping anything not selected
 *   select     decide which grounded material this particular role gets,
 *              by relevance, so a resume is not simply every bullet the
 *              evidence can support
 *
 * Nothing here rewrites, shortens or invents. Selection can only DROP a
 * line that was already grounded and accepted; the words themselves come
 * from the tailoring step and its guards, unchanged.
 */
import type { ResumeDoc, ResumeLine, ResumeProject, ResumeRole } from "./resume.ts";
import { profileFor, scoreClaim, scoreCapability, type RelevanceProfile } from "./relevance.ts";
import { assertChronologyIntact, selectEmployment } from "./chronology.ts";
import { collapseRedundant } from "./redundancy.ts";

export const TAILORED_DOC_VERSION = 1;

export interface AcceptedClaim {
  /** The master line this was derived from; the key assembly matches on. */
  original: string;
  claim: string;
  evidenceIds: string[];
  generation: string | null;
}

/**
 * Ceilings, never targets.
 *
 * There is deliberately no total-bullet figure. A fixed budget makes
 * length a quota to fill, which is how a resume ends up padded, and it
 * makes every application the same size regardless of how much of the
 * evidence actually speaks to it. Relevance decides how much appears; a
 * position with two relevant things to say gets two bullets.
 */
export interface DensityBudget {
  /** Ceiling per position, so one role cannot become a wall. */
  maxPerRole: number;
  /** Ceiling on the summary. */
  summarySentences: number;
  /**
   * Ceiling on the optional claims beneath one project.
   *
   * Lower than a position's, because a project is not a job. It carries
   * an identity line of its own that a role does not have, and the
   * evidence pool behind a project the person is actively building can
   * be far larger than the pool behind a job they left: RentPup offers
   * eighteen showable statements against a role's four or five. Without
   * a ceiling, "has the most evidence" would quietly become "gets the
   * most space", which is the pool size deciding the layout.
   */
  maxPerProject: number;
}

/**
 * Ceilings only.
 *
 * There is deliberately no total-bullet figure and no per-role minimum.
 * A minimum is a quota wearing a different name: it makes an employment
 * entry demand a sentence merely by existing, which is layout creating
 * demand for content. A position whose evidence says nothing about this
 * particular job appears as title, employer and dates with no bullets at
 * all, which keeps the chronology honest without padding it.
 */
export const DEFAULT_BUDGET: DensityBudget = {
  maxPerRole: 5,
  summarySentences: 3,
  maxPerProject: 3,
};

/**
 * Substitutes tailored wording into the master structure, and keeps only
 * what selection chose.
 *
 * Matching is by the evidence a line cites, not by its text, because the
 * text is exactly what tailoring changed. A master line with no accepted
 * tailored counterpart is DROPPED rather than falling back silently:
 * this function's contract is that everything it returns was accepted by
 * the guards for this application.
 */
export function assembleTailoredDoc(
  master: ResumeDoc,
  accepted: AcceptedClaim[],
  roleContextTerms: string[],
  budget: DensityBudget = DEFAULT_BUDGET,
  roleTitle = "",
): { doc: ResumeDoc; dropped: Array<{ line: string; why: string }>; summaryIncomplete?: boolean } {
  const dropped: Array<{ line: string; why: string }> = [];
  const profile = profileFor(roleTitle, roleContextTerms);

  // Matched on the ORIGINATING LINE, not the evidence set.
  //
  // Several distinct claims legitimately cite one employment record: the
  // Holley role has four. Keying on evidence collapsed them to one and
  // then reissued it for each line, so the resume repeated a sentence
  // four times. A line is identified by the line it came from.
  const byOriginal = new Map<string, AcceptedClaim>();
  for (const c of accepted) if (!byOriginal.has(c.original)) byOriginal.set(c.original, c);

  const tailor = (line: ResumeLine): ResumeLine | null => {
    const t = byOriginal.get(line.text);
    if (!t) { dropped.push({ line: line.text, why: "no accepted tailored line derives from it" }); return null; }
    return { text: t.claim, sources: line.sources };
  };

  // -- summary: kept short, by sentence, never re-worded ---------------
  const summaryLine = tailor(master.summary) ?? master.summary;
  const sentences = summaryLine.text.match(/[^.!?]+[.!?]+/g) ?? [summaryLine.text];
  // Each captured sentence keeps the space that preceded it, so joining
  // them with another space produced "work.  Experience" on every
  // tailored resume. Trimming each piece before the join fixes it where
  // it happens. Whitespace is presentation: no word, number, qualifier
  // or citation changes, and normalizeProse below is the backstop.
  const summary: ResumeLine = {
    text: normalizeProse(sentences.slice(0, budget.summarySentences).map((x) => x.trim()).join(" ")),
    sources: summaryLine.sources,
  };
  if (sentences.length > budget.summarySentences) {
    dropped.push({ line: sentences.slice(budget.summarySentences).join(" ").trim(), why: "beyond the summary's sentence budget" });
  }

  // -- roles: relevance decides how much each one says ----------------
  //
  // Strongest first within the position, so what matters for THIS job is
  // the first thing read rather than whatever happened to be listed
  // first. A line that says nothing to this posting is dropped, except
  // that a surviving role always keeps something: the minimum exists to
  // avoid an empty heading, not to reach a length.
  // Relevance sets how much space each POSITION earns, and orders the
  // bullets inside it. Filtering bullet-by-bullet on overlap was too
  // literal: against a legal-operations posting almost nothing in this
  // profile shares vocabulary, and the resume collapsed to seven bullets
  // across six roles. A position that speaks to the job gets several
  // lines; a secondary one gets one or two; nothing is padded to match.
  const withScores = master.roles.map((r) => {
    // Scored on the MASTER wording, printed in the tailored wording.
    //
    // Selection used to score whatever the model produced, which let a
    // rewrite change a claim's relevance without changing a fact.
    // Measured on Candidate #3: "Executed digital marketing and
    // ecommerce work across websites, SEO, email, analytics, content,
    // creative production, and online storefronts" scores 0 -- no
    // measured relevance, must not print -- and the rewrite that swapped
    // "work" for "initiatives" scores 3 and reached the page. Same
    // facts, same evidence, different vocabulary, different outcome.
    // That is a closed loop between the writer and the scorer.
    //
    // Relevance is a property of the grounded claim, so it is measured
    // there. Tailoring decides how a selected claim is worded and has no
    // say in whether it is selected. Projects do the same, below.
    const scored = r.lines
      .map((masterLine, i) => {
        const t = tailor(masterLine);
        return t === null ? null : { l: t, score: scoreClaim(masterLine.text, profile), i };
      })
      .filter((x): x is { l: ResumeLine; score: number; i: number } => x !== null);
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    // Ranked on its BEST lines, never on how many it has.
    //
    // A consolidated relationship offers the bullets of every period it
    // covers, so summing all of them would let a position outrank
    // another for having a longer candidate pool rather than a stronger
    // one, and it would then be handed a larger allowance for the same
    // reason. Consolidation is meant to widen what tailoring may choose
    // between, not what the page prints.
    const best = scored.slice(0, budget.maxPerRole);
    return { role: r, scored, roleScore: best.reduce((n, s) => n + s.score, 0) };
  });

  // The two entries that speak most to this posting carry it; the rest
  // are present and brief. Always a ceiling, never a target.
  //
  // An entry whose evidence says nothing about this job gets NO lines.
  // A role still appears, because the chronology is true and omitting it
  // would be a gap; it simply does not take space it has not earned.
  const tier = (rank: number) => (rank < 2 ? budget.maxPerRole : rank < 4 ? 3 : 2);

  const ranking = [...withScores].sort((a, b) => b.roleScore - a.roleScore);
  const allowance = new Map<typeof withScores[number], number>();
  ranking.forEach((x, rank) => {
    allowance.set(x, x.roleScore === 0 ? 0 : tier(rank));
  });

  // -- what each project could contribute, computed before allocation --
  //
  // Scored, stripped of zeroes and de-duplicated FIRST, because a claim
  // that restates the identity line is not a contribution and must not
  // count toward the project's rank.
  const projectPools = master.projects.map((p) => {
    const l = tailor(p.line);
    // Same rule as the roles above: the score comes from the master
    // wording, the printed text from the tailored wording.
    const scored = (p.optional ?? [])
      .map((masterLine, i) => ({
        line: byOriginal.get(masterLine.text)
          ? { text: byOriginal.get(masterLine.text)!.claim, sources: masterLine.sources }
          : masterLine,
        score: scoreClaim(masterLine.text, profile), i,
      }))
      .sort((a, b) => b.score - a.score || a.i - b.i);
    const pool: Array<{ line: ResumeLine; score: number }> = [];
    if (l) {
      for (const x of scored) {
        if (x.score === 0) {
          dropped.push({ line: x.line.text, why: `${p.name}: no measured relevance to this posting` });
          continue;
        }
        if (collapseRedundant([l, ...pool.map((k) => k.line), x.line]).lines.length !== pool.length + 2) {
          dropped.push({ line: x.line.text, why: `${p.name}: says substantially what the project description or another selected claim already says` });
          continue;
        }
        pool.push(x);
      }
    }
    // Ranked on the best it could actually print, exactly as a role is
    // ranked on its best maxPerRole rather than on everything it holds.
    return { project: p, line: l, pool,
      entryScore: pool.slice(0, budget.maxPerProject).reduce((n, x) => n + x.score, 0) };
  });

  // -- the project's allowance, from the same table, at its own rank ---
  //
  // A project used to receive a flat ceiling of three regardless of how
  // little it said, which handed it space no role of equal relevance
  // would have been given. It now reads its tier off a ranking that
  // includes the roles, so a project ranking below every position gets
  // the two lines a bottom-ranked position gets, and a project whose
  // claims all score zero gets none.
  //
  // Its presence does not push a role down a tier. That was tried and
  // measured over 4,658 postings: inserting a fifth entry into a table
  // calibrated for four demoted somebody every time, taking 713 role
  // bullets away and giving the project not one. The table is a budget
  // for the positions; what the project is owed from it is the
  // allowance its relevance earns, not a share taken from employment.
  // Ranked by identity, not by score. Looking the project up by its
  // score would find a ROLE holding the same number first and hand the
  // project that role's better rank, which is a tie silently resolved in
  // the project's favour. Roles are listed first and the sort is stable,
  // so an exact tie leaves the role above the project.
  const combined: Array<{ id: unknown; score: number }> = [
    ...withScores.map((x) => ({ id: x, score: x.roleScore })),
    ...projectPools.map((x) => ({ id: x, score: x.entryScore })),
  ].sort((a, b) => b.score - a.score);
  const projectAllowance = (entry: typeof projectPools[number]) =>
    entry.entryScore === 0 ? 0 : tier(combined.findIndex((c) => c.id === entry));

  // -- opportunity cost, across the whole document ---------------------
  //
  // Allocation up to this point is per entry, so it cannot see that a
  // slot is worth more somewhere else. Measured on Candidate #3 that
  // printed a claim scoring 1 while six claims scoring 3 went unused:
  // the college had earned five slots and only had four things worth
  // saying, while Genius One had a fifth thing and no room for it.
  //
  // So the allocation is repaired rather than replaced. Repeatedly make
  // the single best trade available: if the strongest unprinted claim
  // anywhere outscores the weakest printed claim anywhere, move the slot
  // to it. Three conditions bound the trade, and each is doing real
  // work:
  //
  //   the losing entry keeps at least one claim, so an entry with
  //   something to say is never silenced by a stronger entry;
  //
  //   the gaining entry stays under its own ceiling, so a trade can
  //   never buy space a ceiling forbids;
  //
  //   the trade must strictly improve, so equal scores never swap and
  //   the result does not depend on iteration order.
  //
  // Length is unchanged by construction: every trade moves one slot. No
  // threshold is introduced, and a claim scoring zero is not in any pool
  // to be traded for. Measured over 4,658 postings this removes 129 of
  // 537 inversions and 55 of 206 pathological cases; the rest are
  // entries whose only relevant claim is a weak one, which the first
  // condition deliberately protects.
  interface Slot { taken: number; pool: Array<{ score: number }>; ceiling: number }
  const slots: Slot[] = [
    ...withScores.map((x) => ({
      taken: Math.min(x.scored.filter((s) => s.score > 0).length, allowance.get(x) ?? 0, budget.maxPerRole),
      pool: x.scored.filter((s) => s.score > 0),
      ceiling: budget.maxPerRole,
    })),
    ...projectPools.map((x) => ({
      taken: Math.min(x.pool.length, projectAllowance(x), budget.maxPerProject),
      pool: x.pool,
      ceiling: budget.maxPerProject,
    })),
  ];
  const roleSlots = slots.slice(0, withScores.length);
  const projectSlots = slots.slice(withScores.length);
  // Bounded: every iteration moves one slot and each strictly improves,
  // so it cannot cycle. The bound is a guard against a future change
  // breaking that argument, not something this loop can reach.
  for (let guard = 0; guard < 256; guard++) {
    let give: { s: Slot; score: number } | null = null;
    let take: { s: Slot; score: number } | null = null;
    for (const slot of slots) {
      if (slot.taken > 1) {
        const score = slot.pool[slot.taken - 1]!.score;
        if (!give || score < give.score) give = { s: slot, score };
      }
      if (slot.taken < Math.min(slot.ceiling, slot.pool.length)) {
        const score = slot.pool[slot.taken]!.score;
        if (!take || score > take.score) take = { s: slot, score };
      }
    }
    if (!give || !take || give.s === take.s || take.score <= give.score) break;
    give.s.taken--;
    take.s.taken++;
  }

  const roles: ResumeRole[] = withScores.map((x) => {
    // The ceiling applies to the entry, whatever it was assembled from.
    // Nothing reserves a place for a covered period: a period whose
    // evidence says nothing about this posting contributes nothing.
    //
    // And the ceiling is a ceiling on RELEVANT lines, not an instruction
    // to fill the space with whatever is left. A claim scoring zero has
    // no concept in common with the posting and essentially no words
    // either; the scorer cannot go below zero, so zero is not "slightly
    // relevant", it is nothing measured at all. Filling to the ceiling
    // put 18% of all selected bullets on the page that way, every one of
    // them inside a role that was relevant for other reasons: a nurse
    // posting was being told about automotive documentaries because the
    // college role had earned five slots and only had three things to
    // say. This is the rule the role level already applies, at the level
    // of the individual line.
    const relevant = x.scored.filter((s) => s.score > 0).length;
    const keep = roleSlots[withScores.indexOf(x)]!.taken;
    if (x.scored.length > keep) {
      const unearned = x.scored.length - relevant;
      const overCeiling = Math.max(0, relevant - keep);
      const why = [
        overCeiling ? `${overCeiling} line(s) said less about this posting than the ones kept` : "",
        unearned ? `${unearned} line(s) had no measured relevance to this posting` : "",
      ].filter(Boolean).join("; ");
      dropped.push({ line: `${x.role.employer} — ${x.role.title}`, why });
    }
    return { ...x.role, lines: x.scored.slice(0, keep).map((s) => s.l) };
  });

  // -- projects: identity always, detail only when it is earned -------
  //
  // The identity line is the project and always prints. The optional
  // claims are scored, de-duplicated and capped by the rules above, plus
  // one step that has no employment equivalent: a claim is compared
  // against the identity line, because a project's description already
  // says a good deal and a statement that merely restates it costs space
  // and tells a reader nothing new.
  //
  // maxPerProject survives only as a CAP. It can reduce what the ranking
  // allows and can never grant anything: removing it was measured to
  // hand projects four or five claims on 1,171 postings, which is a
  // large evidence pool buying space, the very thing the ranking exists
  // to prevent. The identity paragraph already occupies the room a role
  // spends on its first bullet.
  const projects: ResumeProject[] = projectPools
    .map((x) => {
      if (!x.line) return null;
      const keep = projectSlots[projectPools.indexOf(x)]!.taken;
      for (const y of x.pool.slice(keep)) {
        dropped.push({ line: y.line.text,
          why: `${x.project.name}: beyond the ${keep} optional claim(s) this posting earned it; ${y.score} scored lower than the ones kept` });
      }
      return { ...x.project, line: x.line, optional: x.pool.slice(0, keep).map((y) => y.line) };
    })
    .filter((p): p is ResumeProject => p !== null);

  // Whether a position with nothing to say is worth its space is a
  // content decision, and it is made here rather than in the renderer.
  // It may be dropped only where the timeline is unaffected; otherwise
  // it stays as a chronology entry with no bullets.
  const selection = selectEmployment(master, roles);
  for (const o of selection.omitted) dropped.push({ line: o.role, why: o.why });

  // A summary sentence repeated verbatim as a bullet is redundancy the
  // renderer will refuse and a reader would notice. The bullet is kept;
  // the summary sentence goes.
  const deduped = dropSummarySentencesDuplicatedInBullets(summary, selection.roles, projects);
  for (const r of deduped.removed) {
    dropped.push({ line: r, why: "stated verbatim as an experience bullet; the bullet carries the evidence" });
  }

  const assembled: ResumeDoc = { ...master, summary: deduped.summary, roles: selection.roles, projects };
  assertChronologyIntact(master, assembled);
  return {
    doc: dedupe(assembled, dropped),
    dropped,
    // Nothing usable survived. The caller regenerates; this code will not
    // write prose no evidence produced.
    summaryIncomplete: deduped.incomplete || undefined,
  };
}

/**
 * Runs of whitespace collapsed to one space.
 *
 * Presentation only, and deliberately the narrowest possible rule: it
 * touches spacing and nothing else, so no word, number, qualifier or
 * citation can change by passing through it. A resume that says
 * "work.  Experience" is not making a different claim, it is set badly.
 */
export function normalizeProse(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

/** Case, spacing and terminal punctuation are not content. */
const normalizeClaim = (s: string) =>
  s.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?]+$/g, "").trim();

/**
 * A resume never says the same thing twice.
 *
 * Two rules, and the second is deliberately timid:
 *
 *   EXACT      identical text after collapsing case, spacing and a
 *              trailing full stop. Always a duplicate, always dropped.
 *
 *   EQUIVALENT identical normalized text AND the identical evidence set.
 *              This catches a claim reissued with trivial wording
 *              differences and nothing else.
 *
 * Anything less certain is KEPT. Two differently worded claims from one
 * employment record are usually two real accomplishments, and deleting
 * one to look tidy would be the renderer editing the evidence. When in
 * doubt the evidence survives.
 *
 * Nothing here ever adds a line. A budget is a maximum, not a quota, so
 * a thin role stays thin.
 */

/**
 * A summary sentence restated verbatim as an experience bullet.
 *
 * Popl's tailored resume ended its summary with "Designed marketing
 * emails and built and managed segmented email marketing funnels for an
 * audience of approximately 100,000 contacts." and then said exactly
 * that again as a bullet under Genius One. The renderer refused the
 * document, correctly: nobody sends a resume that repeats a sentence
 * word for word two inches apart.
 *
 * The existing dedupe compares the summary as ONE string, so a bullet
 * matching a single sentence inside it was invisible. This compares
 * sentence by sentence.
 *
 * Deliberately exact. Two claims that merely resemble each other serve
 * different purposes at different altitudes - a summary generalizes, a
 * bullet evidences - and removing one because it is similar would delete
 * something a person meant to say. Only verbatim repetition is removed,
 * and the BULLET is what survives, because it is the line attached to
 * the employment record and its evidence.
 */
const SUBSTANTIVE_WORDS = 5;

function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+/g) ?? [text]).map((x) => x.trim()).filter(Boolean);
}

export interface SummaryDedupeResult {
  summary: ResumeLine;
  removed: string[];
  /**
   * True when removal leaves nothing usable. The caller must regenerate
   * rather than invent replacement prose: a summary assembled by this
   * code would be wording no evidence produced.
   */
  incomplete: boolean;
}

export function dropSummarySentencesDuplicatedInBullets(
  summary: ResumeLine, roles: ResumeRole[], projects: ResumeProject[] = [],
): SummaryDedupeResult {
  const bulletTexts = new Set<string>();
  for (const r of roles) for (const l of r.lines) bulletTexts.add(normalizeClaim(l.text));
  for (const p of projects) {
    bulletTexts.add(normalizeClaim(p.line.text));
    for (const l of p.optional) bulletTexts.add(normalizeClaim(l.text));
  }

  const sentences = splitSentences(summary.text);
  const removed: string[] = [];
  const kept = sentences.filter((sentence) => {
    // Short connective sentences are not substantive claims and are not
    // what this rule is about.
    if (sentence.split(/\s+/).filter(Boolean).length < SUBSTANTIVE_WORDS) return true;
    if (!bulletTexts.has(normalizeClaim(sentence))) return true;
    removed.push(sentence);
    return false;
  });

  if (removed.length === 0) return { summary, removed, incomplete: false };

  const rebuilt = normalizeProse(kept.join(" "));
  // Structurally incomplete: nothing substantive survives. Refuse rather
  // than ship a summary that is a fragment.
  const incomplete = kept.length === 0
    || rebuilt.split(/\s+/).filter(Boolean).length < SUBSTANTIVE_WORDS;

  return {
    summary: { text: rebuilt, sources: summary.sources },
    removed,
    incomplete,
  };
}

function dedupe(doc: ResumeDoc, dropped: Array<{ line: string; why: string }>): ResumeDoc {
  const seen = new Map<string, string[]>();

  const keep = (line: ResumeLine): boolean => {
    const norm = normalizeClaim(line.text);
    const priorSources = seen.get(norm);
    if (priorSources !== undefined) {
      const same = JSON.stringify([...line.sources].sort()) === JSON.stringify(priorSources);
      dropped.push({
        line: line.text,
        why: same
          ? "identical claim from identical evidence, already stated"
          : "identical wording already stated elsewhere in the document",
      });
      return false;
    }
    seen.set(norm, [...line.sources].sort());
    return true;
  };

  keep(doc.summary);
  const exact = {
    ...doc,
    roles: doc.roles.map((r) => ({ ...r, lines: r.lines.filter(keep) })),
    projects: doc.projects.filter((p) => keep(p.line)).map((p) => ({ ...p, optional: p.optional.filter(keep) })),
  };

  // Identical text is the easy case and the rare one. Two bullets that
  // say the same thing in different words survived every check above and
  // reached a real resume, so the same-role bullets are compared on what
  // they communicate rather than on how they are worded.
  return {
    ...exact,
    roles: exact.roles.map((r) => {
      const collapsed = collapseRedundant(r.lines);
      for (const d of collapsed.dropped) dropped.push(d);
      return { ...r, lines: collapsed.lines };
    }),
  };
}

/**
 * A very short orientation line, or nothing.
 *
 * Drawn from the verified skill groups already on the document and
 * filtered by what this posting actually asks for, so a marketing
 * application and an operations application produce different lines and
 * neither produces a generic list of everything. Returns an empty array
 * when the overlap is too thin to be worth the space, because a
 * capability line that says nothing specific is clutter.
 */
export function selectCapabilities(
  doc: ResumeDoc, roleContextTerms: string[], roleTitle = "",
): ResumeDoc["skillGroups"] {
  const profile = profileFor(roleTitle, roleContextTerms);
  const groups: ResumeDoc["skillGroups"] = [];

  for (const g of doc.skillGroups) {
    const scored = g.skills
      .map((skill) => ({ skill, score: scoreCapability(skill, profile) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill));
    // A category earns its heading by having something to say. Two
    // relevant skills is the floor: one is noise, and a heading over a
    // single word costs more space than it returns.
    if (scored.length >= 2) groups.push({ label: g.label, skills: scored.slice(0, 8).map((x) => x.skill) });
  }

  // The whole section may disappear. A Legal Operations application
  // gains nothing from enumerating CAD, FDM printing or video tooling,
  // and printing them anyway is an ATS keyword dump wearing a heading.
  return groups.slice(0, 4);
}

/**
 * Every line in a document, for checking what a renderer received.
 *
 * A renderer is not allowed to change this set. If a layout cannot fit
 * it, that is resolved upstream by selection or flagged, never by the
 * renderer quietly dropping a bullet.
 */
export function documentLines(doc: ResumeDoc): string[] {
  return [
    doc.summary.text,
    ...doc.roles.flatMap((r) => r.lines.map((l) => l.text)),
    ...doc.projects.flatMap((p) => [p.line.text, ...p.optional.map((l) => l.text)]),
  ];
}

