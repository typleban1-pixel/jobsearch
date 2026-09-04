/**
 * Read-only A+B1 regression over the whole rankable corpus. Applies the real
 * relationResolve + dedupeForVoting to each job's stored conceptDetail,
 * feeds the corrected (hardMet, hardDirect, hardTotal) into the real
 * matchScore(), and reports the change sets. Writes nothing.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { matchScore } from "../lib/portal/matchScore.ts";
import { attentionScore, buildAttentionInput } from "../lib/portal/attentionRank.ts";
import { relationResolve, norm, type Resolution } from "../lib/scoring/conceptRelations.ts";
import { dedupeForVoting, familyOf } from "../lib/scoring/conceptFamily.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const pageAll=async(t:string,s:string,r:(q:any)=>any,ord="id")=>{const o:any[]=[];for(let f=0;;f+=1000){const{data,error}=await r(db.from(t).select(s)).order(ord,{ascending:true}).range(f,f+999);if(error)throw error;o.push(...(data??[]));if(!data||data.length<1000)break;}return o;};
const scores=await pageAll("job_scores","id,job_id,uncertainty_score,scorable,fit_breakdown",q=>q.eq("is_current",true));
const jobs=await pageAll("jobs","id,title,company_id,eligibility,status,salary_min,salary_max",q=>q.eq("status","OPEN"));
const jm=new Map(jobs.map(j=>[j.id,j]));
const cands=await pageAll("job_candidacy","id,job_id,gating_gaps,verdict,created_at",q=>q);
const cBy=new Map<string,any>();for(const r of cands.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))))if(!cBy.has(r.job_id))cBy.set(r.job_id,r);
const reasons=await pageAll("score_reasons","id,score_id,kind",q=>q.in("kind",["SENIORITY_MATCH","SENIORITY_MISMATCH"]));
const senBy=new Map<string,number>();for(const r of reasons)senBy.set(r.score_id,r.kind==="SENIORITY_MATCH"?1:-1);
const comp=await pageAll("companies","id,name",q=>q);const cn=new Map(comp.map(c=>[c.id,c.name]));
const v16=(await pageAll("profile_version_rows","row_id,row_data",q=>q.eq("profile_version",16).eq("source_table","skills"),"row_id")).map(r=>norm(r.row_data?.name??"")).filter(Boolean);
const has=(n:string)=>{const q=norm(n);return v16.some(s=>s===q||s.includes(q)||q.includes(s));};
const rel=(x:any)=>x&&x.hardness==="HARD"&&["SKILL","OCCUPATIONAL","GATING_CREDENTIAL"].includes(x.requirementClass);
const CV:Record<Resolution,number>={DIRECT:1,TRANSFERABLE:0.5,UNKNOWN:0,ABSENT:0};
const newDirect:any[]=[],t2d:any[]=[],fams:any[]=[],directLost:any[]=[];
const rows:any[]=[];
function sc(hardTotal:number,hardDirect:number,hardMet:number,b:any,s:any,j:any,sen:number,assess:boolean){
  return matchScore({hardMet,hardTotal,hardDirect,coverage:typeof b.coverage==="number"?b.coverage:null,coreGaps:0,gatingGaps:(cBy.get(j.id)?.gating_gaps??[]).length,educationGatesUnmet:b.educationGatesUnmet??0,unresolvedCore:0,excludedUnknown:b.excludedUnknown??0,seniorityAligned:sen>0?true:sen<0?false:null,salary:j.salary_max??j.salary_min??null,eligibility:j.eligibility,uncertaintyScore:s.uncertainty_score===null?null:Number(s.uncertainty_score),scorable:s.scorable!==false,assessable:assess}).score;
}
for(const s of scores){const j=jm.get(s.job_id);if(!j)continue;const b:any=s.fit_breakdown??{};const cd:any[]=(b.conceptDetail??[]).filter(rel);
  const sen=senBy.get(s.id)??0;
  const ai=buildAttentionInput({candidacy:null,conceptDetail:b.conceptDetail??[],salary:j.salary_max??j.salary_min??null});const assess=attentionScore(ai).band==="ASSESSABLE";
  // CURRENT (from conceptDetail, no A/B1)
  const curT=cd.length,curD=cd.filter(x=>x.resolution==="DIRECT").length,curM=cd.filter(x=>["DIRECT","TRANSFERABLE"].includes(x.resolution)).length;
  const cur=cd.length?sc(curT,curD,curM,b,s,j,sen,assess):sc(0,0,0,b,s,j,sen,assess);
  // A: re-resolve
  const reA=cd.map(x=>{const rr=relationResolve(x.concept,x.resolution as Resolution,has);
    if(x.resolution!=="DIRECT"&&rr.resolution==="DIRECT"){newDirect.push({t:j.title,c:x.concept,via:rr.via,basis:rr.basis});if(x.resolution==="TRANSFERABLE")t2d.push({t:j.title,c:x.concept});}
    return {concept:x.concept,resolution:rr.resolution,orig:x.resolution};});
  // B1: dedup for voting
  const votes=dedupeForVoting(reA.map(x=>({concept:x.concept,resolution:x.resolution})));
  for(const v of votes) if(v.members.length>1) fams.push({t:j.title,fam:v.key,members:v.members,res:v.resolution});
  // any DIRECT lost? (a concept DIRECT originally not represented by a DIRECT vote)
  for(const x of reA) if(x.orig==="DIRECT"){const vk=familyOf(x.concept)??norm(x.concept);const v=votes.find(z=>z.key===vk);if(!v||v.resolution!=="DIRECT")directLost.push({t:j.title,c:x.concept});}
  const pT=votes.length,pD=votes.filter(v=>v.resolution==="DIRECT").length,pM=votes.filter(v=>["DIRECT","TRANSFERABLE"].includes(v.resolution)).length;
  const proto=votes.length?sc(pT,pD,pM,b,s,j,sen,assess):sc(0,0,0,b,s,j,sen,assess);
  rows.push({id:j.id,title:j.title,co:cn.get(j.company_id)??"?",cur,proto,verdict:cBy.get(j.id)?.verdict});
}
const byC=[...rows].sort((a,b)=>b.cur-a.cur),byP=[...rows].sort((a,b)=>b.proto-a.proto);
const ge10=rows.filter(r=>Math.abs(r.cur-r.proto)>=10), toZero=rows.filter(r=>r.cur>0&&r.proto===0), rise20=rows.filter(r=>r.proto-r.cur>=20);
console.log(`rows=${rows.length}`);
console.log(`\nCHANGE SETS:`);
console.log(`  |Δ|>=10: ${ge10.length}   rise>=20: ${rise20.length}   fell to 0: ${toZero.length}`);
console.log(`  newly-created DIRECT (ontology): ${newDirect.length}   of which TRANSFERABLE->DIRECT: ${t2d.length}`);
console.log(`  requirements folded by family de-dup: ${fams.length} families across jobs`);
console.log(`  existing DIRECT lost/downgraded: ${directLost.length} (must be 0)`);
console.log(`\nnewly-created DIRECT by ontology (concept x count):`);
const nd=new Map<string,number>();for(const x of newDirect)nd.set(x.c,(nd.get(x.c)??0)+1);for(const [c,n] of [...nd.entries()].sort((a,b)=>b[1]-a[1]))console.log(`   ${n}x  ${c}  (e.g. via ${JSON.stringify(newDirect.find(z=>z.c===c)?.via)})`);
console.log(`\nfamily de-dup (family x count of jobs):`);
const fc=new Map<string,number>();for(const x of fams)fc.set(x.fam,(fc.get(x.fam)??0)+1);for(const [f,n] of [...fc.entries()].sort((a,b)=>b[1]-a[1]))console.log(`   ${n}x  ${f}  (e.g. ${JSON.stringify(fams.find(z=>z.fam===f)?.members)})`);
console.log(`\nALL jobs that fell to 0 (cur -> 0):`);for(const r of toZero.sort((a,b)=>b.cur-a.cur))console.log(`   ${r.cur}->0  ${(r.verdict||"").padEnd(8)} ${r.title.slice(0,46)}`);
console.log(`\nrise>=20 (top 15):`);for(const r of rise20.sort((a,b)=>(b.proto-b.cur)-(a.proto-a.cur)).slice(0,15))console.log(`   ${r.cur}->${r.proto}  ${(r.verdict||"").padEnd(8)} ${r.title.slice(0,44)}`);
console.log(`\nNAMED JOBS (cur -> proto):`);for(const T of ["Sales Compensation Manager","Senior Product Manager, Checkout","Specialist, Strategic Growth","Senior Digital Marketing Manager","Engagement Associate"]){const r=rows.find(x=>x.title.includes(T));if(r)console.log(`   ${r.cur}->${r.proto}  rank ${byC.findIndex(x=>x.id===r.id)+1}->${byP.findIndex(x=>x.id===r.id)+1}  ${r.title.slice(0,40)}`);}
const dist=(k:string)=>{const d=[0,0,0,0,0,0];for(const r of rows){const v=r[k];d[v>=90?0:v>=80?1:v>=70?2:v>=60?3:v>=50?4:5]++;}return d;};
console.log(`\ndistribution [90+,80s,70s,60s,50s,<50]  cur ${JSON.stringify(dist("cur"))}  proto ${JSON.stringify(dist("proto"))}`);
console.log(`\nPROPOSED PRODUCTION TOP 30:`);for(let i=0;i<30 && i<byP.length;i++){const r=byP[i]!;console.log(`   #${String(i+1).padStart(2)} ${String(r.proto).padStart(2)} ${(r.verdict||"").slice(0,7).padEnd(7)} ${r.title.slice(0,40)} @ ${r.co.slice(0,16)}`);}
