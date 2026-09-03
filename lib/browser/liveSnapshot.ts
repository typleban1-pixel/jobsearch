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
  /**
   * The DOM name attribute, shared by every option of a radio group.
   *
   * Without it collapseRadioGroups cannot tell that two radios belong to
   * one question, so Northern Trust's previous-worker group arrived as a
   * field called "Yes" and the confirmed answer "No", stored against the
   * group, matched nothing and was never filled.
   */
  name?: string | null;
  /**
   * For a group of checkboxes sharing one name: the selector that
   * reaches each option, keyed by that option's own label.
   *
   * The option values are frequently opaque -- Greenhouse numbers them
   * 733272947 and so on -- so the label is the only part that carries
   * meaning, and the selector is what can actually be clicked.
   */
  optionSelectors?: Record<string, string>;
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
    // A placeholder is not a label: Workday's questionnaire dropdowns
    // carry aria-label="Select One Required" and no label element.
    const placeholder = /^\s*(select one|select|choose one|choose|required|—|-)?\s*(required)?\s*$/i;

    const labelFor = (el: Element): { text: string; direct: boolean } => {
      const id = el.id;
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l?.textContent?.trim()) return { text: l.textContent.trim(), direct: true };
      }
      const aria = el.getAttribute("aria-label");
      if (aria?.trim() && !placeholder.test(aria)) return { text: aria.trim(), direct: true };
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const text = by.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? "").join(" ").trim();
        if (text) return { text, direct: true };
      }
      /**
       * A placeholder is not a label.
       *
       * Workday's questionnaire dropdowns carry aria-label="Select One
       * Required" and no label element, so seven distinct legal
       * questions all arrived called "Select One Required" -- one of
       * them asking about sponsorship and another about government
       * service. The question itself sits in the text block just before
       * the control, which is where a person reads it too.
       */
      const nearestText = (): string => {
        let node: Element | null = el.closest('[data-automation-id^="formField-"]') ?? el;
        while (node) {
          let prev: Element | null = node.previousElementSibling;
          while (prev) {
            const text = (prev as HTMLElement).innerText?.replace(/\s+/g, " ").trim() ?? "";
            // Long enough to be a question, and not another control's
            // rendering of its own value.
            if (text.length > 12 && !placeholder.test(text)) return text.slice(0, 300);
            prev = prev.previousElementSibling;
          }
          node = node.parentElement;
        }
        return "";
      };

      const wrapping = el.closest("label");
      if (wrapping?.textContent?.trim()) return { text: wrapping.textContent.trim(), direct: false };
      const group = el.closest("fieldset");
      const legend = group?.querySelector("legend");
      if (legend?.textContent?.trim()) return { text: legend.textContent.trim(), direct: false };
      // Last resort, and only for controls that would otherwise be
      // nameless or named by a placeholder.
      const near = nearestText();
      if (near) return { text: near, direct: false };
      return { text: "", direct: false };
    };

    const typeOf = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      if (tag === "textarea") return "textarea";
      if (tag === "select") return "select";
      // A button that opens a listbox is a dropdown, whatever its tag.
      // Typed as "select" so everything downstream that already knows
      // how to pick an option from a list keeps working unchanged.
      if (tag !== "input" && (el.getAttribute("aria-haspopup") === "listbox"
        || el.getAttribute("role") === "combobox" || el.getAttribute("role") === "listbox")) return "select";
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
    /**
     * Dropdowns that are not <select> elements.
     *
     * Workday's address block renders Country and State/Province as a
     * button with aria-haspopup="listbox" and a popup that does not
     * exist in the DOM until it is opened. There is no input, no select
     * and no textarea anywhere in the widget, so enumerating native form
     * elements could not see them: on the Northern Trust form the two
     * controls that went missing were exactly the two rendered this way,
     * while every control that WAS captured is a native input or select.
     *
     * A missing control is worse than an unanswerable one. An unanswered
     * question blocks and asks; a control nobody discovered is simply
     * left empty, and the form is called complete with a required field
     * blank.
     *
     * Deliberately conservative: a widget only counts when it announces
     * itself as a listbox or combobox AND carries something to target it
     * by. Anything containing a native control is that control's
     * chrome, not a question of its own.
     */
    /**
     * Page furniture is not part of the application.
     *
     * The header's language and settings menus are listbox buttons, and
     * once controls could be named by nearby text they started arriving
     * as questions called "Please view Northern Trust's cookie policy
     * here." Nothing inside the header, utility bar or legal notice is
     * ever a question on the form.
     */
    const isChrome = (el: Element): boolean => Boolean(el.closest(
      '[data-automation-id="header"], [data-automation-id="utilityButtonBar"], '
      + '[data-automation-id="legalNotice"], [data-automation-id="navigationContainer"], '
      + 'header, nav, footer'));

    const listboxes = Array.from(document.querySelectorAll(
      '[aria-haspopup="listbox"], [role="combobox"]'))
      .filter((el) => visible(el))
      .filter((el) => !isChrome(el))
      .filter((el) => !el.querySelector("input,select,textarea"))
      .filter((el) => !el.closest("select"))
      // The trigger is a control; the popup it opens is not. role=listbox
      // was in this list once and matched the open option list itself:
      // on Greenhouse an opened country dropdown turned every option into
      // a "field", one of which was labelled "Australia" and, having no
      // identity of its own, fell back to a label selector that matched
      // 30 elements. An open menu is a rendering of one question, never
      // thirty new ones.
      .filter((el) => el.getAttribute("role") !== "option"
        && !el.closest('[role="listbox"], [role="option"], [role="menu"]'))
      // Identity has to be targetable. aria-label is not: it yields a
      // label selector, which is the fallback that produced the 30-way
      // ambiguity in the first place.
      .filter((el) => Boolean(
        el.id || el.getAttribute("data-automation-id")
        || el.getAttribute("data-testid") || el.getAttribute("name")));

    const controls = [...Array.from(document.querySelectorAll("input,select,textarea"))
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
        return visible(el) && !isChrome(el);
      }), ...listboxes];

    for (const el of controls) {
      const name = (el as HTMLInputElement).name || "";
      const id = el.id || "";
      // data-automation-id is Workday's stable identity and survives
      // the rerenders that churn generated ids, so it ranks with the
      // other test hooks rather than below them.
      const testid = el.getAttribute("data-testid") ?? el.getAttribute("data-qa")
        ?? el.getAttribute("data-automation-id") ?? "";
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
      } else if (testid) {
        const attr = el.getAttribute("data-testid") ? "data-testid"
          : el.getAttribute("data-qa") ? "data-qa" : "data-automation-id";
        selector = `[${attr}="${CSS.escape(testid)}"]`; selectorKind = "testid";
      }
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

      /**
       * A multi-select is one question, not thirty.
       *
       * Greenhouse renders "which countries do you anticipate working
       * in" as thirty checkboxes all sharing name="question_...[]".
       * Deduplicating by name kept the FIRST of them and took its label,
       * so the question arrived called "Australia" with a selector that
       * matched all thirty controls -- and the fill refused, correctly,
       * to type a value into a guess.
       *
       * The group is the control. Its question comes from the fieldset
       * legend, never from an option, and each option contributes its
       * own label and its own selector.
       */
      const isCheckbox = (el.getAttribute("type") ?? "").toLowerCase() === "checkbox";
      const siblings = isCheckbox && name
        ? Array.from(document.querySelectorAll(
            `input[type="checkbox"][name="${CSS.escape(name)}"]`)).filter((e) => visible(e))
        : [];
      if (siblings.length > 1) {
        const legend = el.closest("fieldset")?.querySelector("legend")?.textContent?.trim();
        const groupLabel = (legend || groupOf(el) || "").replace(/\s+/g, " ").replace(/\*$/, "").trim();
        const optionSelectors: Record<string, string> = {};
        const optionLabels: string[] = [];
        for (const box of siblings) {
          const own = labelFor(box).text.replace(/\s+/g, " ").replace(/\*$/, "").trim();
          if (!own) continue;
          // Prefer the option's own id: the shared name cannot single
          // one out, and the value is opaque but unique.
          const oneSel = box.id ? `#${CSS.escape(box.id)}`
            : `input[type="checkbox"][name="${CSS.escape(name)}"][value="${CSS.escape((box as HTMLInputElement).value)}"]`;
          optionSelectors[own] = oneSel;
          optionLabels.push(own);
        }
        fields.push({
          key, label: groupLabel, type: "checkbox-group", htmlType: "checkbox-group",
          required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
          options: optionLabels, selector, selectorKind,
          unlabelled: groupLabel === "", groupKey: groupOf(el),
          associated: [], optionSelectors,
        });
        continue;
      }

      const options = el.tagName.toLowerCase() === "select"
        ? Array.from((el as HTMLSelectElement).options).map((o) => o.label || o.text).filter(Boolean)
        : [];

      fields.push({
        key, label, type: typeOf(el), name: name || null,
        // A listbox button reports "select" here too. Reporting its tag
        // would tell every downstream reader it is a button, and they
        // would treat a dropdown as something to click once.
        htmlType: typeOf(el) === "select" ? "select"
          : (el.getAttribute("type") ?? el.tagName).toLowerCase(),
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
