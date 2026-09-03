import { chromium } from "playwright";
const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = b.contexts()[0]!.pages()[0]!;
// read the candidate-home error
await page.goto("https://ntrs.wd1.myworkdayjobs.com/northerntrust/candidatehome", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.getByRole("button", { name: /view all/i }).first().click({ timeout: 8000 }).catch(()=>{});
await page.waitForTimeout(2500);
console.log("ERROR DETAIL:", JSON.stringify(await page.evaluate(() =>
  [...document.querySelectorAll('[role="alert"], [data-automation-id*="rror"], [data-automation-id="errorMessage"]')]
    .filter(e=>e.getClientRects().length>0).map(e=>(e as HTMLElement).innerText.trim()).filter(Boolean).slice(0,6))));
// now the posting itself
await page.goto("https://ntrs.wd1.myworkdayjobs.com/northerntrust/job/Chicago-IL/Program-Manager_R159624", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
console.log("\nPOSTING:", JSON.stringify(await page.evaluate(() => {
  const vis=(e:Element)=>e.getClientRects().length>0; const t=(e:Element)=>(e as HTMLElement).innerText.trim();
  return { url: location.href, title: document.title,
    buttons: [...document.querySelectorAll('button,a[role="button"],[role="button"]')].filter(vis).map(t).filter(Boolean).slice(0,14),
    body: (document.body.innerText||"").replace(/\s+/g," ").slice(0,500) };
}), null, 1).slice(0,1400));
