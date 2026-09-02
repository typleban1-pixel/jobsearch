"use client";

/**
 * The drawing becomes the part.
 *
 * A wipe rather than a morph. Two square photographs of the same object
 * sit in one frame and scroll reveals the finished print upward over the
 * drawing, which is the direction a part actually appears on a build
 * plate. A morph between a screenshot and a studio photograph would be
 * a lie about both of them.
 *
 * Progress is written to one custom property. There is no per-frame
 * React state, no layout read inside the scroll handler beyond a single
 * getBoundingClientRect, and the listener is passive, so this costs
 * close to nothing while it is on screen and nothing at all when it is
 * not.
 *
 * With motion reduced, no listener is attached and the stylesheet lays
 * the two photographs out side by side instead.
 */
import Image, { type StaticImageData } from "next/image";
import { useEffect, useRef } from "react";
import s from "./site.module.css";

export function CadWipe({
  drawing,
  part,
  drawingAlt,
  partAlt,
  before,
  after,
  figcaption,
}: {
  drawing: StaticImageData;
  part: StaticImageData;
  drawingAlt: string;
  partAlt: string;
  before: string;
  after: string;
  figcaption: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = ref.current;
    if (!el) return;

    let ticking = false;
    let visible = false;

    const update = () => {
      ticking = false;
      const r = el.getBoundingClientRect();
      // Runs from the moment the frame's top reaches three quarters of
      // the way down the viewport until its bottom passes the quarter
      // mark, so the part is complete well before the frame leaves.
      const start = window.innerHeight * 0.78;
      const end = window.innerHeight * 0.28;
      const p = (start - r.top) / Math.max(1, start - end + r.height * 0.35);
      const clamped = Math.min(1, Math.max(0, p));
      el.style.setProperty("--p", `${(clamped * 100).toFixed(1)}%`);
      el.classList.toggle(s.past!, clamped > 0.5);
    };

    const onScroll = () => {
      if (!visible || ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      if (visible) update();
    }, { rootMargin: "20% 0px" });

    io.observe(el);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    update();

    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <figure className={s.figure}>
      <div className={s.wipe} ref={ref}>
        <Image src={drawing} alt={drawingAlt} sizes="(max-width: 719px) 100vw, 560px" placeholder="blur" />
        <Image
          className={s.wipeTop}
          src={part}
          alt={partAlt}
          sizes="(max-width: 719px) 100vw, 560px"
          placeholder="blur"
        />
      </div>
      <div className={s.wipeCaption} aria-hidden="true">
        <span className={s.before}>{before}</span>
        <span className={s.after}>{after}</span>
      </div>
      <figcaption className={s.srOnly}>{figcaption}</figcaption>
    </figure>
  );
}
