import { Suspense } from "react";
import { currentSession } from "../lib/portal/session.ts";
import { loadAttentionCount } from "../lib/portal/attention.ts";

/**
 * The places a person goes.
 *
 * Jobs is where a job is chosen; Applications is where the chosen ones are
 * followed. The route behind Applications is still /apply -- renaming it
 * would only invite broken links -- and every `current="apply"` caller
 * keeps working. The count beside Applications is how many need the
 * person, never how many exist: it streams in after the nav so no page
 * waits on it, and a page that already knows the number passes it.
 */
export type NavKey = "apply" | "jobs" | "outreach" | "resume-builder" | "submitted" | "settings";

async function AttentionCount() {
  const session = await currentSession();
  if (!session) return null;
  const n = await loadAttentionCount(session.client).catch(() => 0);
  return n > 0 ? <span className="navcount" aria-label={`${n} need you`}>{n}</span> : null;
}

export function PrimaryNav({ current, attention }: { current: NavKey; attention?: number }) {
  const items = [
    { key: "jobs", href: "/jobs", label: "Jobs" },
    { key: "apply", href: "/apply", label: "Applications" },
    { key: "outreach", href: "/outreach", label: "Outreach" },
    { key: "resume-builder", href: "/resume-builder", label: "Resume Builder" },
    { key: "submitted", href: "/submitted", label: "Submitted" },
    { key: "settings", href: "/settings", label: "Settings" },
  ] as const;
  return (
    <nav className="primarynav" aria-label="Primary">
      {items.map((i) => (
        <a key={i.key} href={i.href} aria-current={i.key === current ? "page" : undefined}>
          {i.label}
          {i.key === "apply" && (attention !== undefined
            ? (attention > 0 ? <span className="navcount" aria-label={`${attention} need you`}>{attention}</span> : null)
            : <Suspense fallback={null}><AttentionCount /></Suspense>)}
        </a>
      ))}
    </nav>
  );
}
