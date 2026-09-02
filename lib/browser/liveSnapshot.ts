/**
 * The employer's form as the DOM actually presents it.
 *
 * Greenhouse publishes its form through the board API, and that stays
 * authoritative for what a field MEANS. This is authoritative for how to
 * reach it. The two are joined on field name, and a required field
 * present in one but not the other is a stop rather than a merge.
 *
 * Also the mechanism Lever and Ashby will need, since neither publishes
 * a form. Written once, here, rather than twice later.
 */
import type { Frame } from "playwright";
import type { FormField } from "../applications/answer.ts";

export const LIVE_SNAPSHOT_VERSION = 1;

export interface LiveField extends FormField {
  /** How to reach this control, strongest strategy first. */
  selector: string;
  selectorKind: "name" | "id" | "label" | "testid";
  /** Present in the DOM but with no resolvable label. */
  unlabelled: boolean;
  /**
   * The nearest grouping container: a fieldset id, its legend, or a
   * role="group" label. Controls sharing one are asked together, which
   * is the structural signal that they may depend on each other.
   */
  groupKey: string | null;
  /** The raw HTML type, kept because "tel" and "text" behave differently. */
  htmlType: string;
  /** Ids this control declares a relationship to. */
  associated: string[];
}

export interface LiveSnapshot {
  fields: LiveField[];
  /** Controls excluded as widget internals rather than questions. */
  widgetHelpers: Array<{ label: string; why: string }>;
  loginWall: boolean;
  captcha: boolean;
  /** An invisible scoring badge. Recorded so its presence is visible, never a stop. */
  captchaBadgeOnly: boolean;
  ssoPrompt: boolean;
  formCount: number;
}

/**
 * Everything is read in one page evaluation.
 *
 * A field-by-field round trip would let the page change underneath the
 * walk, which is how a snapshot ends up describing two different forms.
 */
