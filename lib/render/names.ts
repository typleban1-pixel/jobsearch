/**
 * Which name goes in which field.
 *
 * A middle name is not a display name. The moment "Tyler Michael Pleban"
 * exists in the profile, the easy mistake is to treat it as "the name"
 * and put it on a resume, which is both wrong and slightly odd-looking.
 *
 * So the choice is explicit per context, and the ambiguous case does not
 * guess. His instruction: if a form's naming requirement is materially
 * ambiguous and the wrong identity could matter, preserve the application
 * and ask.
 */

export type NameContext =
  | "RESUME"            // display
  | "COVER_LETTER"      // display
  | "RECRUITER_MESSAGE" // display
  | "APPLICATION_NAME"  // display, the ordinary "Name" field
  | "LEGAL_NAME"        // full legal
  | "BACKGROUND_CHECK"  // full legal
  | "ONBOARDING";       // full legal

export interface NameParts {
  legalFirst: string;
  legalMiddle: string | null;
  legalLast: string;
  preferred: string | null;
}

const LEGAL_CONTEXTS = new Set<NameContext>(["LEGAL_NAME", "BACKGROUND_CHECK", "ONBOARDING"]);

export function nameFor(context: NameContext, p: NameParts): string {
  if (LEGAL_CONTEXTS.has(context)) {
    return [p.legalFirst, p.legalMiddle, p.legalLast].filter(Boolean).join(" ");
  }
  return `${p.preferred ?? p.legalFirst} ${p.legalLast}`;
}

/**
 * True when a form field's naming requirement cannot be resolved from its
 * label alone. The caller must block and ask rather than pick.
 *
 * "Full name" is the trap: on most forms it means first plus last, and on
 * a background-check form it means the legal name including middle. The
 * label does not distinguish them, so nothing here should pretend to.
 */
export function isAmbiguousNameField(label: string): boolean {
  const l = label.toLowerCase().trim();
  if (/\b(legal name|name as it appears|full legal|as shown on your (?:id|passport|licen[sc]e))\b/.test(l)) return false;
  if (/\b(preferred name|display name|nickname|what should we call you|goes by)\b/.test(l)) return false;
  if (/\b(first name|given name|last name|surname|family name|middle name|middle initial)\b/.test(l)) return false;
  return /\b(full name|name)\b/.test(l);
}
