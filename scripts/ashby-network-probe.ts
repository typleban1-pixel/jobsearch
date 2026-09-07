/**
 * What an Ashby application form actually does on the wire.
 *
 *   node --env-file=.env.local scripts/ashby-network-probe.ts <apply-url> [--location "Cleveland"]
 *
 * A diagnostic, not part of any application flow. It opens the apply page
 * in the automation profile WITHOUT the submit guard, reveals the form,
 * writes one harmless value into the Name field two ways (the framework
 * commit the fill path uses, then real keystrokes), and prints every
 * GraphQL operation the page sends, with the field state Ashby's own
 * validator reads (fieldEntry.fieldValue.value) after each step. It also
 * lists every "Api*" operation name found in the page's scripts, so the
 * submit mutation's name is known before anything is ever allowed or
 * blocked by name.
 *
 * Nothing is submitted: the submit control is never located, never
 * clicked, and the page is closed at the end. Typing a name into an
 * unsubmitted form leaves at most an autosaved draft on Ashby's side,
 * which is exactly what a person abandoning the page halfway leaves.
 */
import { launchApplicationContext } from "../lib/browser/launch.ts";
import { revealAshbyForm, waitForAshbyHydration } from "../lib/browser/ashbyForm.ts";
import { fillTextCommitting, readAshbyCommitted } from "../lib/browser/actions.ts";

const url = process.argv[2];
if (!url) { console.error("usage: ashby-network-probe.ts <apply-url> [--location City]"); process.exit(2); }
const locArg = process.argv.indexOf("--location");
const locationTerm = locArg >= 0 ? process.argv[locArg + 1] ?? null : null;

const context = await launchApplicationContext();
const page = await context.newPage();
const ops: Array<{ t: number; method: string; op: string; status?: number; body?: string; resp?: string }> = [];
const t0 = Date.now();
page.on("request", (r) => {
  if (!/non-user-graphql/.test(r.url())) return;
  const op = new URL(r.url()).searchParams.get("op") ?? "?";
  ops.push({ t: Date.now() - t0, method: r.method(), op, body: (r.postData() ?? "").slice(0, 400) });
});
page.on("response", async (r) => {
  if (!/non-user-graphql/.test(r.url())) return;
  const op = new URL(r.url()).searchParams.get("op") ?? "?";
  const rec = [...ops].reverse().find((o) => o.op === op && o.status === undefined);
  if (rec) { rec.status = r.status(); rec.resp = (await r.text().catch(() => "")).slice(0, 300); }
});

const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const dumpOps = (since: number) => {
  for (const o of ops.filter((o) => o.t >= since)) {
    console.log(`    ${String(o.t).padStart(6)}ms ${o.method} ${o.op} -> ${o.status ?? "…"}`);
    if (o.body) console.log(`           body: ${o.body.replace(/\s+/g, " ").slice(0, 300)}`);
    if (o.resp) console.log(`           resp: ${o.resp.replace(/\s+/g, " ").slice(0, 200)}`);
  }
};

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
log(`loaded; navigator.webdriver = ${await page.evaluate(() => (navigator as any).webdriver)}`);
await revealAshbyForm(page);
log(`form revealed; hydrated = ${await waitForAshbyHydration(page)}`);
let mark = Date.now() - t0;
log("operations during load:"); dumpOps(0);

// Every Api* operation name the page's scripts know about.
const scripts: string[] = await page.evaluate(() => Array.from(document.scripts).map((s) => s.src).filter(Boolean));
const names = new Set<string>();
for (const src of scripts) {
  const text = await fetch(src).then((r) => r.text()).catch(() => "");
  for (const m of text.matchAll(/\b(Api[A-Z][A-Za-z]+)\b/g)) names.add(m[1]!);
}
log(`Api* operation names in ${scripts.length} script(s): ${[...names].sort().join(", ")}`);

const nameInput = page.locator("#_systemfield_name, input[name=_systemfield_name]").first();
if (await nameInput.count()) {
  const container = nameInput.locator("xpath=ancestor::*[contains(@class,'_fieldEntry_')][1]");
  mark = Date.now() - t0;
  await fillTextCommitting(nameInput, "Tyler Pleban");
  await page.waitForTimeout(2500);
  log(`after framework commit: store=${JSON.stringify(await readAshbyCommitted(container).catch((e) => `ERR ${e.message}`))} dom=${JSON.stringify(await nameInput.inputValue())}`);
  dumpOps(mark);

  mark = Date.now() - t0;
  await nameInput.click();
  await nameInput.press("Meta+a").catch(() => undefined);
  await nameInput.pressSequentially("Tyler Pleban", { delay: 25 });
  await page.keyboard.press("Tab");
  await page.waitForTimeout(2500);
  log(`after real keystrokes: store=${JSON.stringify(await readAshbyCommitted(container).catch((e) => `ERR ${e.message}`))} dom=${JSON.stringify(await nameInput.inputValue())}`);
  dumpOps(mark);
} else {
  log("no _systemfield_name control on this form");
}

if (locationTerm) {
  const combos = page.locator("[role=combobox]");
  log(`${await combos.count()} combobox(es) on the page`);
  const loc = page.locator('[class*="_fieldEntry_"]').filter({ hasText: /location|city|reside/i }).locator("[role=combobox]").first();
  if (await loc.count()) {
    const container = loc.locator("xpath=ancestor::*[contains(@class,'_fieldEntry_')][1]");
    mark = Date.now() - t0;
    await loc.click();
    await loc.type(locationTerm, { delay: 40 });
    await page.waitForTimeout(2000);
    const offered = await page.evaluate(() => Array.from(document.querySelectorAll("[role=listbox] [role=option]")).map((o) => (o.textContent || "").trim()));
    log(`location options: ${offered.join(" | ")}`);
    await loc.press("ArrowDown");
    await page.waitForTimeout(200);
    const active = await loc.evaluate((el: any) => { const id = el.getAttribute("aria-activedescendant"); return id ? document.getElementById(id)?.textContent : null; });
    log(`highlighted: ${active}`);
    await loc.press("Enter");
    await page.waitForTimeout(1500);
    log(`after Enter: store=${JSON.stringify(await readAshbyCommitted(container).catch((e) => `ERR ${e.message}`))} text=${JSON.stringify((await container.innerText()).replace(/\s+/g, " ").slice(0, 120))}`);
    dumpOps(mark);
  } else {
    log("no location combobox found");
  }
}

log("submit-capable controls on the page (not clicked):");
for (const b of await page.locator("form button, button[type=submit]").evaluateAll((els) => els.map((e) => `${e.tagName}[type=${e.getAttribute("type")}] "${(e.textContent || "").trim().slice(0, 40)}"`))) console.log(`    ${b}`);

await context.close();
