"use client";

/**
 * The music section, where the page's colours finally collide.
 *
 * Every accent used earlier comes back at once here, which is the joke
 * made visually rather than stated.
 *
 * Two rules shaped this component:
 *
 *   Nothing is invented. There are five genres and nine languages,
 *   exactly as given, and density comes from repeating, resizing,
 *   rotating and overlapping those. Padding the list with plausible
 *   extra genres would be fabricating an interest.
 *
 *   Genres and languages are visibly different things. Genres are set
 *   solid in the display face; languages are outlined and monospaced,
 *   and the legend names what each group is. These are languages music
 *   is listened to in, and nothing here says otherwise.
 *
 * Positions come from a seeded generator so the server and the client
 * produce the same layout and hydration does not shuffle the words.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import s from "./site.module.css";

const GENRES = ["Pop", "Rock", "Reggae", "Country", "Latin"] as const;
const LANGUAGES = [
  "English", "Spanish", "German", "Arabic", "French",
  "Hindi", "Russian", "Polish", "Japanese",
] as const;

/** Every accent the page has used, in the order it used them. */
const PALETTE = [
  "#e85d2a", "#7c5fa8", "#f1553f", "#2e7cc4", "#e01b22",
  "#b5642e", "#1f7a4d", "#1f3a5f", "#3e6b3a", "#2a7fc1", "#e0a94f",
];

const COUNT = 64;

/** Small deterministic generator. Same layout on the server and here. */
function seeded(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

interface Word {
  text: string;
  isLang: boolean;
  left: number;
  top: number;
  size: number;
  rotate: number;
  color: string;
  batch: number;
}

function layout(): Word[] {
  const rand = seeded(20260902);
  const out: Word[] = [];
  for (let i = 0; i < COUNT; i++) {
    // Genres lead, then the languages join, then both keep arriving.
    const isLang = i < 4 ? false : rand() > 0.42;
    const pool = isLang ? LANGUAGES : GENRES;
    const text = pool[Math.floor(rand() * pool.length)]!;
    // Later words spread further out, so the section fills from the
    // middle and ends up spilling past its own edges.
    const spread = 0.25 + (i / COUNT) * 0.95;
    out.push({
      text,
      isLang,
      left: 50 + (rand() - 0.5) * 118 * spread,
      top: 50 + (rand() - 0.5) * 108 * spread,
      size: 0.85 + rand() * (i < 8 ? 2.4 : 1.7),
      rotate: (rand() - 0.5) * (i < 6 ? 8 : 30),
      color: PALETTE[Math.floor(rand() * PALETTE.length)]!,
      batch: Math.floor((i / COUNT) * 6),
    });
  }
  return out;
}

export function WordStorm() {
  const words = useMemo(layout, []);
  const ref = useRef<HTMLDivElement>(null);
  const [batch, setBatch] = useState(-1);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setBatch(99); return; }
    const el = ref.current;
    if (!el) return;

    let ticking = false;
    let visible = false;
    const update = () => {
      ticking = false;
      const r = el.getBoundingClientRect();
      const p = (window.innerHeight * 0.85 - r.top) / Math.max(1, r.height * 0.85);
      setBatch(Math.floor(Math.min(1, Math.max(0, p)) * 7) - 1);
    };
    const onScroll = () => { if (visible && !ticking) { ticking = true; requestAnimationFrame(update); } };

    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      if (visible) update();
    }, { rootMargin: "25% 0px" });
    io.observe(el);
    window.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => { io.disconnect(); window.removeEventListener("scroll", onScroll); };
  }, []);

  return (
    <>
      <div className={s.storm} ref={ref} aria-hidden="true">
        {words.map((w, i) => (
          <span
            key={i}
            className={`${s.stormWord} ${w.isLang ? s.stormLang : ""} ${w.batch <= batch ? s.on : ""}`}
            style={{
              left: `${w.left}%`,
              top: `${w.top}%`,
              fontSize: `${w.size}rem`,
              transform: `translate(-50%, -50%) rotate(${w.rotate}deg)`,
              color: w.color,
              transitionDelay: `${(i % 9) * 35}ms`,
            }}
          >
            {w.text}
          </span>
        ))}
      </div>

      <p className={s.stormLegend}>
        <span>SOLID: GENRES</span>
        <span>OUTLINED: LANGUAGES I LISTEN IN</span>
      </p>

      {/* The same information, once, in a form that reads properly. */}
      <p className={s.srOnly}>
        Genres include {GENRES.join(", ")}, among others. Languages the music is in include{" "}
        {LANGUAGES.join(", ")}.
      </p>
    </>
  );
}
