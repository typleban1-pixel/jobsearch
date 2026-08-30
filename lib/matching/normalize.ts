/**
 * Term normalization.
 *
 * One canonical string form so that "Node.js", "NodeJS" and "node js"
 * are the same key. Everything downstream (aliases, related_terms,
 * miss-rate measurement) compares normalized forms only.
 *
 * Deliberately conservative. Aggressive stemming collapses terms that are
 * genuinely different — "Java" and "JavaScript" being the classic
 * disaster — so this normalizes punctuation and spacing and stops.
 */

export function normalizeTerm(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    // Dots inside words only: "node.js" -> "nodejs", but a trailing dot
    // ending a sentence fragment is just dropped.
    .replace(/\.(?=\w)/g, "")
    .replace(/[^a-z0-9+#\s-]/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Variants worth trying before declaring a miss. Each is a form that
 * appears in real postings for the same underlying thing.
 */
export function termVariants(raw: string): string[] {
  const base = normalizeTerm(raw);
  const out = new Set<string>([base]);
  out.add(base.replace(/-/g, " "));
  out.add(base.replace(/-/g, ""));
  out.add(base.replace(/\s/g, ""));
  // Plural and possessive forms, both directions.
  if (base.endsWith("s") && base.length > 3) out.add(base.slice(0, -1));
  else out.add(`${base}s`);
  // Leading qualifiers that describe the requirement, not the skill.
  const stripped = base.replace(
    /^(strong |solid |proven |demonstrated |hands-on |hands on |expert |advanced |basic |working )/,
    "",
  );
  if (stripped !== base) out.add(stripped);
  // Trailing nouns that add nothing: "python experience" -> "python".
  const trailing = base.replace(/\s+(experience|skills?|knowledge|expertise|proficiency|background)$/, "");
  if (trailing !== base) out.add(trailing);
  return [...out].filter((t) => t.length > 0);
}
