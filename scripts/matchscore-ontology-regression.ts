/**
 * Read-only corpus regression for the wired Match Score ontology (A + B1).
 * Imports the SAME ontologyDelta/withOntology the portal now uses, applies it
 * as a delta on each job's real production inputs, and reports the change
 * sets. Writes nothing. This is the production-anchored counterpart of the
 * earlier prototype: baseline == live Match Score, so untouched jobs move 0.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { matchScore } from "../lib/portal/matchScore.ts";
import { attentionScore, buildAttentionInput } from "../lib/portal/attentionRank.ts";
import { ontologyDelta, withOntology, makeProfileHas } from "../lib/portal/matchScoreOntology.ts";
import { norm } from "../lib/scoring/conceptRelations.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const pageAll=async(t:string,s:string,r:(q:any)=>any,ord="id")=>{const o:any[]=[];for(let f=0;;f+=1000){const{data,error}=await r(db.from(t).select(s)).order(ord,{ascending:true}).range(f,f+999);if(error)throw error;o.push(...(data??[]));if(!data||data.length<1000)break;}return o;};
const scores=await pageAll("job_scores","id,job_id,uncertainty_score,scorable,fit_breakdown",q=>q.eq("is_current",true));
const jobs=await pageAll("jobs","id,title,company_id,eligibility,status,salary_min,salary_max",q=>q.eq("status","OPEN"));const jm=new Map(jobs.map(j=>[j.id,j]));
const cands=await pageAll("job_candidacy","id,job_id,hard_met,hard_total,gating_gaps,verdict,created_at",q=>q);
const cBy=new Map<string,any>();for(const r of cands.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))))if(!cBy.has(r.job_id))cBy.set(r.job_id,r);
const reasons=await pageAll("score_reasons","id,score_id,kind",q=>q.in("kind",["SENIORITY_MATCH","SENIORITY_MISMATCH"]));const senBy=new Map<string,number>();for(const r of reasons)senBy.set(r.score_id,r.kind==="SENIORITY_MATCH"?1:-1);
const comp=await pageAll("companies","id,name",q=>q);const cn=new Map(comp.map(c=>[c.id,c.name]));
const pv=(await db.from("profile").select("profile_version").single()).data?.profile_version;
const skills=(await pageAll("profile_version_rows","row_data",q=>q.eq("profile_version",pv).eq("source_table","skills"),"row_id")).map((r:any)=>r.row_data?.name??"");
const has=makeProfileHas(skills);
const rows:any[]=[];
function mk(hm:number,ht:number,hd:number,b:any,s:any,j:any,sen:number,assess:boolean){return matchScore({hardMet:hm,hardTotal:ht,hardDirect:hd,coverage:typeof b.coverage==="number"?b.coverage:null,coreGaps:0,gatingGaps:(cBy.get(j.id)?.gating_gaps??[]).length,educationGatesUnmet:b.educationGatesUnmet??0,unresolvedCore:0,excludedUnknown:b.excludedUnknown??0,seniorityAligned:sen>0?true:sen<0?false:null,salary:j.salary_max??j.salary_min??null,eligibility:j.eligibility,uncertaintyScore:s.uncertainty_score===null?null:Number(s.uncertainty_score),scorable:s.scorable!==false,assessable:assess}).score;}
for(const s of scores){const j=jm.get(s.job_id);if(!j)continue;const b:any=s.fit_breakdown??{};const c=cBy.get(s.job_id);
  const sen=senBy.get(s.id)??0;const ai=buildAttentionInput({candidacy:c?{hardMet:c.hard_met,hardTotal:c.hard_total,transferableMatches:0,coreGaps:0}:null,conceptDetail:b.conceptDetail??[],salary:j.salary_max??j.salary_min??null});const assess=attentionScore(ai).band==="ASSESSABLE";
  const base={hardMet:c?.hard_met??0,hardTotal:c?.hard_total??0,hardDirect:ai.hardDirect};
  const cur=mk(base.hardMet,base.hardTotal,base.hardDirect,b,s,j,sen,assess);
  const d=ontologyDelta(b.conceptDetail??[],has);const f=withOntology(base,d);
  const proto=mk(f.hardMet,f.hardTotal,f.hardDirect,b,s,j,sen,assess);
  rows.push({id:j.id,title:j.title,co:cn.get(j.company_id)??"?",cur,proto,verdict:c?.verdict,touched:(d.dMet||d.dTotal||d.dDirect)?1:0});
}
const byC=[...rows].sort((a,b)=>b.cur-a.cur),byP=[...rows].sort((a,b)=>b.proto-a.proto);
const untouched=rows.filter(r=>!r.touched&&r.cur!==r.proto),toZero=rows.filter(r=>r.cur>0&&r.proto===0),ge10=rows.filter(r=>Math.abs(r.cur-r.proto)>=10),rise20=rows.filter(r=>r.proto-r.cur>=20);
console.log(`profile_version=${pv} skills=${skills.length}  rows=${rows.length} touched=${rows.filter(r=>r.touched).length}`);
console.log(`UNTOUCHED jobs whose score changed (MUST be 0): ${untouched.length}`);
console.log(`|Δ|>=10: ${ge10.length}   rise>=20: ${rise20.length}   fell to 0: ${toZero.length}`);
console.log(`\nNAMED JOBS (cur -> proto, rank):`);for(const T of["Sales Compensation Manager","Senior Product Manager, Checkout","Specialist, Strategic Growth","Senior Digital Marketing Manager","BD Operations","Engagement Associate"]){const r=rows.find(x=>x.title.includes(T));if(r)console.log(`   ${String(r.cur).padStart(2)}->${String(r.proto).padStart(2)}  #${byC.findIndex(x=>x.id===r.id)+1}->#${byP.findIndex(x=>x.id===r.id)+1}  ${r.title.slice(0,36)} @ ${r.co.slice(0,14)}`);}
const dist=(k:string)=>{const d=[0,0,0,0,0,0];for(const r of rows){const v=r[k];const i=v>=90?0:v>=80?1:v>=70?2:v>=60?3:v>=50?4:5;d[i]=(d[i]??0)+1;}return d;};
console.log(`\ndistribution [90+,80s,70s,60s,50s,<50]  cur ${JSON.stringify(dist("cur"))}  proto ${JSON.stringify(dist("proto"))}`);
console.log(`\nPROPOSED PRODUCTION TOP 15:`);for(let i=0;i<15;i++){const r=byP[i]!;console.log(`   #${String(i+1).padStart(2)} ${String(r.proto).padStart(2)} ${(r.verdict||"").slice(0,7).padEnd(7)} ${r.title.slice(0,38)} @ ${r.co.slice(0,14)}`);}
