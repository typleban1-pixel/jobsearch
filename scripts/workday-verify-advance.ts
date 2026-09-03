/**
 * Verify everything visible and required, then advance. Never submits.
 */
import { chromium } from "playwright";
import { chooseAdvance } from "../lib/workday/advance.ts";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = b.contexts()[0]!.pages().filter((p: any) => !p.url().startsWith("about:"))[0]!;
page.setDefaultTimeout(30_000);

const state = async () => await page.evaluate(() => {
  const vis = (e: Element) => e.getClientRects().length > 0;
  const marker = [...document.querySelectorAll("*")].map((e) => (e as HTMLElement).innerText ?? "")
    .find((x) => /current step \d+ of \d+/i.test(x) && x.length < 120) ?? "";
  const required = [...document.querySelectorAll('input,textarea,select,button[aria-haspopup="listbox"]')]
    .filter(vis).map((e) => {
      const el = e as HTMLInputElement;
      const wrap = el.closest('[data-automation-id^="formField-"]');
      const lbl = (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : "")
        || el.getAttribute("aria-label") || wrap?.getAttribute("data-automation-id") || "";
      const isReq = el.getAttribute("aria-required") === "true" || el.hasAttribute("required")
        || Boolean(wrap?.querySelector("abbr"));
      /**
       * A multiselect keeps its value in a selected-item chip, not in
       * the input. Reading el.value called two committed fields empty
       * and refused to advance a page that was complete.
       */
      const container = el.closest('[data-automation-id="multiSelectContainer"]');
      const chips = container
        ? [...container.querySelectorAll('[data-automation-id="selectedItem"]')]
            .map((c) => (c as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean)
        : [];
      const value = chips.length ? chips.join(", ")
        : el.tagName === "BUTTON" ? (el as any).innerText?.trim() : String(el.value ?? "");
      return { lbl: String(lbl).replace(/\s+/g, " ").replace(/\*$/, "").trim().slice(0, 40), value: String(value).slice(0, 40), isReq };
    }).filter((x) => x.lbl);
  return {
    step: marker.replace(/\s+/g, " ").slice(0, 60),
    errors: [...document.querySelectorAll('[role="alert"],[data-automation-id*="rror"]')].filter(vis)
      .map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim())
      .filter((t) => /error|required|invalid/i.test(t)).slice(0, 8),
    emptyRequired: required.filter((r) => r.isReq && (!r.value || /^select one$/i.test(r.value))).map((r) => r.lbl),
    requiredCount: required.filter((r) => r.isReq).length,
    buttons: [...document.querySelectorAll('button,[role="button"]')].filter(vis)
      .map((e) => ((e as HTMLElement).innerText || "").trim()).filter(Boolean),
  };
});

const s = await state();
console.log(`step: ${s.step}`);
console.log(`required controls: ${s.requiredCount}`);
console.log(`empty required: ${s.emptyRequired.length ? s.emptyRequired.join(" | ") : "none"}`);
console.log(`errors: ${s.errors.length ? s.errors.join(" || ") : "none"}`);

if (s.emptyRequired.length || s.errors.length) {
  console.log("\nNOT advancing: the page is not complete.");
  await b.close(); process.exit(1);
}
const choice = chooseAdvance(s.buttons);
if (!choice.click) { console.log(`\nnot advancing: ${choice.why}`); await b.close(); process.exit(1); }
console.log(`\nclicking ${JSON.stringify(choice.label)}`);
await page.getByRole("button", { name: choice.label, exact: true }).first().click({ timeout: 20_000 }).catch(() => undefined);
for (let i = 0; i < 25; i++) {
  await page.waitForTimeout(800);
  const now = await state();
  if (now.step !== s.step) { console.log(`advanced to: ${now.step}`); await b.close(); process.exit(0); }
}
const after = await state();
console.log(`still on: ${after.step}`);
console.log(`errors now: ${after.errors.join(" || ") || "none"}`);
console.log(`empty required now: ${after.emptyRequired.join(" | ") || "none"}`);
await b.close(); process.exit(1);
