import type { LlmProvider } from "./provider.ts";

/**
 * Requirement extraction.
 *
 * The model's job is to say what a SENTENCE MEANS. It never decides
 * whether the candidate passes, and it is never shown the profile: it
 * cannot tailor its reading of a posting to what we would like the answer
 * to be, because it does not know what we would like.
 *
 * kind and hardness answer different questions and must not be conflated.
 * Hardness is how the POSTING presents the requirement; kind is what sort
 * of thing it is. A posting can genuinely require a growth mindset, so
 * that stays HARD, and it is the TRAIT kind, not a downgrade to
 * PREFERRED, that stops the scorer treating it as a missing skill.
 *
 * The three-valued hardness is the point of using a model at all. A
 * keyword scan cannot tell "5+ years required" from "5+ years preferred"
 * from "we'd love someone with 5 years", and collapsing those produces
 * either false rejections or false matches.
 */

// 4: hardness rules rewritten to key on the employer's wording and
// section headings, independent of how specialized a requirement is or
// whether anyone could satisfy it; duplicate-capability rule added.
// Version 3 output is contaminated by the inverse of both and must not
// be treated as equivalent.
export const EXTRACTION_VERSION = 4;

export interface ExtractedRequirement {
  raw_text: string;
  normalized_term: string;
  kind: "SKILL" | "TOOL" | "CREDENTIAL" | "EDUCATION" | "EXPERIENCE_YEARS" | "DOMAIN" | "TRAIT" | "LEGAL" | "LOGISTICAL" | "OTHER";
  is_hard_requirement: "HARD" | "PREFERRED" | "UNCLEAR";
  hard_requirement_reason: string;
  minimum_years: number | null;
  confidence: number;
}

export interface ExtractionOutput {
  requirements: ExtractedRequirement[];
  remote_policy_stated: "FULLY_REMOTE" | "HYBRID" | "ONSITE" | "NOT_STATED";
  remote_geographic_restriction: string | null;
  notes: string | null;
}

