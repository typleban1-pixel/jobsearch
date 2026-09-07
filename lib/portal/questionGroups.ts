/**
 * Grouping materially identical blocked questions across applications.
 *
 * Two Home Chef applications produced ten blocked fields that are five
 * questions asked twice. Answering the same question five times because
 * it appears on two forms is work the system created, not work the
 * employer asked for.
 *
 * What this must never do is merge two questions that only look alike.
 * Equivalence is established from the question as asked, not from its
 * label: the exact wording, the field type, and whether it is required.
 *
 * Option sets may differ between employers asking the same question.
 * Three Samsara postings ask "How did you hear about this opportunity?"
 * with 23, 20 and 22 choices; 20 are identical across all three and the
 * rest are extra entries one posting carries. Requiring an identical
 * option set split that into three questions and asked the reader the
 * same thing three times.
 *
 * So a group needs two things: the same intent, AND at least one option
 * that every member offers, compared as exact strings. The second half
 * is what keeps this honest. It is not a similarity threshold; it is the
 * condition under which a single answer could serve the whole group at
 * all. Two "Location" questions over disjoint city lists share no
 * option, so nothing could ever answer both and they stay separate.
 *
 * Grouping only ever produces an OFFER to reuse. Nothing is answered by
 * being grouped, each application keeps its own answer row, its own
 * employer wording and its own option list, and an answer is written
 * only where that exact string is one of that employer's own choices.
 * Nothing is ever rewritten, approximated or substituted.
 */

export interface BlockedField {
  applicationId: string;
  applicationLabel: string;
  fieldKey: string;
  label: string;
  /** The employer's wording, when it differs from the short label. */
  questionText: string | null;
  options: string[];
  type: string;
  required: boolean;
  category: string | null;
  blockKind: string | null;
  blockedReason: string | null;
  /** The employer's own form URL, for a file upload that must be completed there. */
  applyUrl?: string | null;
  /** The job posting itself, for a reader who needs the listing while answering. */
  jobUrl?: string | null;
  /** For a conditional follow-up ("If yes, ..."): the question it follows and how that was answered. */
  follows?: { question: string; answer: string | null } | null;
}

export interface QuestionGroup {
  /** Stable identity for the group, derived from the question itself. */
  key: string;
  label: string;
  questionText: string | null;
  /**
   * Every option any member offers, for presentation only.
   *
   * A union, so the reader sees the full range of what they could say.
   * It is never written anywhere: what gets stored is checked against
   * the individual application's own list.
   */
  options: string[];
  /**
   * Options every member offers, compared as exact strings.
   *
   * Answering with one of these resolves the whole group. Non-empty by
   * construction: a group cannot form without it.
   */
  universalOptions: string[];
  /** For each option, the applications whose own form offers it. */
  optionCoverage: Record<string, string[]>;
  /** True when members do not all offer the same choices. */
  optionsVary: boolean;
  required: boolean;
  category: string | null;
  blockKind: string | null;
  blockedReason: string | null;
  fields: BlockedField[];
  /**
   * Whether one answer may be offered for reuse across the group.
   *
   * Consent is never reusable by default: agreeing to be texted by one
   * employer is not agreement to be texted by another, and a group of
   * two identical consent controls is still two separate agreements.
   * The wizard may offer "use for both" in the moment, but nothing here
   * marks consent as safe to persist and replay.
   */
  reusable: boolean;
  reuseNote: string | null;
}

const norm = (s: string | null | undefined) =>
  String(s ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ?]/g, "").trim();

/**
 * A control that records agreement rather than a fact about the person.
 *
 * These may be grouped so the reader sees them once, but they are never
 * marked reusable: each one is a separate agreement with a separate
 * party, even when the wording is identical.
 */
export function isConsent(
  f: { label: string; questionText: string | null; category: string | null; options?: string[] },
): boolean {
  const t = `${f.label} ${f.questionText ?? ""}`.toLowerCase();
  if (/\b(i (would like|agree|consent|acknowledge)|opt[- ]?in|receive (updates|texts|sms|messages)|terms|privacy policy)\b/.test(t)) {
    return true;
  }

  // Data-handling notices. Samsara's "Processing of Personal Data" is an
  // acknowledgement with none of the wording above, and was being marked
  // reusable because of it.
  if (/\b(processing of personal data|personal data|data privacy|data protection|gdpr|ccpa|consent)\b/.test(t)) {
    return true;
  }

  // The shape gives it away when the wording does not. A control whose
  // only choice is "Acknowledge/Confirm" is not asking a fact about the
  // person; there is nothing to answer except agreement. Anything with a
  // real choice between alternatives is excluded, so a plain yes/no
  // question is untouched by this.
  const opts = f.options ?? [];
  if (opts.length === 1 && /\b(acknowledge|confirm|i agree|agree|accept)\b/i.test(opts[0] ?? "")) {
    return true;
  }

  return false;
}

/**
 * The exact identity of a question, options included.
 *
 * Retained because it is the strictest possible statement of "these are
 * the same question", and the wizard uses it to tell a reader when the
 * forms they are answering at once were not literally identical.
 */
export function questionKey(f: BlockedField): string {
  return [
    norm(f.questionText || f.label),
    f.type,
    f.required ? "required" : "optional",
    f.options.map(norm).join("|"),
  ].join("::");
}

