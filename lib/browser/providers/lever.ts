/**
 * Reading a Lever application form as it actually stands, in a browser.
 *
 * Greenhouse publishes its form, so a snapshot is an API call. Lever does
 * not: the form exists only as HTML at the apply URL, which is why
 * preparation for Lever opens a page. Everything here is a reader; it
 * fills nothing and clicks nothing except the deterministic setup needed
 * to make the real questions appear.
 *
 * Three namespaces, and conflating them is the central hazard:
 *
 *   plain      name, email, phone, location, org, urls[...], comments
 *   cards      cards[<uuid>][field0], [field1], ...
 *   surveys    surveysResponses[<uuid>][...], scoped to a chosen location
 *
 * A card is NOT a question. Palantir's card 1c719ca9 holds field0 ("are
 * you authorized to work") and field1 ("will you require sponsorship")
 * under a single card heading, so mapping at card level answers the
 * sponsorship question with the work-authorization answer. That is a
 * wrong legal answer, not a cosmetic bug, and it is why every field is
 * resolved independently and carries its own label.
 */
import type { Frame, Page } from "playwright";

export type LeverFieldKind =
  | "text" | "textarea" | "select" | "file"
  | "checkbox_group"     // several inputs sharing one name: pick any
  | "radio_group"        // several inputs sharing one name: pick exactly one
  | "location"           // typed filter committing to a hidden input
  | "signature";         // an attestation only a person may make

export interface LeverField {
  /** The form control name, which is the durable identity. */
  key: string;
  /** This field's own label, never the card heading it happens to sit under. */
  label: string;
  kind: LeverFieldKind;
  required: boolean;
  options: string[];
  /** Which namespace it came from, so surveys stay distinguishable. */
  namespace: "core" | "card" | "survey" | "eeo";
  /** For card and survey fields, the block it belongs to. */
  blockId: string | null;
  /** Heading of the block, kept for display and never used for matching. */
  blockLabel: string | null;
  /** Set when the control commits elsewhere, as location does. */
  commitsTo: string | null;
}

export interface LeverSnapshot {
  url: string;
  fields: LeverField[];
  /** Offices offered by a multi-location posting, if any. */
  locationChoices: Array<{ value: string; label: string }>;
  /** True when a challenge frame is actually displayed, not merely loaded. */
  captchaChallengeVisible: boolean;
  captchaPresent: boolean;
  /** Controls that must never be filled automatically. */
  signatureKeys: string[];
}

/** Attestations a person signs. Never answered from stored data. */
const SIGNATURE = /signature|initial|attest|i certify|i acknowledge/i;

/**
 * Lever marks required fields with a heavy asterisk in the label as well
 * as the `required` attribute, and the two do not always agree: a
 * checkbox group carries `required` on every member while meaning "pick
 * at least one".
 */
