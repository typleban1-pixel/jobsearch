/**
 * The receipts: four numbers, each with a sentence of context.
 *
 * The number and its label are always visible; the disclosure only adds
 * context, so nothing important hides behind an interaction, and
 * <details> works from the keyboard and on a phone without script.
 *
 * The wording is deliberately flat. These are contributions on real
 * work, not claims of sole authorship, and the context lines say so
 * where that matters. Every figure here is on the confirmed list;
 * nothing appears in this file that a reference check could not survive.
 */
import s from "./site.module.css";

const METRICS = [
  {
    value: ">$70K",
    label: "Annual recurring revenue",
    more: "Genius Academy at its peak. I designed and produced it, from the set to the course people paid for.",
  },
  {
    value: "250+",
    label: "Students taught and mentored",
    more: "Teaching video production at Lorain County Community College, where I also supervised three student employees.",
  },
  {
    value: "10+",
    label: "Video deliverables, national TV",
    more: "A college and industry collaboration with a nationally broadcast television show. I coordinated it and contributed production work.",
  },
  {
    value: "~$1.2K/mo",
    label: "RentPup revenue, current",
    more: "A compliance product I built for property owners. 21 people currently use it, and it earns real revenue every month.",
  },
];

export function Metrics() {
  return (
    <div className={s.metrics}>
      {METRICS.map((m) => (
        <div className={s.metric} key={m.label}>
          <div className={s.metricValue}>{m.value}</div>
          <div className={s.metricLabel}>{m.label}</div>
          <details>
            <summary>WHAT THAT WAS</summary>
            <p>{m.more}</p>
          </details>
        </div>
      ))}
    </div>
  );
}
