/**
 * The Resume Builder Match Score is NOT a separate formula: for a set of
 * requirements, scoreRequirements() (fresh compute) reproduces the exact
 * matchScore() /jobs shows from the stored candidacy + fit. Needs env.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { scoreRequirements } from "../lib/portal/scoreRequirements.ts";
import { matchScore } from "../lib/portal/matchScore.ts";
import { buildAttentionInput, attentionScore } from "../lib/portal/attentionRank.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let n=0,bad=0; const ok=(c:boolean,w:string,x="")=>{n++;if(!c){bad++;console.error(`FAIL ${w}${x?" — "+x:""}`);}};
const { data: prof } = await db.from("profile").select("profile_version").single();
const { data: cands } = await db.from("job_candidacy").select("job_id,hard_met,hard_total,core_gaps,gating_gaps,unresolved_core,transferable_matches").eq("profile_version", prof!.profile_version).limit(60);
let tested=0;
for (const c of cands ?? []) {
  if (tested>=3) break;
  const { data: s } = await db.from("job_scores").select("id,uncertainty_score,scorable,fit_breakdown").eq("job_id", c.job_id).eq("is_current", true).maybeSingle();
  if (!s) continue;
  const { data: j } = await db.from("jobs").select("title,salary_min,salary_max,eligibility,status").eq("id", c.job_id).single();
  if (j!.status!=="OPEN") continue;
  const reqs:any[]=[]; { let f=0; for(;;){const{data}=await db.from("job_requirements").select("raw_text,normalized_term,is_hard_requirement,kind,minimum_years").eq("job_id",c.job_id).range(f,f+999);if(!data?.length)break;reqs.push(...data);if(data.length<1000)break;f+=1000;} }
  if (reqs.length<2) continue;
  const { data: sr } = await db.from("score_reasons").select("kind").eq("score_id", s.id).in("kind",["SENIORITY_MATCH","SENIORITY_MISMATCH"]);
  const sen = sr?.some(r=>r.kind==="SENIORITY_MATCH") ? true : sr?.some(r=>r.kind==="SENIORITY_MISMATCH") ? false : null;
  const salary = j!.salary_max ?? j!.salary_min ?? null; const b = s.fit_breakdown ?? {};
  const ai = buildAttentionInput({candidacy:{hardMet:c.hard_met,hardTotal:c.hard_total,transferableMatches:c.transferable_matches??0,coreGaps:(c.core_gaps??[]).length},conceptDetail:b.conceptDetail??[],salary});
  const jobsMatch = matchScore({hardMet:c.hard_met,hardTotal:c.hard_total,hardDirect:ai.hardDirect,coverage:typeof b.coverage==="number"?b.coverage:null,coreGaps:(c.core_gaps??[]).length,gatingGaps:(c.gating_gaps??[]).length,educationGatesUnmet:b.educationGatesUnmet??0,unresolvedCore:(c.unresolved_core??[]).length,excludedUnknown:b.excludedUnknown??0,seniorityAligned:sen,salary,eligibility:j!.eligibility,uncertaintyScore:s.uncertainty_score===null?null:Number(s.uncertainty_score),scorable:s.scorable!==false,assessable:attentionScore(ai).band==="ASSESSABLE"});
  const rb = await scoreRequirements(db,{requirements:reqs,title:j!.title,salary,eligibility:j!.eligibility,seniorityAligned:sen});
  tested++;
  ok(rb.why.hardMet===c.hard_met && rb.why.hardTotal===c.hard_total, `job ${String(c.job_id).slice(0,8)}: fresh candidacy == stored`);
  ok(Math.abs(rb.match.score - jobsMatch.score) <= 1, `job ${String(c.job_id).slice(0,8)}: RB score == /jobs score (${rb.match.score} vs ${jobsMatch.score})`);
}
ok(tested>0, `tested ${tested} current jobs`);
console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