export async function snapshotLive(frame: Frame): Promise<LiveSnapshot> {
  return frame.evaluate(() => {
    const visible = (el: Element): boolean => {
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    };

    // How a label was obtained matters as much as what it says. A label
    // bound to THIS control names it; one inherited from a surrounding
    // fieldset names the group, and every control in that group will
    // report it.
    const labelFor = (el: Element): { text: string; direct: boolean } => {
      const id = el.id;
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l?.textContent?.trim()) return { text: l.textContent.trim(), direct: true };
      }
      const aria = el.getAttribute("aria-label");
      if (aria?.trim()) return { text: aria.trim(), direct: true };
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const text = by.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? "").join(" ").trim();
        if (text) return { text, direct: true };
      }
      const wrapping = el.closest("label");
      if (wrapping?.textContent?.trim()) return { text: wrapping.textContent.trim(), direct: false };
      const group = el.closest("fieldset");
      const legend = group?.querySelector("legend");
      if (legend?.textContent?.trim()) return { text: legend.textContent.trim(), direct: false };
      return { text: "", direct: false };
    };

    const typeOf = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      if (tag === "textarea") return "textarea";
      if (tag === "select") return "select";
      const t = (el.getAttribute("type") ?? "text").toLowerCase();
      if (t === "file") return "file";
      if (t === "checkbox" || t === "radio") return "boolean";
      if (t === "number") return "number";
      if (t === "date") return "date";
      return "text";
    };

    const groupOf = (el: Element): string | null => {
      const fs = el.closest("fieldset");
      if (fs) return fs.id || fs.querySelector("legend")?.textContent?.trim()?.slice(0, 60) || "fieldset";
      const grp = el.closest("[role='group'], [role='radiogroup']");
      if (grp) return grp.getAttribute("aria-label") || grp.id || "group";
      return null;
    };

    const fields: any[] = [];
    const helpers: Array<{ label: string; why: string }> = [];
    const seen = new Set<string>();
    const controls = Array.from(document.querySelectorAll("input,select,textarea"))
      .filter((el) => {
        const t = (el.getAttribute("type") ?? "").toLowerCase();
        if (t === "hidden") return false;
        // File inputs are exempt from the visibility test. Every custom
        // uploader hides the real input behind styled buttons: Greenhouse
        // shows "Attach / Dropbox / Google Drive" and keeps the actual
        // input[type=file] out of view. Filtering it out meant the resume
        // was never attached and the parser never ran, which silently
        // skipped the upload step entirely.
        if (t === "file") return true;
        return visible(el);
      });

    for (const el of controls) {
      const name = (el as HTMLInputElement).name || "";
      const id = el.id || "";
      const testid = el.getAttribute("data-testid") ?? el.getAttribute("data-qa") ?? "";
      const named = labelFor(el);
      const label = named.text.replace(/\s+/g, " ").replace(/\*$/, "").trim();

      let selector = "", selectorKind = "";
      if (name) { selector = `[name="${CSS.escape(name)}"]`; selectorKind = "name"; }
      // React's useId emits ":r0:", ":r1a:"; MUI and Radix use their own
      // prefixes. The first version of this test was /^r[0-9a-z]*$/,
      // which rejects any lowercase word beginning with r: "resume",
      // "region", "role", "referral". Greenhouse's resume input has
      // id="resume", so the strongest selector available was discarded
      // and the field fell back to its label, which is "Attach" on both
      // the resume and cover-letter controls and therefore ambiguous.
      else if (id && !/^:.+:$|^«.+»$|^(?:mui|radix|headlessui|reach|chakra)-/.test(id)) {
        selector = `#${CSS.escape(id)}`; selectorKind = "id";
      } else if (testid) { selector = `[data-testid="${CSS.escape(testid)}"]`; selectorKind = "testid"; }
      else if (label) { selector = label; selectorKind = "label"; }
      else { selector = ""; selectorKind = "label"; }

      /**
       * A widget part is not an application question.
       *
       * react-select renders a hidden validation proxy inside its
       * container: no name, no id, no type, and no label of its own. On
       * Greenhouse's embed that proxy sits in the fieldset legended
       * "Phone", inherits that legend, and appeared as a SECOND phone
       * question alongside the real tel input.
       *
       * The test is identity, not text. A control with no name, no id
       * and no test id cannot be submitted and cannot be targeted
       * reliably; when its label is merely inherited from a container
       * that already holds a properly identified control, it is an
       * implementation detail of that control. Two genuinely distinct
       * questions both keep their own identity and are unaffected.
       */
      const hasOwnIdentity = Boolean(name || id || testid);
      if (!hasOwnIdentity && !named.direct) {
        // The container the label was INHERITED from is the one that
        // matters: if it already holds a control with its own identity,
        // this one is a part of that control's widget rather than a
        // separate question. A narrower container can hold the proxy
        // alone and prove nothing.
        const container = el.closest("fieldset") ?? el.closest("label");
        const siblingIsIdentified = container
          ? Array.from(container.querySelectorAll("input,select,textarea")).some((o) => {
              if (o === el) return false;
              const oid = (o as HTMLInputElement).name || o.id
                || o.getAttribute("data-testid") || o.getAttribute("data-qa");
              return Boolean(oid);
            })
          : false;
        if (siblingIsIdentified) {
          helpers.push({
            label, why: "no name, id or test id, and its label is inherited from a container that already holds an identified control",
          });
          continue;
        }
      }

      const key = name || id || testid || label;
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const options = el.tagName.toLowerCase() === "select"
        ? Array.from((el as HTMLSelectElement).options).map((o) => o.label || o.text).filter(Boolean)
        : [];

      fields.push({
        key, label, type: typeOf(el),
        htmlType: (el.getAttribute("type") ?? el.tagName).toLowerCase(),
        required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
        options, selector, selectorKind, unlabelled: label === "",
        groupKey: groupOf(el),
        associated: [
          ...(el.getAttribute("aria-controls") ?? "").split(/\s+/),
          ...(el.getAttribute("aria-describedby") ?? "").split(/\s+/),
          ...(el.getAttribute("aria-owns") ?? "").split(/\s+/),
        ].filter(Boolean),
      });
    }

    const bodyText = document.body?.innerText ?? "";
    return {
      fields,
      widgetHelpers: helpers,
      loginWall: /sign in|log in|password/i.test(bodyText) && document.querySelector("input[type=password]") !== null,
      // An INTERACTIVE challenge, not a score-based badge.
      //
      // Greenhouse embeds invisible reCAPTCHA v3 on essentially every
      // application form: a badge in the corner, no challenge, nothing
      // for a person to solve. Treating that as a CAPTCHA stopped the
      // Greenhouse path before it filled a single field. A challenge is
      // something visible that a human is being asked to complete, and
      // that is still an unconditional stop.
      captcha: (() => {
        const challengeish = Array.from(document.querySelectorAll(
          "iframe[title*='challenge' i], iframe[src*='bframe'], .g-recaptcha > div > iframe, " +
          ".h-captcha iframe, [id*='challenge-stage' i], iframe[src*='turnstile']"));
        return challengeish.some((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const st = window.getComputedStyle(el);
          return r.width > 40 && r.height > 40 && st.visibility !== "hidden" && st.display !== "none";
        });
      })(),
      /** Present, watching, and not asking anything. Reported, never a stop. */
      captchaBadgeOnly: document.querySelector(".grecaptcha-badge, iframe[src*='recaptcha/api2/anchor'], iframe[src*='recaptcha/enterprise/anchor']") !== null,
      ssoPrompt: /continue with (?:google|okta|microsoft|sso)|single sign[- ]on/i.test(bodyText),
      formCount: document.querySelectorAll("form").length,
    };
  });
}
