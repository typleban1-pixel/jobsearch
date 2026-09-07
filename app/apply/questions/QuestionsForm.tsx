"use client";
import { useEffect, useMemo, useState } from "react";

/** One control the reader fills. A reusable item writes its answer to every
 *  application it lists; a single item writes to exactly one. */
export interface FormItem {
  controlId: string;                 // the primary answer row id (stable key for state)
  reuseAnswerIds: string[];          // other rows to reuse into (reusable items only)
  question: string;
  blockedReason: string | null;
  required: boolean;
  options: string[];
  /** The employer form's control type: text, textarea, select, boolean, date, number, file. */
  type: string;
  applications: string[];            // labels this control resolves
  applicationId: string | null;      // set for single items, null for shared/reusable
  applyUrl?: string | null;          // employer's own form, for a file upload completed there
  /** For a follow-up question: the question it follows and how that was answered. */
  context?: string | null;
  /** An agreement or acknowledgement: given to one employer, never reused for another. */
  consent?: boolean;
}

/** A file upload cannot be answered by typing; it is never accepted here. */
const isFile = (it: FormItem) => it.type === "file";
export interface FormData {
  perApplication: { application: string; applicationId?: string | null; items: FormItem[] }[];
  shared: FormItem[];
  total: number;
}

type Draft = Record<string, { value: string; blank: boolean }>;
type Result = { status: string; ok: boolean; message?: string; reuseSkipped: string[] };

const DRAFT_KEY = "rb-consolidated-questions-draft-v1";

