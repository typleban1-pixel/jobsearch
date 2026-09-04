/**
 * The four things a person does here.
 *
 * Handoff, Activity, ATS status, Companies and the automation controls
 * still exist and still work; they moved under Settings because none of
 * them is a step in applying for a job. "Handoff" in particular was a
 * word for an internal state, and reading it was never the point: the
 * work it represents now appears on Apply as the thing to go and do.
 */
export function PrimaryNav({ current }: { current: "apply" | "jobs" | "resume-builder" | "submitted" | "settings" }) {
  const items = [
    { key: "apply", href: "/apply", label: "Apply" },
    { key: "jobs", href: "/jobs", label: "Jobs" },
    { key: "resume-builder", href: "/resume-builder", label: "Resume Builder" },
    { key: "submitted", href: "/submitted", label: "Submitted" },
    { key: "settings", href: "/settings", label: "Settings" },
  ] as const;
  return (
    <nav className="primarynav" aria-label="Primary">
      {items.map((i) => (
        <a key={i.key} href={i.href} aria-current={i.key === current ? "page" : undefined}>{i.label}</a>
      ))}
    </nav>
  );
}