const SYSTEM = `You extract requirements from job postings.

Rules, in order of importance:

1. Extract ONLY what the posting states. Never add a requirement because
   the role "obviously" needs it. A backend job that never mentions SQL
   has no SQL requirement.
2. Every requirement must be traceable to specific words in the posting.
   raw_text must be a short verbatim quote or near-quote from the posting.
3. Classify hardness from the EMPLOYER'S WORDING ONLY.
   HARD      the posting presents it as required, must-have, minimum.
   PREFERRED the posting presents it as preferred, nice to have, bonus,
             a plus, ideally, desired where clearly non-mandatory.
   UNCLEAR   you genuinely cannot tell which. Use this freely. It is the
             correct answer far more often than people assume, and it is
             always better than guessing.

3a. Wording that makes something HARD:
   "required", "must", "must have", "minimum", "at least", "X+ years",
   "N years of experience required", "requires", "you will need",
   "required degree", "required license/certification", and any
   requirement appearing under a heading such as "Minimum
   Qualifications", "Requirements", "Basic Qualifications", "What you
   must have".

3b. Wording that makes something PREFERRED:
   "preferred", "ideally", "nice to have", "a plus", "bonus", "desired",
   "we'd love", and any requirement appearing under a heading such as
   "Preferred Qualifications", "Nice to Have", "Bonus Points".

3c. The section heading a requirement sits under is usually the STRONGEST
   signal available. A bullet under "Minimum Qualifications" is HARD even
   if its own sentence contains no modal verb. A bullet under "Preferred
   Qualifications" is PREFERRED even if it sounds central to the job.

3d. Hardness is INDEPENDENT of every one of the following. None of them
   may influence the classification:
   - how specialized, technical or occupationally deep the requirement is
   - how generic or commonplace it is
   - how hard or easy it would be for any particular person to satisfy
   - whether you think it is important to doing the job well
   - whether it is the "real substance" of the role

   Two failures this rule exists to prevent, both observed in production:

   A posting titled "Associate (FDD/TAS Experience Required)" stated
   "Minimum of 3+ years of Financial Due Diligence or M&A Transaction
   Advisory". That is HARD: it says minimum, it says 3+ years, and the
   title says required. It was classified PREFERRED because it was
   specialized. Specialization is not softness.

   The same posting's "Strong verbal and written communication skills
   (e.g. PowerPoint)" was classified HARD, promoting a generic tool
   mentioned only as an example. A tool named as an illustration inside a
   broader sentence is not itself a separate hard requirement. Do not
   promote generic tools (Excel, PowerPoint, Word, Google Docs, email)
   to HARD unless the posting separately and explicitly requires them.

3e. Never soften a requirement because a candidate is unlikely to meet
   it, and never harden one because a candidate does meet it. You are not
   told anything about any candidate, and must not reason about one.
4. minimum_years only when the posting states a number for that specific
   requirement. Never infer years from seniority in the title.
5. normalized_term is the short canonical name of the thing (e.g.
   "postgresql", "project management", "cpa"). Lowercase. No qualifiers
   like "strong" or "proven".
5b. Choose "kind" carefully. Three groups behave very differently:
   - SKILL, TOOL, CREDENTIAL, EDUCATION, DOMAIN, EXPERIENCE_YEARS are
     capabilities a person can evidence: "postgresql", "cpa", "5 years in
     logistics".
   - TRAIT is a personal quality with no objective evidence: "growth
     mindset", "attention to detail", "excellent communicator", "thrives
     in ambiguity", "self-starter", "team player". If a posting presents
     it as required, still classify hardness as HARD. The kind is what
     marks it as a trait, not the hardness.
   - LEGAL and LOGISTICAL are external constraints rather than
     capabilities: work authorization, visa sponsorship, required
     residency or location, travel percentage, shift or schedule, lifting
     or physical requirements. Use these instead of TRAIT for anything
     that is a condition of the job rather than a quality of the person.
6. Do not extract company benefits, culture statements, equal-opportunity
   text, or descriptions of what the TEAM or COMPANY does. Only
   requirements of the candidate.
6b. CRITICAL: many postings state requirements as prose describing the
   ideal person rather than as a list of things. These ARE requirements
   and must be extracted. Sections headed "Who you are", "What you'll
   bring", "About you", "The ideal candidate", "Minimum requirements" or
   similar are requirement sections even when every bullet is a sentence
   about a person.

   "A deep networking expert with 5+ years troubleshooting connectivity
   across enterprise environments, with strong knowledge of TCP/IP, DNS,
   DHCP, VPNs and tools such as Wireshark"

   is not a description of the team. It is several requirements: 5 years
   of networking experience, TCP/IP, DNS, DHCP, VPNs, Wireshark. Pull the
   concrete capabilities out of the sentence and emit one requirement per
   capability, quoting the part of the sentence that supports each.

   Rule 6 exists to keep out marketing copy about the employer. It must
   never be used to skip a requirements section just because it is
   written in flowing prose. If a section tells the reader what they need
   to be or have, it is requirements.
6c. One requirement per distinct capability. Do not emit the same
   capability more than once for the same posting, and do not emit
   several near-identical rows quoting the same sentence. A posting
   saying "Excellent communication, interpersonal, and organizational
   skills" states three qualities in one sentence: emit at most one row
   per distinct quality, never the same row three times.

   Genuinely distinct requirements stay distinct even when related.
   "3 years in customs brokerage" and "HTS classification" are two
   requirements, not one, and must both be kept.

7. confidence is your confidence in the CLASSIFICATION, 0 to 1. Low
   confidence is useful information, not a failure.

Also report the remote policy the posting states, if any. NOT_STATED is a
valid and common answer; do not infer it from a city name.`;

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          raw_text: { type: "string", description: "Short verbatim quote from the posting" },
          normalized_term: { type: "string" },
          kind: { type: "string", enum: ["SKILL","TOOL","CREDENTIAL","EDUCATION","EXPERIENCE_YEARS","DOMAIN","TRAIT","LEGAL","LOGISTICAL","OTHER"] },
          is_hard_requirement: { type: "string", enum: ["HARD","PREFERRED","UNCLEAR"] },
          hard_requirement_reason: { type: "string", description: "Why you classified it that way, citing the posting's wording" },
          minimum_years: { type: ["number","null"] },
          confidence: { type: "number" },
        },
        required: ["raw_text","normalized_term","kind","is_hard_requirement","hard_requirement_reason","minimum_years","confidence"],
      },
    },
    remote_policy_stated: { type: "string", enum: ["FULLY_REMOTE","HYBRID","ONSITE","NOT_STATED"] },
    remote_geographic_restriction: { type: ["string","null"] },
    notes: { type: ["string","null"], description: "Anything ambiguous worth a human seeing" },
  },
  required: ["requirements","remote_policy_stated","remote_geographic_restriction","notes"],
};