export async function snapshotLeverForm(page: Page | Frame): Promise<LeverSnapshot> {
  return page.evaluate(({ signatureSource }) => {
    const SIG = new RegExp(signatureSource, "i");
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

    const form = document.querySelector("form") ?? document.body;

    /**
     * The label belonging to THIS control.
     *
     * Walks outward to the nearest labelled wrapper rather than taking
     * the enclosing card, because one card can hold several questions and
     * the card heading is the same for all of them.
     */
    /**
     * The label belonging to THIS control.
     *
     * For a group, the nearby labels are the OPTIONS. Reading the last
     * one made both of Palantir's work-authorization radios come back
     * labelled "Yes", which is the exact failure this file exists to
     * prevent: two different legal questions, indistinguishable.
     *
     * So a group is labelled from the container that holds the whole
     * group, with the option text removed; a single control is labelled
     * from its own label element; and the card heading is only used when
     * the card holds one question.
     */
    const labelFor = (el: Element, groupSize = 1): { own: string; block: string } => {
      const card = el.closest("li.application-question, .application-question");
      const block = clean(card?.querySelector(".application-label, .text")?.textContent);

      const id = el.getAttribute("id");
      if (groupSize === 1 && id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        const own = clean(l?.textContent);
        if (own) return { own, block };
      }

      if (groupSize > 1) {
        // The container holding this group and nothing else. Its text
        // minus the option labels is the question.
        const name = el.getAttribute("name") ?? "";
        let node: Element | null = el.parentElement;
        while (node && node !== card) {
          const inside = node.querySelectorAll(`[name="${CSS.escape(name)}"]`).length;
          const others = [...node.querySelectorAll("input,select,textarea")]
            .filter((o) => o.getAttribute("name") !== name).length;
          if (inside === groupSize && others === 0) break;
          node = node.parentElement;
        }
        const scope = node ?? card;
        if (scope) {
          const optionText = new Set([...scope.querySelectorAll("label")]
            .filter((l) => {
              const f = l.getAttribute("for");
              return !f || scope.querySelector(`#${CSS.escape(f)}[name="${CSS.escape(name)}"]`) !== null
                || (l.querySelector("input") !== null);
            })
            .map((l) => clean(l.textContent)));
          // Prefer an explicit question label: one that is not an option.
          const question = [...scope.querySelectorAll("label, .application-label, .text")]
            .map((n) => clean(n.textContent))
            .find((t) => t.length > 3 && !optionText.has(t) && !/^(yes|no)$/i.test(t));
          if (question) return { own: question, block };
        }
        // A card holding exactly one question is named by its heading.
        const siblings = card
          ? new Set([...card.querySelectorAll("input,select,textarea")]
              .map((c) => c.getAttribute("name")).filter(Boolean)).size
          : 1;
        if (siblings <= 1 && block) return { own: block, block };
      }

      const wrap = el.closest("li, .application-question, .application-field, .field");
      const bits = wrap?.querySelectorAll(".application-label, .text, label");
      const own = bits?.length ? clean(bits[0]?.textContent) : "";
      return { own: own || block, block };
    };

    const controls = [...form.querySelectorAll("input, select, textarea")]
      .filter((el) => (el as HTMLInputElement).type !== "hidden");

    // Group by name first. Radios and checkboxes that share a name are
    // ONE question, and treating each input as its own required field is
    // what turns a thirty-language checklist into thirty required fields.
    const byName = new Map<string, Element[]>();
    for (const el of controls) {
      const name = el.getAttribute("name") ?? "";
      if (!name) continue;
      byName.set(name, [...(byName.get(name) ?? []), el]);
    }

    /** An option's own text, which is what sits beside the input. */
    const optionLabel = (el: Element): string => {
      const id = el.getAttribute("id");
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (clean(l?.textContent)) return clean(l?.textContent);
      }
      const sib = el.nextElementSibling;
      if (sib && sib.tagName === "LABEL") return clean(sib.textContent);
      return clean(el.parentElement?.textContent);
    };

    const fields: any[] = [];
    const signatureKeys: string[] = [];

    for (const [name, els] of byName) {
      const first = els[0] as HTMLInputElement;
      const type = (first.type ?? first.tagName).toLowerCase();
      const { own, block } = labelFor(first, els.length);

      const namespace = name.startsWith("cards[") ? "card"
        : name.startsWith("surveysResponses[") ? "survey"
        : name.startsWith("eeo[") ? "eeo" : "core";
      const blockId = /\[([0-9a-f-]{8,})\]/i.exec(name)?.[1] ?? null;

      let kind: string;
      let options: string[] = [];
      if (type === "file") kind = "file";
      else if (first.tagName === "SELECT") {
        kind = "select";
        options = [...(first as unknown as HTMLSelectElement).options]
          .map((o) => clean(o.textContent)).filter(Boolean);
      } else if (type === "checkbox") {
        kind = "checkbox_group";
        options = els.map((e) => optionLabel(e)).filter(Boolean);
      } else if (type === "radio") {
        kind = "radio_group";
        options = els.map((e) => optionLabel(e)).filter(Boolean);
      } else if (first.tagName === "TEXTAREA") kind = "textarea";
      else if (name === "location") kind = "location";
      else kind = "text";

      // A field asking for a signature is never answered from stored
      // data, whatever its confidence state would have been.
      if (SIG.test(own) || SIG.test(name)) { kind = "signature"; signatureKeys.push(name); }

      // "Required" on a group member means the group needs an answer,
      // not that every member must be selected.
      const required = els.some((e) => e.hasAttribute("required")
        || e.getAttribute("aria-required") === "true")
        || /[*✱]/.test(own) || /[*✱]/.test(block);

      fields.push({
        key: name, label: own || name, kind, required, options,
        namespace, blockId, blockLabel: block || null,
        commitsTo: name === "location" ? "selectedLocation" : null,
      });
    }

    const locSelect = form.querySelector<HTMLSelectElement>("select[name='opportunityLocationId'], select[name='opportunityLocationIds']");
    const locationChoices = locSelect
      ? [...locSelect.options].map((o) => ({ value: o.value, label: clean(o.textContent) }))
        .filter((o) => o.value)
      : [];

    const frames = [...document.querySelectorAll("iframe")];
    const captchaPresent = frames.some((f) => /recaptcha|hcaptcha|turnstile/i.test(f.getAttribute("src") ?? ""));
    const captchaChallengeVisible = frames.some((f) => {
      const src = f.getAttribute("src") ?? "";
      if (!/recaptcha|hcaptcha|turnstile/i.test(src)) return false;
      const r = f.getBoundingClientRect();
      return /bframe|challenge/i.test(src) && r.width > 100 && r.height > 100;
    });

    return {
      url: location.href, fields, locationChoices,
      captchaPresent, captchaChallengeVisible, signatureKeys,
    };
  }, { signatureSource: SIGNATURE.source }) as Promise<LeverSnapshot>;
}

/**
 * Deterministic setup before the snapshot is taken.
 *
 * A multi-location posting renders different surveys depending on the
 * office, so snapshotting before choosing one records a form that will
 * not be the form at fill time. Choosing is deterministic (the reviewed
 * location, or the only option) and never a guess.
 */
export async function stabilizeLeverForm(page: Page, opts: { preferLocation?: string } = {}): Promise<{
  chose: string | null; reason: string;
}> {
  const select = page.locator("select[name='opportunityLocationId'], select[name='opportunityLocationIds']");
  if (await select.count() === 0) return { chose: null, reason: "the posting offers a single location" };

  const options = await select.first().locator("option").evaluateAll((os) =>
    os.map((o) => ({ value: (o as HTMLOptionElement).value, label: (o.textContent ?? "").trim() }))
      .filter((o) => o.value));
  if (options.length === 0) return { chose: null, reason: "the office list is empty" };

  let pick = options.length === 1 ? options[0] : undefined;
  if (!pick && opts.preferLocation) {
    const want = opts.preferLocation.toLowerCase();
    const exact = options.filter((o) => o.label.toLowerCase() === want);
    if (exact.length === 1) pick = exact[0];
  }
  if (!pick) {
    return { chose: null, reason: `${options.length} offices offered and none matches exactly; a person must choose` };
  }
  await select.first().selectOption(pick.value);
  // Surveys and conditional questions render after the choice settles.
  await page.waitForTimeout(1500);
  return { chose: pick.label, reason: options.length === 1 ? "the only office offered" : "exact match to the reviewed location" };
}

/** Stable hash input: field identity and shape, never transient values. */
export function leverSnapshotShape(s: LeverSnapshot): string {
  return JSON.stringify(s.fields
    .map((f) => [f.key, f.kind, f.required, [...f.options].sort()])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