export function QuestionsForm({ data }: { data: FormData }) {
  const [draft, setDraft] = useState<Draft>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, Result>>({});
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  // Local drafts survive an accidental reload while the reader is mid-form.
  useEffect(() => {
    try { const s = localStorage.getItem(DRAFT_KEY); if (s) setDraft(JSON.parse(s)); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
  }, [draft]);

  // The first unresolved question gets focus, so nobody scans past the
  // answered ones to find it. A link to a specific application (#app-...)
  // focuses the first open question inside that block instead.
  useEffect(() => {
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    const scope = hash ? document.querySelector(hash) : null;
    const root = scope ?? document;
    const first = root.querySelector<HTMLElement>(".qitem:not(.done):not(.file) input, .qitem:not(.done):not(.file) textarea");
    if (first) { first.focus({ preventScroll: Boolean(scope) }); if (!scope) first.closest(".qitem")?.scrollIntoView({ block: "center" }); }
  }, []);

  // File uploads are shown for context but never answered here, so they are
  // excluded from the answerable set, the progress count, and the payload.
  const allItems = useMemo(
    () => [...data.perApplication.flatMap((g) => g.items), ...data.shared].filter((it) => !isFile(it)), [data]);

  const isDone = (it: FormItem) => saved[it.controlId];
  const isAnswered = (it: FormItem) => {
    const d = draft[it.controlId];
    return isDone(it) || (d ? (d.blank || d.value.trim().length > 0) : false);
  };
  const answeredCount = allItems.filter(isAnswered).length;
  const remaining = allItems.filter((it) => !isDone(it));

  function set(id: string, patch: Partial<{ value: string; blank: boolean }>) {
    setDraft((d) => ({ ...d, [id]: { value: d[id]?.value ?? "", blank: d[id]?.blank ?? false, ...patch } }));
  }

  async function saveAll() {
    if (saving) return;
    setSaving(true); setBanner(null);
    // Only submit controls that have an answer and are not already saved.
    const toSend = remaining
      .map((it) => ({ it, d: draft[it.controlId] }))
      .filter(({ it, d }) => d && (d.blank || d.value.trim().length > 0) && (d.blank || !it.required || d.value.trim().length > 0))
      .map(({ it, d }) => ({
        answerId: it.controlId, answer: d!.blank ? "" : d!.value.trim(),
        // A typed answer is remembered: the worker classifies it (a fact
        // about the person, a stable reply, or this exact wording only)
        // and reuses it wherever that holds, so the same question is never
        // asked twice. A blank and an agreement are one-off.
        leaveBlank: d!.blank, promote: !d!.blank && !it.consent, reuseAnswerIds: it.reuseAnswerIds,
      }));
    if (toSend.length === 0) { setBanner("Nothing to save yet. Answer at least one question."); setSaving(false); return; }
    try {
      const res = await fetch("/api/applications/answers", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: toSend }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 401) { setBanner("Your session expired. Reload and sign in."); setSaving(false); return; }
      const byId: Record<string, Result> = {};
      for (const r of json.results ?? []) byId[r.answerId] = { status: r.status, ok: r.ok, message: r.message, reuseSkipped: r.reuseSkipped ?? [] };
      setResults((prev) => ({ ...prev, ...byId }));
      const nowSaved: Record<string, boolean> = {};
      for (const r of json.results ?? []) if (r.ok) nowSaved[r.answerId] = true;
      setSaved((prev) => ({ ...prev, ...nowSaved }));
      // Drop saved answers from the local draft so a reload does not resurrect them.
      setDraft((d) => { const n = { ...d }; for (const id of Object.keys(nowSaved)) delete n[id]; return n; });

      const failed = (json.results ?? []).filter((r: any) => !r.ok).length;
      const savedN = json.saved ?? 0;
      if (json.ok && remaining.length === toSend.length) {
        window.location.href = "/apply/questions/done";
        return;
      }
      setBanner(failed > 0
        ? `${savedN} saved · ${failed} still need attention. Successful answers are kept; fix the flagged ones and save again.`
        : `${savedN} saved. ${remaining.length - toSend.length} question(s) still unanswered.`);
    } catch {
      setBanner("Could not reach the server. Your answers are kept locally; try Save again.");
    } finally { setSaving(false); }
  }

  // Plain render functions, not components. Declared inside QuestionsForm,
  // a component's identity changes on every render, so React unmounted
  // and remounted the input on each keystroke: one character, then the
  // field lost focus. A function call returns the same element tree
  // without giving it a new type.
  function renderField(it: FormItem, d: { value: string; blank: boolean }) {
    const onText = (e: any) => set(it.controlId, { value: e.target.value, blank: false });
    // An enumerated control (select, or a boolean with explicit options) is a
    // radio group over exactly what the employer offers.
    if (it.options.length > 0) {
      return (
        <div className="qitem-options">
          {it.options.map((o) => (
            <label key={o} className="qoption">
              <input type="radio" name={it.controlId} value={o} checked={!d.blank && d.value === o}
                onChange={() => set(it.controlId, { value: o, blank: false })} />
              <span>{o}</span>
            </label>
          ))}
        </div>
      );
    }
    if (it.type === "boolean") {
      return (
        <div className="qitem-options">
          {["Yes", "No"].map((o) => (
            <label key={o} className="qoption">
              <input type="radio" name={it.controlId} value={o} checked={!d.blank && d.value === o}
                onChange={() => set(it.controlId, { value: o, blank: false })} />
              <span>{o}</span>
            </label>
          ))}
        </div>
      );
    }
    if (it.type === "textarea") {
      return <textarea className="qinput" rows={4} value={d.value} disabled={d.blank} onChange={onText} aria-label={it.question} placeholder="Type your answer" />;
    }
    if (it.type === "date") return <input className="qinput" type="date" value={d.value} disabled={d.blank} onChange={onText} aria-label={it.question} />;
    if (it.type === "number") return <input className="qinput" type="number" value={d.value} disabled={d.blank} onChange={onText} aria-label={it.question} placeholder="Enter a number" />;
    return <input className="qinput" type="text" value={d.value} disabled={d.blank} onChange={onText} aria-label={it.question} placeholder="Type your answer" />;
  }

  function renderControl(it: FormItem) {
    const d = draft[it.controlId] ?? { value: "", blank: false };
    const done = isDone(it);
    const r = results[it.controlId];
    // A file upload cannot be typed. It is shown for context and pointed at
    // the employer's own form; nothing is written and it is not counted.
    if (isFile(it)) {
      return (
        <li key={it.controlId} className="qitem file">
          <p className="qitem-q">{it.question}</p>
          <p className="qitem-note">This is a file upload. Your tailored resume is attached automatically; anything else here is completed on the employer&rsquo;s own form.</p>
          {it.applyUrl
            ? <a className="qitem-continue" href={it.applyUrl} target="_blank" rel="noreferrer">Continue on the employer&rsquo;s form</a>
            : <p className="qitem-note">Open this application from Apply to continue on the employer&rsquo;s form.</p>}
        </li>
      );
    }
    return (
      <li key={it.controlId} className={`qitem${done ? " done" : ""}${r && !r.ok ? " failed" : ""}`}>
        {it.context && <p className="qitem-context">{it.context}</p>}
        <p className="qitem-q">{it.question}
          {it.applications.length > 1 && <span className="qitem-apps"> · {it.applications.length} applications</span>}
        </p>
        {it.blockedReason && <p className="qitem-why">{it.blockedReason}</p>}
        {done ? (
          <p className="qitem-saved">Saved ✓</p>
        ) : (
          <>
            {renderField(it, d)}
            {!it.required && (
              <label className="qblank">
                <input type="checkbox" checked={d.blank} onChange={(e) => set(it.controlId, { blank: e.target.checked })} />
                <span>Leave this blank</span>
              </label>
            )}
            {r && !r.ok && <p className="qitem-err">{r.message ?? "Could not save this answer."}</p>}
            {r && r.reuseSkipped?.length > 0 && (
              <p className="qitem-note">{r.reuseSkipped.length} other application(s) did not offer this option and stay open.</p>
            )}
          </>
        )}
      </li>
    );
  }

  return (
    <div className="qform">
      {banner && <div className="banner warn"><span>{banner}</span></div>}

      {data.perApplication.map((g) => (
        <section key={g.application} className="qapp" id={g.applicationId ? `app-${g.applicationId}` : undefined}>
          <h2>{g.application}</h2>
          <ul className="qitems">{g.items.map(renderControl)}</ul>
        </section>
      ))}

      {data.shared.length > 0 && (
        <section className="qapp">
          <h2>Shared across applications <span className="muted">— one answer, used where each employer offers it</span></h2>
          <ul className="qitems">{data.shared.map(renderControl)}</ul>
        </section>
      )}

      {allItems.length > 0 && (
        <div className="qsavebar">
          <span className="qprogress">{answeredCount} of {allItems.length} answered</span>
          <button className="btn-primary" onClick={saveAll} disabled={saving || answeredCount === 0}>
            {saving ? "Saving…" : "Save all answers"}
          </button>
        </div>
      )}
    </div>
  );
}
