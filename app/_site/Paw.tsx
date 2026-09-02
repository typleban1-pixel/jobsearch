"use client";

/**
 * A paw, drawn in, just before the photograph it belongs to.
 *
 * Its only job is to make the reader pause for a second longer than
 * they meant to. Decorative, so it is hidden from assistive technology;
 * the reveal it sets up is carried by the text and the photograph.
 */
import { useEffect, useRef, useState } from "react";
import s from "./site.module.css";

export function Paw({ color }: { color: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setOn(true); return; }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setOn(true); io.disconnect(); }
    }, { rootMargin: "0px 0px -20% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const path = {
    fill: "none",
    stroke: color,
    strokeWidth: 2.4,
    strokeLinecap: "round" as const,
    pathLength: 1,
  };

  return (
    <svg ref={ref} className={s.paw} width="74" height="66" viewBox="0 0 74 66" aria-hidden="true">
      <g className={`${s.pawPath} ${on ? s.on : ""}`}>
        <path {...path} d="M37 34c8.5 0 15.5 5.4 15.5 12.4 0 6-5.2 9.6-11 9.6-2 0-3.2-.7-4.5-.7s-2.5.7-4.5.7c-5.8 0-11-3.6-11-9.6C21.5 39.4 28.5 34 37 34Z" />
        <path {...path} d="M22.6 20.5c2.7-.7 5.8 1.7 6.8 5.4 1 3.8-.4 7.4-3.1 8.1-2.7.7-5.8-1.7-6.8-5.4-1-3.8.4-7.4 3.1-8.1Z" />
        <path {...path} d="M51.4 20.5c2.7.7 4.1 4.3 3.1 8.1-1 3.7-4.1 6.1-6.8 5.4-2.7-.7-4.1-4.3-3.1-8.1 1-3.7 4.1-6.1 6.8-5.4Z" />
        <path {...path} d="M37 12c2.9 0 5.2 3.3 5.2 7.4S39.9 26.8 37 26.8s-5.2-3.3-5.2-7.4S34.1 12 37 12Z" />
      </g>
    </svg>
  );
}
