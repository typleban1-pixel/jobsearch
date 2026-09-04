/**
 * Resume Builder worker mechanics, offline (no paid LLM, no render):
 *  A. an unusable posting FAILS with POSTING_UNCLEAR and never calls the model
 *  B. the claim is atomic: two concurrent claims of one QUEUED row -> one wins
 *  C. a stale PREPARING claim is released back to QUEUED
 * The full extract->compose->render happy path needs a live model + Chrome
 * and is validated as a live smoke test, not here.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { generateResume } from "../lib/applications/resumeGeneration.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let n = 0, bad = 0; const ok = (c: boolean, w: string) => { n++; if (!c) { bad++; console.error(`FAIL ${w}`); } };
const created: string[] = [];
const mk = async (over: Record<string, unknown> = {}) => {
  const { data } = await db.from("resume_generations").insert({ pasted_text: "x", ...over }).select("id").single();
  created.push(data!.id); return data!.id as string;
};

// A. unusable posting -> POSTING_UNCLEAR, model untouched
let modelCalled = false;
const throwingLlm = { complete: async () => { modelCalled = true; throw new Error("model must not be called"); } } as any;
const out = await generateResume(db, {
  id: "t", pasted_text: "too short", pasted_html: null,
  detected_title: null, detected_company: null, corrected_title: null, corrected_company: null,
}, throwingLlm);
ok(out.ok === false && (out as any).errorCategory === "POSTING_UNCLEAR", `unusable posting -> POSTING_UNCLEAR (${JSON.stringify(out)})`);
ok(modelCalled === false, "the model was never called for an unusable posting");

// B. atomic claim
const idB = await mk();
const claimOnce = () => db.from("resume_generations")
  .update({ status: "PREPARING", started_at: new Date().toISOString() })
  .eq("id", idB).eq("status", "QUEUED").select("id").maybeSingle();
const [r1, r2] = await Promise.all([claimOnce(), claimOnce()]);
const winners = [r1.data, r2.data].filter(Boolean).length;
ok(winners === 1, `exactly one concurrent claim wins (got ${winners})`);

// C. stale release
const idC = await mk();
await db.from("resume_generations").update({ status: "PREPARING", started_at: new Date(Date.now() - 60 * 60_000).toISOString() }).eq("id", idC);
const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
const { data: released } = await db.from("resume_generations").update({ status: "QUEUED", started_at: null })
  .eq("status", "PREPARING").lt("started_at", cutoff).eq("id", idC).select("id");
ok((released?.length ?? 0) === 1, "a stale PREPARING claim is released back to QUEUED");

// cleanup
for (const id of created) await db.from("resume_generations").delete().eq("id", id);
console.log(`${n - bad}/${n} assertions passed`);
process.exit(bad ? 1 : 0);
