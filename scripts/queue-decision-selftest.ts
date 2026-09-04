/**
 * The bulk-queue per-job decision, pinned. Pure, offline.
 */
import { classifyQueueJob } from "../lib/applications/queueDecision.ts";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};
const J=(o:any={})=>({status:"OPEN",eligibility:"ELIGIBLE",canonical_opening_id:"op1",...o});
const d=(o:any)=>classifyQueueJob({job:J(),verdict:"STRETCH",versionId:"v1",hasLiveApplication:false,...o});

ok(d({}).state==="queue","a valid open eligible candidate with a version queues");
ok(d({job:undefined}).state==="not_found","missing job -> not_found");
ok(d({job:J({status:"CLOSED_OR_REMOVED"})}).state==="not_open","closed posting -> not_open");
ok(d({job:J({eligibility:"INELIGIBLE"})}).state==="not_eligible","ineligible -> not_eligible");
ok(d({verdict:"REJECT"}).state==="not_a_candidate","REJECT -> not_a_candidate");
ok(d({verdict:"MANUAL_REVIEW"}).state==="not_a_candidate","MANUAL_REVIEW -> not_a_candidate");
ok(d({verdict:"APPLICATION_CANDIDATE"}).state==="queue","APPLICATION_CANDIDATE queues");
ok(d({hasLiveApplication:true}).state==="already","an existing live application -> already (never re-queued)");
ok(d({versionId:undefined}).state==="no_version","no current version -> no_version");
// ordering: closed AND ineligible -> not_open wins (checked first)
ok(d({job:J({status:"CLOSED_OR_REMOVED",eligibility:"INELIGIBLE"})}).state==="not_open","not_open is checked before eligibility");
// an already-SUBMITTED opening is 'live' -> already, so never re-queued
ok(d({hasLiveApplication:true,verdict:"APPLICATION_CANDIDATE"}).state==="already","a submitted opening (live) is never re-queued");
console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
