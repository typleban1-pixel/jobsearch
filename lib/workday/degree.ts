/**
 * A verified credential against an employer's degree taxonomy.
 *
 * Workday states its levels as "Bachelor's (B.A., B.S., B.B.A.)" -- the
 * option itself enumerates the abbreviations it covers, so mapping
 * "Bachelor of Science" onto it is reading the employer's own list
 * rather than inventing an equivalent. Where the list does NOT name the
 * credential, this fails: an approximate degree on an application is a
 * false statement about a qualification.
 */

/** "Bachelor of Science" to "B.S." */
export function abbreviate(credential: string): string {
  const c = String(credential ?? "").trim();
  const m = /^(\w+)\s+of\s+(\w+)/i.exec(c);
  if (!m) return "";
  return `${m[1]![0]!.toUpperCase()}.${m[2]![0]!.toUpperCase()}.`;
}

/** The level word: "Bachelor of Science" to "bachelor". */
export function levelOf(credential: string): string {
  const c = String(credential ?? "").trim().toLowerCase();
  const m = /^(associate|bachelor|master|doctor|doctorate|juris)/.exec(c);
  return m ? m[1]! : "";
}

/** The abbreviations an option claims, from its parenthesis. */
export function optionAbbreviations(option: string): string[] {
  const m = /\(([^)]*)\)/.exec(String(option ?? ""));
  if (!m) return [];
  return m[1]!.split(",").map((a) => a.trim().toUpperCase()).filter(Boolean);
}

export type DegreeMatch =
  | { ok: true; option: string; why: string }
  | { ok: false; why: string; offered: string[] };

export function mapDegree(credential: string, options: string[]): DegreeMatch {
  const opts = options.filter((o) => o && !/^select one$/i.test(o.trim()));
  if (!opts.length) return { ok: false, why: "the control offered no degrees", offered: [] };

  const exact = opts.filter((o) => o.trim().toLowerCase() === String(credential ?? "").trim().toLowerCase());
  if (exact.length === 1) return { ok: true, option: exact[0]!, why: "the taxonomy names this credential exactly" };

  // The option's own abbreviation list is the authority.
  const abbr = abbreviate(credential).toUpperCase();
  if (abbr) {
    const byAbbr = opts.filter((o) => optionAbbreviations(o).includes(abbr));
    if (byAbbr.length === 1) return { ok: true, option: byAbbr[0]!, why: `the option lists ${abbr}` };
    if (byAbbr.length > 1) {
      return { ok: false, why: `${byAbbr.length} options list ${abbr}`, offered: opts };
    }
  }

  // Failing that, the level word, which must still be unambiguous.
  const level = levelOf(credential);
  if (level) {
    const byLevel = opts.filter((o) => o.trim().toLowerCase().startsWith(level));
    if (byLevel.length === 1) return { ok: true, option: byLevel[0]!, why: `the only ${level} option` };
    if (byLevel.length > 1) return { ok: false, why: `${byLevel.length} ${level} options`, offered: opts };
  }

  return { ok: false, why: `the taxonomy does not name ${JSON.stringify(credential)}`, offered: opts };
}
