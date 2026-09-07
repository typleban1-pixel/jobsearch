import Link from "next/link";
import type { PresentationState } from "../lib/portal/presentationState.ts";
import { STATE_LABEL } from "../lib/portal/presentationState.ts";

/**
 * One application state, said the same way everywhere.
 *
 * Needs you and Ready lead somewhere (the review, or the questions); a
 * submitted application looks finished, not clickable-into-work; preparing
 * is quiet. The words come from STATE_LABEL so Jobs and Applications can
 * never disagree about what a state is called.
 */
export function StateBadge({ state, href, block = false }: { state: PresentationState; href?: string | null; block?: boolean }) {
  const label = STATE_LABEL[state];
  const cls = `statebadge s-${state.toLowerCase()}${block ? " block" : ""}`;
  if (state === "PREPARING") return <span className={cls} aria-live="polite">{label}&hellip;</span>;
  if (state === "SUBMITTED") {
    return href
      ? <Link className={cls} href={href}>{label} <span aria-hidden="true">&#10003;</span></Link>
      : <span className={cls}>{label} <span aria-hidden="true">&#10003;</span></span>;
  }
  if (!href) return <span className={cls}>{label}</span>;
  return <Link className={cls} href={href}>{label} <span aria-hidden="true">&rarr;</span></Link>;
}
