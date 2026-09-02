/**
 * One beat of the page, and its segment of the thread.
 *
 * The thread is drawn per section rather than once for the document.
 * Contiguous sections make it continuous, and the colour changes exactly
 * where the subject does, which is the whole point of it. Nothing
 * explains that to the reader.
 *
 * Labels are deliberately sparse. Five of them exist across the page and
 * a section without one is the normal case.
 */
import type { CSSProperties, ReactNode } from "react";
import s from "./site.module.css";

export function Section({
  accent,
  label,
  children,
  size = "normal",
  id,
  style,
}: {
  accent: string;
  label?: string;
  children: ReactNode;
  size?: "tight" | "normal" | "roomy";
  id?: string;
  style?: CSSProperties;
}) {
  const sizeClass = size === "tight" ? s.tight : size === "roomy" ? s.roomy : "";
  return (
    <section
      id={id}
      className={`${s.section} ${sizeClass}`}
      style={{ "--accent": accent, ...style } as CSSProperties}
    >
      <div className={s.rail} aria-hidden="true">
        {label ? <span className={s.railLabel}>{label}</span> : null}
      </div>
      <div className={s.wrap}>{children}</div>
    </section>
  );
}
