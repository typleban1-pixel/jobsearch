/**
 * Every Ashby field container on an application form, with what it holds.
 *
 *   node --env-file=.env.local scripts/ashby-dom-probe.ts <apply-url>
 *
 * Read-only diagnostic: for each _fieldEntry_ container prints its label
 * text (as rendered, asterisk included), then every control inside it --
 * tag, type, id, name, role, aria-required, and the option label -- so a
 * grouping rule can be written against the real structure rather than a
 * guess. Nothing is typed, uploaded or clicked except "Apply for this job".
 */
import { launchBrowser, newPreparedPage } from "../lib/browser/launch.ts";
import { revealAshbyForm } from "../lib/browser/ashbyForm.ts";

const url = process.argv[2];
if (!url) { console.error("usage: ashby-dom-probe.ts <apply-url>"); process.exit(2); }
const browser = await launchBrowser();
try {
  const page = await newPreparedPage(browser, { viewport: { width: 1440, height: 1000 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2500);
  await revealAshbyForm(page);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);
  const dump = await page.evaluate(() => {
    const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
    const out: string[] = [];
    const entries = Array.from(document.querySelectorAll("[class*=_fieldEntry_]"));
    for (const e of entries) {
      const cls = (e.getAttribute("class") || "").split(/\s+/).filter((c) => /_fieldEntry_|_container_|_field_/.test(c)).join(" ");
      const labelNode = e.querySelector("[class*=_label_], [class*=_heading_], label, legend");
      const labelCls = labelNode ? (labelNode.getAttribute("class") || "").slice(0, 60) : "";
      const desc = e.querySelector("[class*=_description_]");
      out.push(`ENTRY ${cls}`);
      out.push(`  label: ${JSON.stringify(norm(labelNode?.textContent))}  <${labelNode?.tagName.toLowerCase() ?? "-"} class="${labelCls}">`);
      if (desc) out.push(`  desc:  ${JSON.stringify(norm(desc.textContent)).slice(0, 120)}`);
      const fs = e.querySelectorAll("fieldset");
      if (fs.length) out.push(`  fieldsets: ${fs.length}  legend=${JSON.stringify(norm(fs[0]!.querySelector("legend")?.textContent))}  aria-label=${JSON.stringify(fs[0]!.getAttribute("aria-label"))}`);
      for (const c of Array.from(e.querySelectorAll("input,select,textarea,button[aria-pressed],[role=combobox]"))) {
        const el = c as HTMLInputElement;
        const t = el.tagName.toLowerCase();
        const id = el.id || "";
        const lab = id ? norm(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) : norm(el.closest("label")?.textContent);
        out.push(`    ${t}${el.getAttribute("type") ? `[type=${el.getAttribute("type")}]` : ""}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} id=${JSON.stringify(id.slice(0, 50))} name=${JSON.stringify((el.getAttribute("name") || "").slice(0, 50))} req=${el.hasAttribute("required") || el.getAttribute("aria-required")} label=${JSON.stringify(lab || norm((c as HTMLElement).innerText)).slice(0, 60)}`);
      }
    }
    return out.join("\n");
  });
  console.log(dump);
} finally {
  await browser.close();
}
