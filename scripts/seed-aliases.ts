/** Seeds term_aliases from the curated list. Idempotent. */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { SEED_ALIASES } from "../lib/matching/aliases.ts";
import { normalizeTerm } from "../lib/matching/normalize.ts";

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const rows = SEED_ALIASES.map((a) => ({
  alias: normalizeTerm(a.alias),
  canonical_term: normalizeTerm(a.canonical),
  note: a.note ?? null,
  origin: "SEED",
}));

const seen = new Set<string>();
const dupes = rows.filter((r) => (seen.has(r.alias) ? true : (seen.add(r.alias), false)));
if (dupes.length) {
  console.error(`duplicate aliases after normalization: ${dupes.map((d) => d.alias).join(", ")}`);
  process.exit(1);
}

console.log(`${rows.length} aliases collapsing onto ${new Set(rows.map((r) => r.canonical_term)).size} canonical terms`);
if (!commit) {
  console.log("dry run: pass --commit to write");
} else {
  const { error } = await db.from("term_aliases")
    .upsert(rows, { onConflict: "alias", ignoreDuplicates: false });
  if (error) { console.error(error.message); process.exit(1); }
  const { count } = await db.from("term_aliases").select("*", { count: "exact", head: true });
  console.log(`term_aliases now holds ${count} rows`);
}
