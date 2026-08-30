import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted at every depth.
 *
 * Both boards return key order that is stable in practice and guaranteed
 * by nothing. Hashing JSON.stringify output directly would eventually
 * produce a spurious "changed" for a job whose content never moved, which
 * creates a bogus job_version and a bogus change record. Since versions
 * are immutable, that garbage would be permanent.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortDeep(src[k]);
    return out;
  }
  return value;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hashObject(value: unknown): string {
  return sha256(canonicalJson(value));
}
