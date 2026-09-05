/**
 * Schema/code compatibility pre-flight for extraction.
 *
 * The RESPONSIBILITY incident: the extractor emitted a requirement kind the DB
 * enum did not accept, so 200+ paid model responses were produced and then
 * rejected at persistence. This makes that class of failure fail FAST and FREE:
 * before a single paid model call, it asks the live database which requirement
 * kinds the enum accepts and refuses to run if the extractor can emit one the
 * enum cannot store.
 *
 * Reads the enum through the enum_values() RPC (migration 0088), so it needs no
 * direct SQL connection. If that RPC is missing, the migrations that carry it
 * (and the enum value) have not been applied -- which is exactly when the batch
 * must NOT spend -- so a missing RPC is itself a hard stop.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { VALID_KINDS } from "./extractRequirements.ts";

export async function assertRequirementKindsPersistable(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.rpc("enum_values", { enum_type: "requirement_kind" });
  if (error) {
    throw new Error(
      `extraction preflight: could not read the requirement_kind enum via enum_values() (${error.message}). ` +
      `Apply migrations 0087 (RESPONSIBILITY) and 0088 (enum_values) before spending on extraction.`);
  }
  const dbValues = new Set((data as string[] | null) ?? []);
  const missing = [...VALID_KINDS].filter((k) => !dbValues.has(k));
  if (missing.length) {
    throw new Error(
      `extraction preflight FAILED: the extractor can emit kind(s) [${missing.join(", ")}] that the live ` +
      `requirement_kind enum does not accept ([${[...dbValues].join(", ")}]). Persistence would fail after paid ` +
      `calls. Migrate the enum first (see 0087_responsibility_requirement_kind.sql).`);
  }
  return [...dbValues];
}
