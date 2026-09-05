/**
 * COMPENSATING ROLLBACK for the v17 profile release (forward-only; NOT a pointer
 * reversal -- the monotonicity trigger forbids profile_version 17 -> 16).
 *
 * Proven invariant: v17's snapshot differs from v16's by exactly one row (the new
 * skill) plus the version-stamped profile row. Reverting the skill and cutting a
 * new version reproduces v16's non-profile truth byte-for-byte (fingerprint
 * 4e46f5f3d23e3df2a517d9e9d4af9728).
 *
 * Sequence (dry-run by default; --commit applies):
 *   1. strip `capabilities` from every master-résumé line   (reverses résumé enrichment; résumé is not versioned)
 *   2. delete the "Managing concurrent priorities" skill      (removes it from the next snapshot)
 *   3. bump_profile_version("rollback: revert v17")           (cuts v18 == v16 truth)
 *   4. then run:  node scripts/score.ts --commit  &&  node scripts/score-candidacy.ts --write
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { required } from "../lib/env.ts";

const COMMIT = process.argv.includes("--commit");
const NEW_SKILL_NAME = "Managing concurrent priorities";
const V16_NONPROFILE_FP = "4e46f5f3d23e3df2a517d9e9d4af9728";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

const live = (await db.from("profile").select("profile_version").eq("singleton", true).single()).data!;
console.log(`live pointer: v${live.profile_version}`);
if (live.profile_version !== 17) { console.log("ABORT: rollback expects live v17."); process.exit(1); }

// step 1 preview: strip capabilities
const { data: mr } = await db.from("resumes").select("id,content").eq("is_master", true).ilike("label", "%version 16%").maybeSingle();
const content: any = JSON.parse(JSON.stringify(mr!.content));
let stripped = 0;
const strip = (l: any) => { if (l && Array.isArray(l.capabilities)) { delete l.capabilities; stripped++; } };
for (const role of content.doc.roles ?? []) for (const l of role.lines ?? []) strip(l);
for (const p of content.doc.projects ?? []) { if (p.line) strip(p.line); for (const o of p.optional ?? []) strip(o); }
console.log(`step 1: strip capabilities from ${stripped} résumé lines.`);

// step 2 preview: locate skill
const { data: sk } = await db.from("skills").select("id,name,status").eq("name", NEW_SKILL_NAME).maybeSingle();
console.log(`step 2: delete skill "${NEW_SKILL_NAME}" -> ${sk ? sk.id : "NOT FOUND"}`);
console.log(`step 3: bump_profile_version -> v18 (expected non-profile fingerprint ${V16_NONPROFILE_FP}).`);
console.log(`step 4: node scripts/score.ts --commit && node scripts/score-candidacy.ts --write`);

if (!COMMIT) { console.log("\n[DRY RUN] no writes. Re-run with --commit to execute the rollback."); process.exit(0); }

console.log("\n===== COMMITTING ROLLBACK =====");
const u = await db.from("resumes").update({ content }).eq("id", mr!.id); if (u.error) { console.log("resume strip FAILED:", u.error.message); process.exit(1); }
console.log("résumé capabilities stripped.");
if (sk) { const d = await db.from("skills").delete().eq("id", sk.id); if (d.error) { console.log("skill delete FAILED:", d.error.message); process.exit(1); } console.log("skill deleted."); }
const b = await db.rpc("bump_profile_version", { p_reason: "rollback: revert v17, restore pre-v17 truth" }); if (b.error) { console.log("bump FAILED:", b.error.message); process.exit(1); }
const v18 = b.data as number;
console.log(`cut v${v18}.`);

// verify v18 non-profile fingerprint == v16
const snap = async (v: number) => { const o: any[] = []; for (let f = 0; ; f += 1000) { const { data } = await db.from("profile_version_rows").select("source_table,row_id,row_data").eq("profile_version", v).order("row_id").range(f, f + 999); o.push(...(data ?? [])); if (!data || data.length < 1000) break; } return o; };
const fp = md5((await snap(v18)).filter(r => r.source_table !== "profile").map(r => `${r.source_table}|${r.row_id}|${JSON.stringify(r.row_data)}`).sort().join("\n"));
console.log(`v${v18} non-profile fingerprint: ${fp}  ${fp === V16_NONPROFILE_FP ? "OK == v16, rollback reproduced v16 truth" : "**MISMATCH -- investigate**"}`);
console.log("Now rescore: node scripts/score.ts --commit && node scripts/score-candidacy.ts --write");
