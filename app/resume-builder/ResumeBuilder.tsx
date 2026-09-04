"use client";
import { useEffect, useRef, useState } from "react";
import { detectTitleCompany, type Confidence } from "../../lib/resume/detectPosting.ts";

export interface RecentResume {
  id: string; resumeId: string | null; title: string; company: string | null; finishedAt: string | null;
}

type Mode = "input" | "generating" | "done" | "failed";
type Field = { value: string; confidence: Confidence; edited: boolean };

const PROGRESS = ["Understanding the job…", "Matching your experience…", "Tailoring your resume…", "Generating the PDF…"];
const ERROR_TEXT: Record<string, string> = {
  POSTING_UNCLEAR: "That posting didn't have enough to work from. Paste the full job description and try again.",
  EXTRACTION_FAILED: "Couldn't read the job's requirements. Try again in a moment.",
  GROUNDING_FAILED: "Couldn't build a resume that stays within your verified evidence for this role.",
  RENDER_FAILED: "The resume was composed but the PDF didn't render. Try regenerating.",
};

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";

function badge(f: Field): { label: string; cls: string } {
  if (f.edited) return { label: "your entry", cls: "ok" };
  if (f.confidence === "HIGH") return { label: "detected", cls: "ok" };
  if (f.confidence === "LOW") return { label: "likely — confirm", cls: "low" };
  return { label: "not detected", cls: "none" };
}

