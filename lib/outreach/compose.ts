/**
 * The follow-up note to a recruiter, composed so the wording is right every
 * time.
 *
 * No model writes any of it. The note is the person's own email, the one
 * they wrote to Chartis on 2026-09-07 and asked to be the pattern, with
 * the parts that depend on the job filled from facts the system already
 * holds: the posting's title and company as recorded, what the posting
 * itself emphasises (read from its text against a fixed vocabulary, never
 * paraphrased), and one line tying the person's background to the
 * employer's field when the posting is squarely in healthcare or
 * education. What cannot be filled that way is left for the person,
 * marked, never improvised.
 *
 * The fixed paragraphs are the person's words verbatim. Change them here
 * and only here, then run scripts/outreach-selftest.ts.
 */
import { AI_TERMS, STARTUP_TERMS } from "../render/tailoredDoc.ts";

export interface OutreachInput {
  company: string;
  title: string;
  recruiterName: string | null;
  /** The posting's own words: title, description, requirements. */
  postingText: string;
  profile: { preferredName: string | null; firstName: string; lastName: string; phone: string | null; linkedin: string | null };
}

export interface OutreachDraft {
  subject: string;
  body: string;
  /** True when a slot could not be filled from approved material; the body says where. */
  needsYourWords: boolean;
  /** Anything the checks objected to. Empty means the note passed every rule. */
  problems: string[];
}

/** The person's own words (Chartis note, 2026-09-07). Verbatim. */
export const STORY =
  "Short version: I built RentPup (rentpup.com) on my own, a platform that monitors Cleveland public records to discover property compliance issues owners would otherwise miss. It has real customers. Most of the work was unglamorous, pulling messy data from sources that don't talk to each other and turning it into something someone can act on. At Genius One, I do a more conventional version of the same thing, building systems for customer scoring, demand forecasting, and experimentation.";
export const STANCE =
  "The build is the straightforward part. Getting an organization to actually change how it works is the real project, and that's the part I like.";
export const CLOSE =
  "I've attached my resume, and if you give me the opportunity, I'd love to explain more! And if someone else is handling the role, I'd appreciate you pointing me in the right direction.";
export const SIGN_OFF = "Thanks so much,";

/**
 * What a posting emphasises, in the words the note uses for it. Each theme
 * is detected from the posting's own text; the phrase is fixed. A theme
 * counts when the posting returns to it (two mentions), except AI and
 * early-stage, which the person wants named on a single mention.
 */
const THEMES: { phrase: string; test: RegExp; min: number }[] = [
  { phrase: "finding practical uses for AI", test: AI_TERMS, min: 1 },
  { phrase: "building at an early stage", test: STARTUP_TERMS, min: 1 },
  { phrase: "improving how the team's processes actually work", test: /\b(?:process(?:es)?[- ]improvement|improv\w+ (?:our |the |business |bd |sales )?process(?:es)?|operational (?:efficiency|excellence)|streamlin\w+|standardi[sz]\w+|workflows?|playbooks?|sops?)\b/gi, min: 2 },
  { phrase: "putting data to work in day-to-day decisions", test: /\b(?:data[- ]driven|analytics|dashboards?|reporting|kpis?|metrics|forecast\w*|insights?)\b/gi, min: 2 },
  { phrase: "the client relationship side", test: /\b(?:client|customer|account)[- ](?:success|onboarding|experience|relationships?|retention|engagement)\b/gi, min: 2 },
  { phrase: "working across teams", test: /\b(?:cross[- ]functional\w*|stakeholders?|across (?:teams|departments|functions))\b/gi, min: 2 },
  { phrase: "hands-on marketing execution", test: /\b(?:marketing|campaigns?|seo|email marketing|content (?:strategy|marketing|calendar)|ecommerce|e-commerce)\b/gi, min: 2 },
  { phrase: "shaping the product", test: /\b(?:product (?:management|development|roadmaps?|strategy|vision|requirements)|roadmaps?|user research|prototyp\w+)\b/gi, min: 2 },
  { phrase: "keeping operations running well", test: /\b(?:operations|operational|logistics|vendor management|procurement|scheduling)\b/gi, min: 2 },
];

/** The employer's field, when the posting is squarely in one the person's background speaks to. */
const FIELDS: { line: string; test: RegExp; min: number }[] = [
  { line: "My bachelor's is also in Health Science, so doing this work at a healthcare firm is the part I'd actually be excited about.",
    test: /\b(?:health ?care|health systems?|hospitals?|clinical|clinics?|patients?|payers?|payors?|pharma(?:ceutical)?s?|life sciences|medical|medicare|medicaid|biotech\w*|providers? organizations?)\b/gi, min: 3 },
  { line: "I also spent three years teaching at a community college, so doing this work in education is the part I'd actually be excited about.",
    test: /\b(?:higher education|universit(?:y|ies)|colleges?|students?|edtech|ed-tech|learners?|k-12|schools?|faculty|curriculum)\b/gi, min: 3 },
];

const count = (re: RegExp, text: string) => (text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) ?? []).length;
const FORBIDDEN = /\b(?:salary|compensation|match score|my score|as an ai|an ai wrote|generated by)\b/i;
export const WORD_LIMIT = 230;

/** Up to two focus phrases; AI, when the posting names it, is always one of them. */
export function themesOf(postingText: string): string[] {
  const hit = THEMES.map((t) => ({ t, n: count(t.test, postingText) })).filter(({ t, n }) => n >= t.min)
    .sort((a, b) => Number(b.t.test === AI_TERMS) - Number(a.t.test === AI_TERMS) || b.n / b.t.min - a.n / a.t.min);
  return hit.slice(0, 2).map(({ t }) => t.phrase);
}
export function fieldLine(postingText: string, company: string): string | null {
  const text = `${company}\n${postingText}`;
  return FIELDS.find((f) => count(f.test, text) >= f.min)?.line ?? null;
}

export function composeOutreach(i: OutreachInput): OutreachDraft {
  const problems: string[] = [];
  const name = `${i.profile.preferredName ?? i.profile.firstName} ${i.profile.lastName}`.trim();
  const themes = themesOf(i.postingText);
  let needsYourWords = false;
  const focus = themes.length ? themes.join(" and ")
    : (needsYourWords = true, "[the one or two things about this role that made you want to write]");

  const paragraphs = [
    `Hi ${i.recruiterName?.trim() || "there"},`,
    `I just applied for the ${i.title} role at ${i.company}. The focus on ${focus} made me want to reach out directly.`,
    STORY,
    STANCE,
    fieldLine(i.postingText, i.company) ?? "",
    CLOSE,
    SIGN_OFF,
    [name, [i.profile.phone, i.profile.linkedin].filter(Boolean).join(" · ")].filter(Boolean).join("\n"),
  ].filter((p) => p.trim().length > 0);
  const body = paragraphs.join("\n\n");
  const subject = `${i.title} at ${i.company} — ${name}`;

  // The rules, checked on the finished text.
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > WORD_LIMIT) problems.push(`${words} words; the note must stay under ${WORD_LIMIT}`);
  if (!needsYourWords && /\[[^\]]+\]/.test(body)) problems.push("a placeholder was left in the text");
  if (FORBIDDEN.test(body)) problems.push("the note mentions something it must not (pay, score, or the system)");
  if (!i.company.trim() || !i.title.trim()) problems.push("the company or role name is missing");
  if (/\brole role\b|\bthe the\b/i.test(body)) problems.push("the role name doubles a word in the opening");
  return { subject, body, needsYourWords, problems };
}