const VALID_KINDS = new Set([
  "SKILL","TOOL","CREDENTIAL","EDUCATION","EXPERIENCE_YEARS","DOMAIN","TRAIT","LEGAL","LOGISTICAL","OTHER",
]);
const VALID_HARDNESS = new Set(["HARD","PREFERRED","UNCLEAR"]);

export interface Coercion { field: string; got: string; used: string }

/**
 * Validates and coerces one requirement before it is trusted.
 *
 * A schema-constrained tool call is a strong constraint, not a guarantee.
 * The bulk run proved it: the model returned kind "PREFERRED", putting a
 * hardness value in the kind field, and Postgres rejected the enum. Every
 * field coming out of a model is now checked at the boundary rather than
 * at the database, and anything corrected is reported instead of being
 * quietly accepted.
 */
export function sanitizeRequirement(
  raw: Partial<ExtractedRequirement>,
): { requirement: ExtractedRequirement; coercions: Coercion[] } | null {
  const coercions: Coercion[] = [];
  const rawText = String(raw.raw_text ?? "").trim();
  const term = String(raw.normalized_term ?? "").trim().toLowerCase();
  // Without a quote or a term there is nothing to ground or match. Dropped
  // rather than stored as an empty requirement.
  if (!rawText || !term) return null;

  let kind = String(raw.kind ?? "").toUpperCase();
  if (!VALID_KINDS.has(kind)) {
    // The specific confusion seen in production: a hardness value in the
    // kind field. Recorded so the prompt can be judged on real evidence.
    const swapped = VALID_HARDNESS.has(kind);
    coercions.push({ field: "kind", got: kind || "(empty)", used: swapped ? "OTHER (hardness value in kind field)" : "OTHER" });
    kind = "OTHER";
  }

  let hardness = String(raw.is_hard_requirement ?? "").toUpperCase();
  if (!VALID_HARDNESS.has(hardness)) {
    coercions.push({ field: "is_hard_requirement", got: hardness || "(empty)", used: "UNCLEAR" });
    hardness = "UNCLEAR";
  }

  let years: number | null = null;
  if (raw.minimum_years !== null && raw.minimum_years !== undefined) {
    const y = Number(raw.minimum_years);
    if (Number.isFinite(y) && y >= 0 && y <= 50) years = y;
    else coercions.push({ field: "minimum_years", got: String(raw.minimum_years), used: "null" });
  }

  let conf = Number(raw.confidence);
  if (!Number.isFinite(conf)) { coercions.push({ field: "confidence", got: String(raw.confidence), used: "0.5" }); conf = 0.5; }
  conf = Math.max(0, Math.min(1, conf));

  return {
    requirement: {
      raw_text: rawText.slice(0, 2000),
      normalized_term: term.slice(0, 300),
      kind: kind as ExtractedRequirement["kind"],
      is_hard_requirement: hardness as ExtractedRequirement["is_hard_requirement"],
      hard_requirement_reason: String(raw.hard_requirement_reason ?? "").slice(0, 2000),
      minimum_years: years,
      confidence: conf,
    },
    coercions,
  };
}

export async function extractRequirements(
  llm: LlmProvider,
  job: { title: string; company: string; descriptionText: string },
) {
  // Truncated to bound cost per call. The largest description in the
  // eligible set is 16k characters; 24k leaves headroom without letting a
  // pathological posting dominate the bill.
  const description = job.descriptionText.slice(0, 24_000);

  return llm.complete<ExtractionOutput>({
    tier: "fast",
    purpose: "extract_requirements",
    system: SYSTEM,
    // 8192, not 4096. The longest genuine extraction observed needed more
    // than 4096 and was silently cut off.
    maxOutputTokens: 8192,
    temperature: 0,
    jsonSchema: SCHEMA,
    prompt: `Company: ${job.company}
Job title: ${job.title}

Posting:
---
${description}
---

Extract the candidate requirements.`,
  });
}


/**
 * Wording in a requirement's own quote that makes it mandatory.
 *
 * Deliberately narrow. These are phrases an employer uses to compel, not
 * merely to emphasise: "strong" and "excellent" are not here, because
 * they describe a level rather than an obligation.
 */
