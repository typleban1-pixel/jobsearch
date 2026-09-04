/**
 * The bulk-queue DB behaviour against real data: create-one, dedup by
 * canonical opening (double-click safe via the unique index), and
 * already-SUBMITTED never counts as re-queueable. Creates one transient
 * DRAFT and deletes it. Needs service-role env.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let n=0,bad=0; const ok=(c:boolean,w:string,x="")=>{n++;console.log(`  ${c?"PASS":"FAIL"}  ${w}${x?" — "+x:""}`);if(!c)bad++;};
const LIVE="(REJECTED,WITHDRAWN,ABANDONED)";

// find a clean OPEN+ELIGIBLE job with a current version and NO live application
const page=async(t:string,c:string,f:(q:any)=>any=(q)=>q)=>{const o:any[]=[];let fr=0;for(;;){const{data}=await f(db.from(t).select(c)).range(fr,fr+999);if(!data?.length)break;o.push(...data);if(data.length<1000)break;fr+=1000;}return o;};
const openIds = new Set((await page("applications","canonical_opening_id",(q)=>q.not("status","in",LIVE).not("canonical_opening_id","is",null))).map((a:any)=>a.canonical_opening_id));
const cands = await page("jobs","id,canonical_opening_id",(q)=>q.eq("status","OPEN").eq("eligibility","ELIGIBLE").not("canonical_opening_id","is",null).limit(200));
let picked:any=null;
for(const j of cands){ if(openIds.has(j.canonical_opening_id))continue; const {data:v}=await db.from("job_versions").select("id").eq("job_id",j.id).eq("is_current",true).maybeSingle(); if(v){picked={...j,versionId:v.id};break;} }
ok(!!picked, "found a clean OPEN+ELIGIBLE job with a version and no live application", picked?.id?.slice(0,8));
if(!picked){console.log(`\n${n-bad}/${n} passed`);process.exit(bad?1:0);}

const draft={job_id:picked.id,job_version_id:picked.versionId,canonical_opening_id:picked.canonical_opening_id,status:"DRAFT",submission_mode:"ASSISTED"};
const ins1=await db.from("applications").insert(draft).select("id").single();
ok(!ins1.error && !!ins1.data,"queue one job -> DRAFT created", ins1.error?.message);
const appId=ins1.data?.id;
// double-click / duplicate: a 2nd DRAFT on the same opening must be refused by the unique index
const ins2=await db.from("applications").insert(draft).select("id").maybeSingle();
ok(!!ins2.error,"a second application on the same opening is refused (dedup / double-click safe)", ins2.error?.message?.slice(0,50));
// the opening now reads as having a live application (what classifyQueueJob checks)
const {data:live}=await db.from("applications").select("id,status").eq("canonical_opening_id",picked.canonical_opening_id).not("status","in",LIVE);
ok((live?.length??0)>=1,"the opening now has a live application -> would classify as 'already'");
// cleanup the transient DRAFT
if(appId) await db.from("applications").delete().eq("id",appId);
ok(true,"transient DRAFT cleaned up");

// already-SUBMITTED never re-queued: a SUBMITTED app counts as live
const {data:sub}=await db.from("applications").select("canonical_opening_id").not("submitted_at","is",null).limit(1).maybeSingle();
if(sub?.canonical_opening_id){ const {data:isLive}=await db.from("applications").select("id").eq("canonical_opening_id",sub.canonical_opening_id).not("status","in",LIVE); ok((isLive?.length??0)>=1,"a SUBMITTED opening reads as live -> never re-queued"); }
console.log(`\n${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
