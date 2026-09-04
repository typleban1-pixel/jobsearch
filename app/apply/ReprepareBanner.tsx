"use client";
import { useEffect, useState } from "react";
import { partitionEntries, type BannerEntry } from "./reprepareBanner.ts";

/**
 * Immediate, persistent feedback for "Continue on Ashby".
 *
 * The board is exception-driven: the moment a parked row is re-prepared it
 * leaves "Needs you" and drops to the quiet "Preparing" section, then
 * returns as questions about a minute later. Watched from "Needs you" that
 * reads as the card vanishing and nothing happening. This banner, mounted
 * once at the top of /apply and driven by sessionStorage so it survives the
 * board's soft refresh, says plainly what is happening and where the card
 * went, and clears itself once the work has had time to finish.
 */
const PREFIX = "reprepare:";

function readAll(): BannerEntry[] {
  if (typeof window === "undefined") return [];
  const out: BannerEntry[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      const e = JSON.parse(sessionStorage.getItem(key) || "");
      if (e && typeof e.at === "number") out.push({ id: key.slice(PREFIX.length), title: String(e.title ?? "this application"), at: e.at });
    } catch { /* ignore a malformed entry */ }
  }
  return out;
}

export function ReprepareBanner() {
  const [items, setItems] = useState<BannerEntry[]>([]);
  useEffect(() => {
    const tick = () => {
      const { live, expired } = partitionEntries(readAll(), Date.now());
      for (const e of expired) sessionStorage.removeItem(PREFIX + e.id);
      setItems(live);
    };
    tick();
    const t = setInterval(tick, 3000);
    const onStarted = () => tick();
    window.addEventListener("reprepare-started", onStarted);
    return () => { clearInterval(t); window.removeEventListener("reprepare-started", onStarted); };
  }, []);

  const dismiss = (id: string) => { try { sessionStorage.removeItem(PREFIX + id); } catch {} setItems((xs) => xs.filter((x) => x.id !== id)); };
  if (!items.length) return null;
  return (
    <div className="reprepare-banner" role="status" aria-live="polite">
      {items.map((e) => (
        <div key={e.id} className="reprepare-banner-row">
          <span>Preparing <strong>{e.title}</strong> on Ashby. This takes about a minute: it moves to Preparing below, then returns under Needs you with any questions. Nothing is submitted.</span>
          <button type="button" className="reprepare-banner-x" onClick={() => dismiss(e.id)} aria-label="Dismiss">&times;</button>
        </div>
      ))}
    </div>
  );
}
