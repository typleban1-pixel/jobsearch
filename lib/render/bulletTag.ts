/**
 * Resume Builder v2, Step 3A support: tag a résumé bullet with the covered
 * job themes it supports. Used to build candidates for coverageSelect. General
 * concept signatures mirror the Step 2 entailment rules; a bullet can only
 * ever be credited for a theme the evidence map already classified DIRECT or
 * TRANSFERABLE, so a gap theme can never be "covered" by a bullet.
 *
 * ============================ HARD REQUIREMENT ============================
 * This module is TEST/DEMO SCAFFOLDING ONLY. It approximates bullet->theme
 * coverage with text-signature matching, which is inherently imprecise.
 * Production wiring MUST NOT use it. Production theme coverage must be
 * derived from evidence IDs / provenance linked through the evidence map
 * (each master bullet's `sources` evidence ids intersected with the evidence
 * the map credited to a theme), never from text matching. Do not import this
 * from the live résumé-generation path.
 * =========================================================================
 */
import { norm } from "../scoring/conceptRelations.ts";
import { isCovered, type Coverage } from "./evidenceMap.ts";

/**
 * concept matcher (on the theme term) -> what a covering bullet looks like.
 * Signatures require distinctive language, not a bare generic token, so a
 * theme is credited to a bullet only when the bullet actually demonstrates it.
 */
const SIGNATURES: { concept: RegExp; bullet: RegExp }[] = [
  { concept: /\bcommunicat|verbal|written|presentation communication/, bullet: /taught|mentor|present(ed|ation)?|explain|script|communicat|spoke|speaking|by phone/i },
  { concept: /multitask|multiple priorities|manage multiple|competing priorities|multiple projects/, bullet: /concurrent|multiple (brands|projects|teams)|shifting priorities|simultaneous/i },
  { concept: /problem[- ]solv|analytical/, bullet: /troubleshoot|develop(ed)? solutions?|needs? assessment|translat[^.]{0,25}(goal|need)|within[^.]{0,20}constraint/i },
  { concept: /cross[- ]functional|cross[- ]department/, bullet: /cross-?(functional|department)|across (teams|departments)|with (marketing|other teams)/i },
  { concept: /^collaborat/, bullet: /collaborat|cross-?(functional|department)|across (teams|departments)/i },
  { concept: /project coordination|coordinat/, bullet: /coordinat|ran? projects|run projects|projects? from planning|planning (through|to) delivery|configured[^.]{0,20}workflow/i },
  { concept: /milestone|dependenc/, bullet: /milestone|dependenc|\basana\b/i },
  { concept: /process improvement/, bullet: /process improvement|improv[^.]{0,15}process|streamlin|modern[^.]{0,15}(equipment|process)|equipment modern/i },
  { concept: /microsoft office|excel|powerpoint|\bword\b|spreadsheet/, bullet: /excel|powerpoint|\bword\b|sheets|slides|presentation|spreadsheet/i },
];

const GENERIC = new Set(["project", "experience", "management", "business", "work", "professional", "team", "teams", "programs", "program", "initiatives", "field", "role", "skills"]);
const STOP = new Set(["and", "or", "of", "the", "a", "to", "in", "for", "with", "on", "skills", "experience", "ability", "platforms", "management", "related"]);
const toks = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 3 && !STOP.has(t));

export interface CoveredTheme { id: string; coverage: Coverage; }

/** The themeIds this bullet covers, among the covered (DIRECT/TRANSFERABLE)
 *  themes only. A theme with a known signature is credited ONLY via that
 *  signature; other themes fall back to a distinctive (non-generic) token. */
export function tagBullet(bulletText: string, themes: CoveredTheme[]): string[] {
  const text = String(bulletText);
  const out: string[] = [];
  for (const th of themes) {
    if (!isCovered(th.coverage)) continue;                 // gap themes are never coverable
    const term = norm(th.id);
    const sig = SIGNATURES.find((s) => s.concept.test(term));
    let covers = false;
    if (sig) covers = sig.bullet.test(text);               // signature is authoritative when one exists
    else {
      // Distinctive token of the theme term appearing in the bullet.
      const tt = toks(th.id).filter((t) => !GENERIC.has(t));
      if (tt.length && tt.some((t) => norm(text).includes(t))) covers = true;
    }
    if (covers) out.push(th.id);
  }
  return out;
}

export const looksQuantitative = (text: string): boolean => /\b\d[\d,]*\b|\$|%|approximately \$/.test(String(text));
