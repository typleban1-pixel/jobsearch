import { Suspense } from "react";
import { currentSession } from "../lib/portal/session.ts";
import { loadNavCounts } from "../lib/portal/attention.ts";

/**
 * The places a person goes.
 *
 * Jobs is where a job is chosen; Applications is where the chosen ones are
 * followed; Batched is what has been approved and waits for the next
 * scheduled run. The route behind Applications is still /apply -- renaming
 * it would only invite broken links -- and every `current="apply"` caller
 * keeps working. The count beside Applications is how many need the
 * person, the one beside Batched how many wait; both stream in after the
 * nav so no page waits on them, and a page that already knows passes them.
 */
export type NavKey = "apply" | "batched" | "jobs" | "outreach" | "resume-builder" | "submitted" | "settings";

const session = cacheSession();
function cacheSession() {
  // One session lookup per request for both counts.
  let p: ReturnType<typeof currentSession> | null = null;
  return () => (p ??= currentSession());
}

async function Count({ which }: { which: "needsYou" | "batched" }) {
  const s = await session();
  if (!s) return null;
  const n = (await loadNavCounts(s.client).catch(() => ({ needsYou: 0, batched: 0 })))[which];
  return n > 0 ? <span className={`navcount${which === "batched" ? " quiet" : ""}`} aria-label={which === "needsYou" ? `${n} need you` : `${n} batched`}>{n}</span> : null;
}

export function PrimaryNav({ current, attention, batched }: { current: NavKey; attention?: number; batched?: number }) {
  const items = [
    { key: "jobs", href: "/jobs", label: "Jobs" },
    { key: "apply", href: "/apply", label: "Applications" },
    { key: "batched", href: "/batched", label: "Batched" },
    { key: "outreach", href: "/outreach", label: "Outreach" },
    { key: "resume-builder", href: "/resume-builder", label: "Resume Builder" },
    { key: "submitted", href: "/submitted", label: "Submitted" },
    { key: "settings", href: "/settings", label: "Settings" },
  ] as const;
  const badge = (key: string) => {
    if (key === "apply") return attention !== undefined
      ? (attention > 0 ? <span className="navcount" aria-label={`${attention} need you`}>{attention}</span> : null)
      : <Suspense fallback={null}><Count which="needsYou" /></Suspense>;
    if (key === "batched") return batched !== undefined
      ? (batched > 0 ? <span className="navcount quiet" aria-label={`${batched} batched`}>{batched}</span> : null)
      : <Suspense fallback={null}><Count which="batched" /></Suspense>;
    return null;
  };
  return (
    <nav className="primarynav" aria-label="Primary">
      {items.map((i) => (
        <a key={i.key} href={i.href} aria-current={i.key === current ? "page" : undefined}>
          {i.label}
          {badge(i.key)}
        </a>
      ))}
    </nav>
  );
}
