import { detectTitleCompany } from "../lib/resume/detectPosting.ts";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};
const show=(l:string,t:string,h?:string)=>{const d=detectTitleCompany(t,h);console.log(`  ${l}: title=${JSON.stringify(d.title)} company=${JSON.stringify(d.company)}`);return d;};

console.log("=== representative pastes ===");
// 1. explicit labels
{const d=show("labels","Job Title: Operations Manager\nCompany: Acme Corp\nWe need someone great.");
 ok(d.title.value==="Operations Manager"&&d.title.confidence==="HIGH","labels: title HIGH");
 ok(d.company.value==="Acme Corp"&&d.company.confidence==="HIGH","labels: company HIGH");}
// 2. About + role line (Greenhouse/Samsara style)
{const d=show("about","About Samsara\nSamsara is building the connected operations cloud.\nAssociate Sales Engineer\nYou will support customers.");
 ok(d.company.value==="Samsara"&&d.company.confidence==="HIGH","about: company Samsara HIGH");
 ok(d.title.value==="Associate Sales Engineer","about: title detected");}
// 3. HTML h1
{const d=show("html","Some preamble text that is long enough to matter here.","<h1>Senior Product Manager</h1><p>...</p>");
 ok(d.title.value==="Senior Product Manager"&&d.title.confidence==="HIGH","html: h1 title HIGH");}
// 4. "Title at Company" first line (Stripe style)
{const d=show("at","Senior Software Engineer at Stripe\nStripe creates economic infrastructure.");
 ok(d.title.value?.startsWith("Senior Software Engineer")===true,"at: title HIGH");
 ok(d.company.value==="Stripe","at: company Stripe");}
// 5. bare title first line
{const d=show("bare","Marketing Manager\nChicago, IL\nFull-time");
 ok(d.title.value==="Marketing Manager"&&d.title.confidence==="HIGH","bare: title HIGH");
 ok(d.company.confidence==="NONE","bare: company NONE (not invented)");}
// 6. messy / section headers only -> nothing invented
{const d=show("messy","Apply now\nOverview\nResponsibilities\nRequirements\nWe are hiring.");
 ok(d.title.confidence==="NONE","messy: title NONE");
 ok(d.company.confidence==="NONE","messy: company NONE");}
// 7. "X is a ..." company
{const d=show("isa","Alpaca is a global brokerage infrastructure platform.\nSenior Fullstack Engineer\nBuild things.");
 ok(d.company.value==="Alpaca"&&d.company.confidence==="HIGH","isa: company Alpaca HIGH");}
// 8. empty
{const d=detectTitleCompany("");ok(d.title.confidence==="NONE"&&d.company.confidence==="NONE","empty: both NONE");}
console.log(`\n${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