/**
 * What the question is asking, independent of the choices offered.
 *
 * Grouping starts here and is then narrowed by the shared-option test,
 * so wording alone never merges anything on its own.
 */
export function intentKey(f: BlockedField): string {
  return [
    norm(f.questionText || f.label),
    f.type,
    f.required ? "required" : "optional",
    // A file upload is application-specific: it is completed on that one
    // employer's form and, for a resume/CV, bound to that application's own
    // tailored artifact. Two applications' file fields must never collapse
    // into one shared "question" just because the wording and type match, so
    // the application id joins the key for files and keeps each on its own.
    f.type === "file" ? f.applicationId : "",
  ].join("::");
}

/** A group whose field is a file upload: completed on the employer's form, not typed here. */
export const isFileGroup = (g: QuestionGroup): boolean => g.fields[0]?.type === "file";

/** Exact-string intersection, order taken from the first list. */
function sharedOptions(sets: string[][]): string[] {
  if (!sets.length) return [];
  const [first, ...rest] = sets as [string[], ...string[][]];
  return first.filter((o) => rest.every((s) => s.includes(o)));
}

/**
 * Which applications in a group this exact answer can be written to.
 *
 * A free-text question has no options, so every member takes it. A
 * choice question takes it only where the employer's own list contains
 * that exact string. Anything else stays blocked and keeps asking,
 * which is the honest outcome: the employer never offered it.
 */
export function applicabilityFor(group: QuestionGroup, answer: string): {
  compatible: BlockedField[];
  incompatible: BlockedField[];
} {
  const compatible: BlockedField[] = [];
  const incompatible: BlockedField[] = [];
  for (const f of group.fields) {
    const takesIt = f.options.length === 0 || f.options.includes(answer);
    (takesIt ? compatible : incompatible).push(f);
  }
  return { compatible, incompatible };
}

export function groupBlockedQuestions(fields: BlockedField[]): QuestionGroup[] {
  // Same intent first. Options are considered inside each bucket, so
  // wording alone can never merge two questions on its own.
  const buckets = new Map<string, BlockedField[]>();
  for (const f of fields) {
    const k = intentKey(f);
    const arr = buckets.get(k) ?? [];
    arr.push(f);
    buckets.set(k, arr);
  }

  const out: QuestionGroup[] = [];

  for (const [intent, members] of buckets) {
    // Within a bucket, a field joins a group only while the group keeps
    // at least one option every member offers. When it cannot, a second
    // group forms for the same wording, and the reader is asked twice,
    // because no single answer could have served both.
    const clusters: BlockedField[][] = [];
    for (const f of members) {
      const home = clusters.find((c) => {
        if (f.options.length === 0 && c[0]!.options.length === 0) return true;
        return sharedOptions([...c.map((x) => x.options), f.options]).length > 0;
      });
      if (home) home.push(f); else clusters.push([f]);
    }

    for (const [i, cluster] of clusters.entries()) {
      const first = cluster[0]!;
      const consent = isConsent({ ...first, options: first.options });

      // Presentation is the union, in first-seen order, so the reader
      // sees everything they could truthfully say across these forms.
      const union: string[] = [];
      for (const f of cluster) for (const o of f.options) if (!union.includes(o)) union.push(o);

      const universal = sharedOptions(cluster.map((f) => f.options));
      const coverage: Record<string, string[]> = {};
      for (const o of union) {
        coverage[o] = cluster.filter((f) => f.options.includes(o)).map((f) => f.applicationId);
      }
      const optionsVary = cluster.some((f) => f.options.length !== union.length);

      out.push({
        // Stable across reloads, and distinct when one intent split.
        key: clusters.length > 1 ? `${intent}::c${i}` : intent,
        label: first.label,
        questionText: first.questionText,
        options: union,
        universalOptions: universal,
        optionCoverage: coverage,
        optionsVary,
        required: first.required,
        category: first.category,
        blockKind: first.blockKind,
        blockedReason: first.blockedReason,
        fields: cluster,
        reusable: !consent,
        reuseNote: consent
          ? "Each employer's consent is a separate agreement, so this is never reused automatically."
          : optionsVary
            ? "These forms offer slightly different choices. An answer is written only to the applications whose own form lists it."
            : null,
      });
    }
  }

  // Required questions first, then the ones asked by the most
  // applications: clearing those removes the most blocked fields.
  return out.sort((a, b) =>
    Number(b.required) - Number(a.required)
    || b.fields.length - a.fields.length
    || a.label.localeCompare(b.label));
}

export interface BlockedSummary {
  /** Underlying application fields that are blocked. */
  blockedFields: number;
  /** Distinct answers the person actually has to give (typed questions only). */
  answersNeeded: number;
  /** File uploads to finish on the employer's own form. Not typeable answers. */
  handoffs: number;
  applications: number;
}

export function summarize(groups: QuestionGroup[]): BlockedSummary {
  const apps = new Set<string>();
  let blockedFields = 0;
  let answersNeeded = 0;
  let handoffs = 0;
  for (const g of groups) {
    blockedFields += g.fields.length;
    for (const f of g.fields) apps.add(f.applicationId);
    // A file upload is not an answer the reader can type here; it is a
    // handoff to the employer's own form, counted and messaged separately.
    if (isFileGroup(g)) handoffs += 1; else answersNeeded += 1;
  }
  return { blockedFields, answersNeeded, handoffs, applications: apps.size };
}
