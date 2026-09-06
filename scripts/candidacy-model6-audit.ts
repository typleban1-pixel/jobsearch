#!/usr/bin/env -S node --env-file=.env.local
/**
 * Audit the model-5 -> model-6 zero-adjacency change over the live OPEN
 * eligible population, read-only. Computes both verdicts from the same fit
 * and reports every transition, with the evidence structure behind each.
 *   node --env-file=.env.local scripts/candidacy-model6-audit.ts
 */
import { createClient } from "@supabase/supabase-js";
import { buildFitBreakdown } from "../lib/scoring/fit.ts";
import { assessCandidacy, type RequirementRow } from "../lib/scoring/candidacy.ts";
import { TermMatcher } from "../lib/matching/match.ts";
import { toConcept } from "../lib/matching/concepts.ts";
import { buildEvidenceContext } from "../lib/scoring/evidenceResolution.ts";
import type { CapabilityIndex } from "../lib/scoring/capability.ts";
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const page = async <T,>(t: string, c: string, f: (q:any)=>any = q=>q): Promise<T[]> => { const o:T[]=[]; for(let x=0;;x+=1000){const{data,error}=await f(db.from(t).select(c)).range(x,x+999);if(error)throw new Error(`${t}: ${error.message}`);o.push(...(data as T[]));if(!data||data.length<1000)break;}return o; };
const allSkills = await page<any>("skills","id,name,related_terms,status,level,category");
const aliases = await page<any>("term_aliases","alias,canonical_term");
const matcher = new TermMatcher(allSkills.map(s=>({id:s.id,name:s.name,relatedTerms:s.related_terms??[],status:s.status})), aliases as any);
const verified = new Set(allSkills.filter(s=>s.status==="VERIFIED").map(s=>s.name));
const relations = new Map<string,any>();
for(const r of await page<any>("capability_relations","requirement_concept,satisfied_by_skill,relation,rationale")){ if(!verified.has(r.satisfied_by_skill))continue; relations.set(toConcept(r.requirement_concept).concept,{skill:r.satisfied_by_skill,relation:r.relation,rationale:r.rationale}); }
const index: CapabilityIndex = { relations, matchTerm:(t:string)=>{const m=matcher.match(t);return{status:m.status,skillName:m.skillName,method:m.method,terminal:m.terminal};} };
const { data: credDecl } = await db.from("credential_declarations").select("family,status");
const cred: Record<string,string> = {}; for(const c of credDecl??[]) cred[c.family]=c.status;
const { data: eduRows } = await db.from("education").select("credential,field_of_study,status,completed");
const edu = (eduRows??[]).filter((e:any)=>e.status==="VERIFIED"&&e.completed).map((e:any)=>({level:/master|mba/i.test(e.credential??"")?"MASTER":/associate/i.test(e.credential??"")?"ASSOCIATE":"BACHELOR",field:e.field_of_study??null}));
const metrics = await page<any>("metrics","label,unit,numeric_value,approved_for_use");
const evidenceContext = buildEvidenceContext({skills:allSkills as any, metrics:metrics as any, notHeld:[]});
const jobs = (await page<any>("jobs","id,title,company_id,status,eligibility")).filter(j=>j.status==="OPEN"&&j.eligibility==="ELIGIBLE");
const conames = new Map((await page<any>("companies","id,name")).map(c=>[c.id,c.name]));
const reqs = await page<any>("job_requirements","id,job_id,normalized_term,raw_text,is_hard_requirement,minimum_years,kind,alternative_group,conjunct_key");
const byJob = new Map<string,any[]>(); for(const r of reqs){byJob.set(r.job_id,[...(byJob.get(r.job_id)??[]),r]);}

let m5c:Record<string,number>={}, m6c:Record<string,number>={}; const transitions:any[]=[];
for(const j of jobs){ const rs=byJob.get(j.id)??[]; if(!rs.length)continue;
  const fit = buildFitBreakdown(rs, j.title, index, cred, edu as any, null, 0, evidenceContext);
  const c5 = assessCandidacy({jobTitle:j.title, fit, requirements:rs as RequirementRow[], credentialDeclarations:cred, modelVersion:5});
  const c6 = assessCandidacy({jobTitle:j.title, fit, requirements:rs as RequirementRow[], credentialDeclarations:cred, modelVersion:6});
  m5c[c5.verdict]=(m5c[c5.verdict]||0)+1; m6c[c6.verdict]=(m6c[c6.verdict]||0)+1;
  if(c5.verdict!==c6.verdict) transitions.push({co:conames.get(j.company_id)||"?",title:j.title,from:c5.verdict,to:c6.verdict,reason6:c6.reasonCodes[0],hardMet:c6.hardMet,hardTotal:c6.hardTotal,direct:c6.directMatches,transfer:c6.transferableMatches});
}
console.log("model 5 verdicts:", JSON.stringify(m5c));
console.log("model 6 verdicts:", JSON.stringify(m6c));
console.log("\ntransitions (", transitions.length, "):");
const t5s = transitions.filter(t=>t.from==="STRETCH");
console.log("STRETCH -> REJECT:", t5s.filter(t=>t.to==="REJECT").length, "| STRETCH -> MANUAL_REVIEW:", t5s.filter(t=>t.to==="MANUAL_REVIEW").length, "| STRETCH -> other:", t5s.filter(t=>!["REJECT","MANUAL_REVIEW"].includes(t.to)).length);
console.log("non-STRETCH transitions:", transitions.filter(t=>t.from!=="STRETCH").length);
console.log("\nall STRETCH->REJECT (zero-adjacency reclassifications):");
for(const t of t5s.filter(t=>t.to==="REJECT")) console.log(`  ${t.hardMet}/${t.hardTotal} d${t.direct} tr${t.transfer} | ${(t.co||"").slice(0,18).padEnd(19)} ${t.title.slice(0,46)}`);
