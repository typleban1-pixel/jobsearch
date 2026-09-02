"use client";

/**
 * The last line, and its aside.
 *
 * A real button rather than a hover target, so it works on a phone and
 * from the keyboard. The aside is in the document either way; hover and
 * tap only change whether it is visible, and nothing depends on finding
 * it.
 */
import { useState } from "react";
import s from "./site.module.css";

export function MadeBy() {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={s.madeBy}
      data-open={open ? "true" : "false"}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
    >
      Made by Ty. <span className={s.rev}>with an unreasonable number of revisions.</span>
    </button>
  );
}