const MANDATORY = /\b(?:minimum(?:\s+of)?|at\s+least|must\s+(?:have|possess|be)|required?|requires|requirement)\b/i;

/** Wording that marks a requirement optional, which always wins. */
const OPTIONAL = /\b(?:preferred|preferably|ideally|nice\s+to\s+have|a\s+plus|bonus|desired|desirable)\b/i;

/**
 * Mandatory wording that has been negated, and so compels nothing.
 *
 * The first version of this matched "required" anywhere in the quote and
 * promoted two postings that said the exact opposite: Stripe's "You've
 * ever started or run a business before (not a requirement)" and
 * Hightouch's "While no prior experience with LLMs and AI is required".
 * Both were turned into HARD requirements by the word they used to say
 * the requirement did not exist.
 */
const NEGATED = new RegExp([
  // "(not a requirement)", "is not required", "not necessary"
  String.raw`\bnot\s+(?:a\s+)?(?:required|requirement|necessary)\b`,
  // "no prior experience with LLMs and AI is required" - the subject
  // between "no" and "required" can run to a clause, so allow a span
  // rather than a fixed word count, but stop at sentence punctuation.
  String.raw`\bno\s+(?:prior\s+)?[^.;!?]{0,80}?\s+(?:is|are)\s+required\b`,
  String.raw`\bisn'?t\s+required\b`,
  String.raw`\bdoes\s+not\s+require\b`,
  String.raw`\bwithout\s+requiring\b`,
].join("|"), "i");

/**
 * Corrects a PREFERRED classification that the quote itself contradicts.
 *
 * The model classified "Minimum of 3+ years of Financial Due Diligence or
 * M&A Transaction Advisory" as PREFERRED on a posting whose title ends
 * "(FDD/TAS Experience Required)". Its own quote says "Minimum of". A
 * quote that compels cannot be optional, so this promotes it and records
 * the correction rather than trusting the label over the words.
 *
 * Only ever promotes PREFERRED to HARD, and never when the quote also
 * carries optional wording ("Preferred: minimum 3 years" stays
 * PREFERRED). It cannot demote, so it can never soften a requirement.
 */
export function reconcileHardness(
  req: { raw_text: string; is_hard_requirement: string },
): { hardness: ExtractedRequirement["is_hard_requirement"]; corrected: boolean } {
  const current = req.is_hard_requirement as ExtractedRequirement["is_hard_requirement"];
  if (current !== "PREFERRED") return { hardness: current, corrected: false };
  const text = String(req.raw_text ?? "");
  if (OPTIONAL.test(text)) return { hardness: current, corrected: false };
  // A negated requirement is not a requirement.
  if (NEGATED.test(text)) return { hardness: current, corrected: false };
  if (!MANDATORY.test(text)) return { hardness: current, corrected: false };
  return { hardness: "HARD", corrected: true };
}

/**
 * Collapses rows that state the same capability twice.
 *
 * Flexport's Customs Specialist emitted "Excellent communication,
 * interpersonal, and organizational skills" three times as three TRAIT
 * rows, inflating both the requirement count and the trait share of the
 * posting. Identity is the normalized term plus the kind, so two
 * genuinely different requirements that merely share a sentence stay
 * separate, and the same term recorded as both a SKILL and a TOOL stays
 * separate too.
 *
 * The surviving row keeps the strongest hardness seen, so deduplication
 * can never soften a requirement: HARD beats UNCLEAR beats PREFERRED.
 */
const HARDNESS_RANK: Record<string, number> = { HARD: 3, UNCLEAR: 2, PREFERRED: 1 };

export function dedupeRequirements<T extends { normalized_term: string; kind: string; is_hard_requirement: string }>(
  reqs: T[],
): { kept: T[]; removed: number } {
  const byKey = new Map<string, T>();
  let removed = 0;
  for (const r of reqs) {
    const key = `${String(r.normalized_term ?? "").trim().toLowerCase()} ${r.kind}`;
    const seen = byKey.get(key);
    if (!seen) { byKey.set(key, r); continue; }
    removed++;
    const a = HARDNESS_RANK[seen.is_hard_requirement] ?? 0;
    const b = HARDNESS_RANK[r.is_hard_requirement] ?? 0;
    if (b > a) byKey.set(key, r);
  }
  return { kept: [...byKey.values()], removed };
}