export function ResumeBuilder({ recent }: { recent: RecentResume[] }) {
  const [mode, setMode] = useState<Mode>("input");
  const [text, setText] = useState("");
  const htmlRef = useRef<string | null>(null);
  const [title, setTitle] = useState<Field>({ value: "", confidence: "NONE", edited: false });
  const [company, setCompany] = useState<Field>({ value: "", confidence: "NONE", edited: false });

  const [genId, setGenId] = useState<string | null>(null);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [error, setError] = useState<{ category: string; detail: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [waited, setWaited] = useState(0);
  const [viewing, setViewing] = useState<RecentResume | null>(null);

  // Capture BOTH plain text and clipboard HTML; run detection off both.
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const plain = e.clipboardData.getData("text/plain");
    const html = e.clipboardData.getData("text/html");
    if (!plain && !html) return;
    e.preventDefault();
    const value = plain || html.replace(/<[^>]+>/g, " ");
    setText(value);
    htmlRef.current = html || null;
    const d = detectTitleCompany(value, html || null);
    setTitle({ value: d.title.value ?? "", confidence: d.title.confidence, edited: false });
    setCompany({ value: d.company.value ?? "", confidence: d.company.confidence, edited: false });
  }

  async function generate(from?: string) {
    if (submitting) return;
    setSubmitting(true); setError(null);
    try {
      const res = from
        ? await fetch(`/api/resume/${from}/regenerate`, { method: "POST" })
        : await fetch("/api/resume/generate", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
              pastedText: text, pastedHtml: htmlRef.current,
              detectedTitle: title.edited ? null : title.value || null,
              detectedCompany: company.edited ? null : company.value || null,
              correctedTitle: title.edited ? title.value || null : null,
              correctedCompany: company.edited ? company.value || null : null,
            }),
          });
      const json = await res.json();
      if (!res.ok || !json.id) { setError({ category: "POSTING_UNCLEAR", detail: json.error ?? "could not start" }); setMode("failed"); return; }
      setGenId(json.id); setResumeId(null); setSummary(null); setProgress(0); setWaited(0); setMode("generating");
    } finally { setSubmitting(false); }
  }

  // Poll while generating.
  useEffect(() => {
    if (mode !== "generating" || !genId) return;
    let alive = true;
    const started = Date.now();
    const prog = setInterval(() => setProgress((p) => (p + 1) % PROGRESS.length), 3500);
    const tick = setInterval(async () => {
      setWaited(Math.round((Date.now() - started) / 1000));
      const res = await fetch(`/api/resume/${genId}`).catch(() => null);
      if (!res || !alive) return;
      const g = await res.json();
      if (g.status === "DONE") { setResumeId(g.resume_id); setSummary(g.tailoring_summary); setMode("done"); }
      else if (g.status === "FAILED") { setError({ category: g.error_category, detail: g.error_detail }); setMode("failed"); }
    }, 2000);
    return () => { alive = false; clearInterval(tick); clearInterval(prog); };
  }, [mode, genId]);

  const canGenerate = text.trim().length >= 40 && !submitting;

  return (
    <div className="rb">
      {(mode === "input") && (
        <>
          <p className="rb-lead">Paste a job posting below and I'll tailor your resume using your verified experience.</p>
          <div className="rb-detected">
            <label>Job title <span className={`rb-conf ${badge(title).cls}`}>{badge(title).label}</span>
              <input value={title.value} placeholder="e.g. Operations Manager"
                onChange={(e) => setTitle({ value: e.target.value, confidence: title.confidence, edited: true })} />
            </label>
            <label>Company <span className={`rb-conf ${badge(company).cls}`}>{badge(company).label}</span>
              <input value={company.value} placeholder="e.g. Acme"
                onChange={(e) => setCompany({ value: e.target.value, confidence: company.confidence, edited: true })} />
            </label>
          </div>
          <textarea className="rb-paste" value={text} onPaste={onPaste}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the entire job posting here…" rows={16} aria-label="Job posting" />
          <div className="rb-actions">
            <button className="btn-primary" disabled={!canGenerate} onClick={() => generate()}>Generate Resume</button>
            {text.trim().length > 0 && text.trim().length < 40 && <span className="rb-hint">Paste a bit more of the posting.</span>}
          </div>
        </>
      )}

      {mode === "generating" && (
        <div className="rb-progress">
          <div className="rb-spinner" aria-hidden />
          <p>{PROGRESS[progress]}</p>
          {waited > 20 && (
            <p className="rb-muted">Still working — generation runs on your Mac. If the generator is offline this will stay queued;
              it will pick up automatically when it's running.</p>
          )}
          <button className="btn-quiet" onClick={() => { setMode("input"); }}>Cancel</button>
        </div>
      )}

      {mode === "failed" && (
        <div className="rb-failed">
          <p className="rb-err">{ERROR_TEXT[error?.category ?? ""] ?? "Something went wrong."}</p>
          <div className="rb-actions">
            <button className="btn-primary" onClick={() => genId ? generate(genId) : setMode("input")}>Try again</button>
            <button className="btn-quiet" onClick={() => setMode("input")}>Edit job posting</button>
          </div>
        </div>
      )}

      {mode === "done" && resumeId && (
        <div className="rb-done">
          <div className="rb-result-head">
            <div>
              <h2>{company.value || "Your resume"}</h2>
              <p className="rb-role">{title.value || "Tailored resume"} · generated {fmtDate(new Date().toISOString())}</p>
            </div>
          </div>
          <object className="rb-preview" data={`/resumes/${resumeId}/resume.pdf`} type="application/pdf" aria-label="Resume preview">
            <p>Preview unavailable — <a href={`/resumes/${resumeId}/resume.pdf`}>open the PDF</a>.</p>
          </object>
          <div className="rb-actions">
            <a className="btn-primary" href={`/resumes/${resumeId}/resume.pdf`} download="resume.pdf">Download PDF</a>
            <button className="btn-quiet" onClick={() => genId && generate(genId)}>Regenerate</button>
            <button className="btn-quiet" onClick={() => setMode("input")}>Edit job posting</button>
          </div>
          <TailoringDetails summary={summary} />
        </div>
      )}

      {recent.length > 0 && (
        <section className="rb-recent">
          <h3>Recent resumes</h3>
          <ul>
            {recent.map((r) => (
              <li key={r.id}>
                <div className="rb-recent-meta">
                  <span className="rb-recent-title">{r.title}</span>
                  <span className="rb-recent-sub">{[r.company, fmtDate(r.finishedAt)].filter(Boolean).join(" · ")}</span>
                </div>
                {r.resumeId && (
                  <div className="rb-recent-actions">
                    <button className="btn-quiet" onClick={() => setViewing(r)}>Open</button>
                    <a className="btn-quiet" href={`/resumes/${r.resumeId}/resume.pdf`} download="resume.pdf">Download</a>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {viewing?.resumeId && (
        <div className="rb-modal" onClick={() => setViewing(null)}>
          <div className="rb-modal-body" onClick={(e) => e.stopPropagation()}>
            <div className="rb-actions">
              <strong>{viewing.title}{viewing.company ? ` · ${viewing.company}` : ""}</strong>
              <a className="btn-quiet" href={`/resumes/${viewing.resumeId}/resume.pdf`} download="resume.pdf">Download</a>
              <button className="btn-quiet" onClick={() => setViewing(null)}>Close</button>
            </div>
            <object className="rb-preview" data={`/resumes/${viewing.resumeId}/resume.pdf`} type="application/pdf" aria-label="Resume preview" />
          </div>
        </div>
      )}
    </div>
  );
}

function TailoringDetails({ summary }: { summary: any }) {
  if (!summary) return null;
  const themes: string[] = summary.jobThemes ?? [];
  const emphasized: string[] = summary.emphasized ?? [];
  const reframes: Array<{ from: string; to: string }> = summary.reframes ?? [];
  return (
    <details className="rb-tailoring">
      <summary>Show tailoring details</summary>
      <div className="rb-tailoring-body">
        {themes.length > 0 && (
          <div><h4>What the job emphasized</h4><p>{themes.join(" · ")}</p></div>
        )}
        {emphasized.length > 0 && (
          <div><h4>What your resume emphasized</h4><ul>{emphasized.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}</ul></div>
        )}
        {reframes.length > 0 && (
          <div><h4>Major reframes</h4>
            <ul>{reframes.slice(0, 8).map((r, i) => <li key={i}><span className="rb-from">{r.from}</span> → <span className="rb-to">{r.to}</span></li>)}</ul>
          </div>
        )}
        <p className="rb-muted">Every line stays within your verified evidence. Nothing here is invented.</p>
      </div>
    </details>
  );
}
