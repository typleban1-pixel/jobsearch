/**
 * Marks made by hand, not by a font.
 *
 * A handwriting typeface is the fastest way to make a page like this
 * look like a scrapbook. These are drawn paths with a little wobble in
 * them, round caps, and the section's accent colour, paired with type
 * set in a monospace. That reads as somebody marking up a drawing, which
 * is what it is meant to be.
 *
 * All of them are decorative and hidden from assistive technology; the
 * annotation text beside them is real content and is not.
 */
import type { ReactNode } from "react";
import s from "./site.module.css";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function ArrowDown({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
      <path {...stroke} d="M12 2c1.6 5.2.4 10.1 1.2 15.3.2 1.4.5 2.8.9 4.2" />
      <path {...stroke} d="M8.6 17.4c1.9 1.6 3.5 3.4 5.5 5.8 1.4-2.1 3-3.9 5-5.4" />
    </svg>
  );
}

export function ArrowRight({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.55} viewBox="0 0 34 19" aria-hidden="true">
      <path {...stroke} d="M1 11c6.4-2.1 13-3.3 19.8-3.6 3.6-.2 7.2-.1 10.8.3" />
      <path {...stroke} d="M25.6 2.4c2.2 1.7 4 3.4 5.9 5.4-2.1 1.8-3.9 3.7-5.4 5.9" />
    </svg>
  );
}

export function ArrowUp({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
      <path {...stroke} d="M13.8 24c-1.5-5.3-.5-10.3-1.1-15.5-.2-1.4-.4-2.8-.8-4.2" />
      <path {...stroke} d="M6.9 9.2c1.8-1.9 3.4-3.9 5-6.2 1.6 2.2 3.4 4.1 5.4 5.9" />
    </svg>
  );
}

/** A loop around something, the way you would circle a word on paper. */
export function Circle({ w = 150, h = 64 }: { w?: number; h?: number }) {
  return (
    <svg width={w} height={h} viewBox="0 0 150 64" aria-hidden="true">
      <path
        {...stroke}
        d="M79 6c-24-3-49 2-63 13-13 10-11 24 5 31 19 8 51 9 73 2 19-6 26-19 15-28C99 16 84 11 66 10"
      />
    </svg>
  );
}

/** An underline dragged twice, because once is never straight. */
export function Underline({ w = 190 }: { w?: number }) {
  return (
    <svg width={w} height={12} viewBox="0 0 190 12" aria-hidden="true">
      <path {...stroke} d="M3 5c33 3 67 4 101 3 27-.7 54-2 82-3.4" />
      <path {...stroke} strokeWidth={1.4} d="M9 9.6c36 1.8 73 1.9 110 .4" />
    </svg>
  );
}

/**
 * A mark and a short line of type, tethered together.
 *
 * The text is real content. Anything that only carries a shape is
 * hidden, because a screen reader announcing six decorative arrows in a
 * row is worse than silence.
 */
export function Annotation({
  mark,
  children,
  className = "",
}: {
  mark?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={`${s.annotation} ${className}`}>
      {mark}
      <span>{children}</span>
    </p>
  );
}

/**
 * A route with four stops on it, for a country visited four times.
 *
 * The ticks are the count, so the number is in the drawing as well as in
 * the text beside it.
 */
export function RouteLine({ w = 260 }: { w?: number }) {
  return (
    <svg width={w} height={44} viewBox="0 0 260 44" aria-hidden="true">
      <path
        {...stroke}
        strokeDasharray="7 6"
        d="M6 32c26-13 47 6 71-2 22-7 33-21 56-20 25 1 38 20 62 13 21-6 34-16 59-14"
      />
      {[6, 77, 133, 194].map((x, i) => (
        <circle key={x} cx={x} cy={[32, 30, 10, 20][i]} r="4.5" fill="currentColor" />
      ))}
    </svg>
  );
}

/**
 * The arrow that means "this opens somewhere else", and the one that
 * means "moving from here to there".
 *
 * Drawn rather than typed. The characters for both sit outside the latin
 * and latin-ext subsets these typefaces ship, so a literal one would
 * silently render in whatever the operating system had lying around,
 * which is visible and cheap in the middle of a monospaced line.
 */
export function ArrowNE({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      <path {...stroke} strokeWidth={1.7} d="M2.5 11.5 11.2 2.8" />
      <path {...stroke} strokeWidth={1.7} d="M5.4 2.6c2 .1 3.9.1 5.9.2.1 2 .1 3.9.2 5.9" />
    </svg>
  );
}

export function ArrowTo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.45} viewBox="0 0 22 10" aria-hidden="true">
      <path {...stroke} strokeWidth={1.7} d="M1 5.2c6.2-.8 12.5-1 18.8-.6" />
      <path {...stroke} strokeWidth={1.7} d="M16.4 1.6c1.3 1.1 2.4 2.2 3.5 3.3-1.2 1.1-2.3 2.2-3.3 3.5" />
    </svg>
  );
}
