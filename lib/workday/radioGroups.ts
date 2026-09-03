/**
 * A radio group is one question, not one field per option.
 *
 * Discovery recorded each radio input as its own field, keyed by the
 * only text it could see: the option label. So Northern Trust's
 * "have you previously worked here" arrived as a field called "Yes",
 * and the filler then looked for a control matching "Yes" and found
 * three across the page. It refused, correctly, and the page could not
 * be completed.
 *
 * The fix is to identify a group the way the DOM does: by the shared
 * `name` every option in it carries. That is stable, unique per group,
 * and survives re-rendering, where a visible label is neither unique nor
 * necessarily present -- Workday points the group's label at an element
 * id that holds no text.
 *
 * One row per group, carrying its options. The answer selects an option
 * at fill time, and the selector is built from the group name AND the
 * chosen value, so it can never match another group's identically
 * labelled option.
 */

export interface RawControl {
  label: string;
  htmlType: string;
  /** The DOM `name` attribute, shared by every option in a group. */
  name?: string | null;
  selector?: string;
  required?: boolean;
  value?: string | null;
}

export interface FieldRecord {
  /** The selector or group identity this field is stored under. */
  key: string;
  question: string;
  required: boolean;
  options: string[] | null;
  /** Set for radio groups: the shared name attribute. */
  groupName?: string | null;
}

/** The group identity a radio's options share. */
export const radioGroupKey = (name: string): string => `radio-group:${name}`;

/**
 * The selector for one option of a group.
 *
 * Both halves are required. The name alone matches every option; the
 * value alone matches every "No" on the page.
 */
export const radioOptionSelector = (name: string, value: string): string =>
  `input[name="${name}"][value="${value}"]`;

/**
 * Collapses raw controls so each radio group is a single question.
 *
 * A radio with no name cannot be grouped and is left alone rather than
 * guessed at: an ungrouped radio is a question we cannot identify, and
 * inventing an identity for it is how the original bug happened.
 */
export function collapseRadioGroups(controls: RawControl[]): FieldRecord[] {
  const out: FieldRecord[] = [];
  const groups = new Map<string, RawControl[]>();

  for (const c of controls) {
    if (c.htmlType === "radio" && c.name) {
      groups.set(c.name, [...(groups.get(c.name) ?? []), c]);
      continue;
    }
    out.push({
      key: c.selector ?? c.label,
      question: c.label,
      required: Boolean(c.required),
      options: null,
    });
  }

  for (const [name, opts] of groups) {
    // The group's question is whatever label is shared by none of the
    // options -- and when there is none, the name itself, which is at
    // least stable and traceable. "Yes" is never the question.
    const optionLabels = opts.map((o) => o.value ?? o.label).filter(Boolean) as string[];
    out.push({
      key: radioGroupKey(name),
      question: humanise(name),
      required: opts.some((o) => o.required),
      options: [...new Set(optionLabels)],
      groupName: name,
    });
  }
  return out;
}

/**
 * A readable question from a control name.
 *
 * candidateIsPreviousWorker -> "Candidate Is Previous Worker". Not the
 * employer's wording, and not pretending to be: it is a traceable
 * placeholder for a question whose visible label the DOM does not
 * expose, and it is unique, which the label was not.
 */
export function humanise(name: string): string {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
