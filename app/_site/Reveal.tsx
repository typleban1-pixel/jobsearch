"use client";

/**
 * Fades a block in the first time it is seen, and then forgets about it.
 *
 * One observer per element, disconnected on the first intersection, so
 * nothing is left listening after the page settles. When motion is
 * reduced the class is applied immediately and no observer is created at
 * all: the stylesheet already renders the finished state, and attaching
 * work nobody will see is still work.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import s from "./site.module.css";

export function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setOn(true); return; }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setOn(true); io.disconnect(); }
    }, { rootMargin: "0px 0px -12% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={`${s.reveal} ${on ? s.on : ""}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}
