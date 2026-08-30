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

export const EXTRACTION_VERSION = 2;

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
3. Classify hardness honestly:
   HARD      the posting presents it as required, must-have, minimum.
   PREFERRED the posting presents it as preferred, nice to have, bonus,
             a plus, ideally.
   UNCLEAR   you genuinely cannot tell which. Use this freely. It is the
             correct answer far more often than people assume, and it is
             always better than guessing.
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
   text, or descriptions of what the team does. Only requirements of the
   candidate.
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
    maxOutputTokens: 4096,
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
