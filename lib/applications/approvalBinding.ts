/**
 * Binding an approval to the content it was given for.
 *
 * A person approving an application is agreeing to a specific resume and
 * a specific set of answers. The resume was already pinned by its
 * artifact hash. The answers were not, so an approval survived them
 * changing, and what reached the employer could differ from what was
 * read.
 *
 * The hash covers the answers as sent: the field and the exact text. It
 * deliberately ignores provenance, confidence and timestamps, which can
 * move without changing a single thing the employer sees.
 */
import { createHash } from "node:crypto";

export interface AnswerForHash {
  field_key: string;
  answer_text: string | null;
}

/**
 * A stable fingerprint of an answer set.
 *
 * Sorted by field key so two reads of the same answers agree regardless
 * of row order, and null is distinguished from an empty string: a
 * deliberate blank and an empty answer are different facts.
 */
export function answerSetHash(answers: AnswerForHash[]): string {
  const canonical = answers
    .map((a) => [a.field_key, a.answer_text === null ? "\u0000null" : a.answer_text])
    .sort((x, y) => String(x[0]).localeCompare(String(y[0])))
    .map(([k, v]) => k + "\u0001" + v)
    .join("\u0002");
  return createHash("sha256").update(canonical).digest("hex");
}
