/**
 * Four numbers, and the context behind each.
 *
 * The number and its label are always visible. The disclosure only adds
 * a sentence of context, so nothing important is hidden behind an
 * interaction, and <details> means it works from the keyboard and on a
 * phone without any script.
 *
 * The wording is deliberately flat. These are contributions on real
 * work, not claims of sole authorship, and the context lines say so
 * where that matters.
 */
import s from "./site.module.css";

const METRICS = [
  {
    value: "87%",
    label: "Claims reduced",
    more: "Diesel logistics coordination at TravelCenters of America. Most of the work was finding out why the claims kept happening.",
  },
  {
    value: "$70K+",
    label: "Annual recurring revenue",
    more: "Genius Academy at its 2022 peak. I helped build it from an idea into something people paid for. The figure is what the offering reached, not revenue I generated on my own.",
  },
  {
    value: "$120K",
    label: "Client project",
    more: "One project at Anytime Picture.",
  },
  {
    value: "3",
    label: "People supervised",
    more: "Three people at Genius One.",
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
