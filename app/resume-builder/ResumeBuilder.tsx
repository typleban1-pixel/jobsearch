"use client";
import { useEffect, useRef, useState } from "react";
import { detectTitleCompany } from "../../lib/resume/detectPosting.ts";
import { readablePaste } from "../../lib/resume/readablePaste.ts";

export interface RecentResume {
  id: string; resumeId: string | null; title: string; company: string | null; finishedAt: string | null;
}

type Mode = "input" | "generating" | "done" | "failed";
type Match = { score: number; provisional: boolean; note: string | null } | null;
type Why = {
  hardMet: number; hardTotal: number; directMatches: number; transferableMatches: number;
  gaps: string[]; seniority: string; uncertaintyNote: string | null;
} | null;

const PROGRESS = ["Understanding the job…", "Matching your experience…", "Tailoring your resume…", "Generating the PDF…"];

/** Distinct failure states: what went wrong, and whether retrying the same
 *  input could plausibly help. POSTING_UNCLEAR/GROUNDING can't be fixed by
 *  resubmitting, so Edit is primary and there is no bare "Try again". */
const FAIL: Record<string, { text: string; retry: boolean }> = {
  POSTING_UNCLEAR: { text: "That posting was too short or incomplete to tailor from. Paste the full job description.", retry: false },
  GROUNDING_FAILED: { text: "Couldn't build a resume that stays within your verified evidence for this role.", retry: false },
  EXTRACTION_FAILED: { text: "Couldn't read the job's requirements — this is usually temporary.", retry: true },
  RENDER_FAILED: { text: "The resume was composed but the PDF didn't render — usually temporary.", retry: true },
  REQUEST_FAILED: { text: "Couldn't submit the posting. Check your connection and try again.", retry: true },
};

const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
const interpret = (m: Match) => !m ? "" : m.score >= 70 ? "Strong match" : m.score >= 55 ? "Solid match" : m.score >= 35 ? "Some alignment" : "Limited alignment";

export function ResumeBuilder({ recent }: { recent: RecentResume[] }) {
  const [mode, setMode] = useState<Mode>("input");
  const [text, setText] = useState("");
  const htmlRef = useRef<string | null>(null);

  const [genId, setGenId] = useState<string | null>(null);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [match, setMatch] = useState<Match>(null);
  const [why, setWhy] = useState<Why>(null);
  const [failCategory, setFailCategory] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<"QUEUED" | "PREPARING">("QUEUED");
  const [waited, setWaited] = useState(0);
  const [viewing, setViewing] = useState<RecentResume | null>(null);

  // Capture the clipboard HTML (also sent to the server, which sanitises
  // it) and, when it is present, use it to keep the posting's structure:
  // many boards emit text/plain with every block run together, so we paste
  // a block-aware, readable rendering instead. When there is no usable HTML
  // we do nothing and let the native text/plain paste through, so text can
  // never be lost to a clipboard quirk.
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    let html: string | null = null;
    try { html = e.clipboardData.getData("text/html") || null; } catch { html = null; }
    htmlRef.current = html;
    if (!html) return;
    const readable = readablePaste(html);
    if (readable.trim().length < 20) return; // weak conversion -> native paste
    e.preventDefault();
    const ta = e.currentTarget;
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    setText(text.slice(0, start) + readable + text.slice(end));
  }

  async function generate(from?: string) {
    if (submitting) return;
    setSubmitting(true); setFailCategory("");
    try {
      let res: Response;
      if (from) {
        res = await fetch(`/api/resume/${from}/regenerate`, { method: "POST" });
      } else {
        const d = detectTitleCompany(text, htmlRef.current); // internal metadata only
        res = await fetch("/api/resume/generate", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ pastedText: text, pastedHtml: htmlRef.current, detectedTitle: d.title.value, detectedCompany: d.company.value }),
        });
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.id) {
        // A short-posting 400 is genuinely POSTING_UNCLEAR; anything else is a
        // transient request/input failure -- never mislabel it as a bad posting.
        const category = res.status === 400 ? "POSTING_UNCLEAR" : "REQUEST_FAILED";
        setFailCategory(category); setMode("failed"); return;
      }
      setGenId(json.id); setResumeId(null); setSummary(null); setMatch(null); setWhy(null);
      setProgress(0); setWaited(0); setPhase("QUEUED"); setMode("generating");
    } catch {
      setFailCategory("REQUEST_FAILED"); setMode("failed");
    } finally { setSubmitting(false); }
  }

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
      if (g.status === "PREPARING" || g.status === "QUEUED") { setPhase(g.status); return; }
      if (g.status === "DONE") {
        setResumeId(g.resume_id);
        setSummary(g.tailoring_summary);
        setMatch(g.tailoring_summary?.match ?? null);
        setWhy(g.tailoring_summary?.why ?? null);
        setMode("done");
      } else if (g.status === "FAILED") { setFailCategory(g.error_category ?? "EXTRACTION_FAILED"); setMode("failed"); }
    }, 2000);
    return () => { alive = false; clearInterval(tick); clearInterval(prog); };
  }, [mode, genId]);

  const canGenerate = text.trim().length >= 40 && !submitting;

  return (
    <div className="rb">
      {mode === "input" && (
        <>
          <p className="rb-lead">Paste a job posting below and I'll tailor your resume using your verified experience.</p>
          <textarea className="rb-paste" value={text} onPaste={onPaste} onChange={(e) => setText(e.target.value)}
            placeholder="Paste the entire job posting here…" rows={18} aria-label="Job posting" />
          <div className="rb-actions">
            <button className="btn-primary" disabled={!canGenerate} onClick={() => generate()}>Generate Resume</button>
            {text.trim().length > 0 && text.trim().length < 40 && <span className="rb-hint">Paste a bit more of the posting.</span>}
          </div>
        </>
      )}

      {mode === "generating" && (
        <div className="rb-progress">
          <div className="rb-spinner" aria-hidden />
          <p>{phase === "QUEUED" && waited > 15 ? "Waiting for the generator…" : PROGRESS[progress]}</p>
          {phase === "QUEUED" && waited > 15 && (
            <p className="rb-muted">Generation runs on your Mac. If the generator is offline this stays queued and will pick up
              automatically when it's running.</p>
          )}
          <button className="btn-quiet" onClick={() => setMode("input")}>Cancel</button>
        </div>
      )}

      {mode === "failed" && (() => {
        const f = FAIL[failCategory] ?? { text: "Something went wrong. Please try again.", retry: true };
        return (
          <div className="rb-failed">
            <p className="rb-err">{f.text}</p>
            <div className="rb-actions">
              {f.retry
                ? <button className="btn-primary" onClick={() => genId ? generate(genId) : generate()}>Try again</button>
                : <button className="btn-primary" onClick={() => setMode("input")}>Edit job posting</button>}
              {f.retry && <button className="btn-quiet" onClick={() => setMode("input")}>Edit job posting</button>}
            </div>
          </div>
        );
      })()}

      {mode === "done" && resumeId && (
        <div className="rb-done">
          {match && (
            <div className="rb-score">
              <span className="rb-score-num">{match.provisional ? "~" : ""}{match.score}<span className="rb-score-den">/100</span></span>
              <div>
                <p className="rb-score-label">{interpret(match)}{match.provisional ? " · estimate" : ""}</p>
                {match.note && <p className="rb-muted">{match.note}</p>}
              </div>
            </div>
          )}
          <object className="rb-preview" data={`/resumes/${resumeId}/resume.pdf`} type="application/pdf" aria-label="Resume preview">
            <p>Preview unavailable — <a href={`/resumes/${resumeId}/resume.pdf`}>open the PDF</a>.</p>
          </object>
          <div className="rb-actions">
            <a className="btn-primary" href={`/resumes/${resumeId}/resume.pdf`} download="resume.pdf">Download Resume</a>
            <button className="btn-quiet" onClick={() => genId && generate(genId)}>Regenerate</button>
            <button className="btn-quiet" onClick={() => setMode("input")}>Edit job posting</button>
          </div>
          {why && <WhyThisScore why={why} />}
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

function WhyThisScore({ why }: { why: NonNullable<Why> }) {
  return (
    <details className="rb-tailoring">
      <summary>Why this score?</summary>
      <div className="rb-tailoring-body">
        <dl className="matchgrid">
          <div><dt>Role-defining requirements supported</dt><dd>{why.hardMet}/{why.hardTotal}</dd></div>
          <div><dt>Direct matches</dt><dd>{why.directMatches}</dd></div>
          <div><dt>Transferable matches</dt><dd>{why.transferableMatches}</dd></div>
          <div><dt>Meaningful gaps</dt><dd>{why.gaps.length ? why.gaps.slice(0, 4).join(", ") : "none"}</dd></div>
          <div><dt>Seniority alignment</dt><dd>{why.seniority}</dd></div>
          <div><dt>Uncertainty</dt><dd>{why.uncertaintyNote ?? "low"}</dd></div>
        </dl>
        <p className="rb-muted">The same evidence-based Match Score used across Jobs and Apply. Nothing here is invented.</p>
      </div>
    </details>
  );
}

function TailoringDetails({ summary }: { summary: any }) {
  if (!summary) return null;
  const themes: string[] = summary.jobThemes ?? [];
  const emphasized: string[] = summary.emphasized ?? [];
  const reframes: Array<{ from: string; to: string }> = summary.reframes ?? [];
  if (!themes.length && !emphasized.length && !reframes.length) return null;
  return (
    <details className="rb-tailoring">
      <summary>Show tailoring details</summary>
      <div className="rb-tailoring-body">
        {themes.length > 0 && <div><h4>What the job emphasized</h4><p>{themes.join(" · ")}</p></div>}
        {emphasized.length > 0 && <div><h4>What your resume emphasized</h4><ul>{emphasized.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
        {reframes.length > 0 && (
          <div><h4>Major reframes</h4>
            <ul>{reframes.slice(0, 8).map((r, i) => <li key={i}><span className="rb-from">{r.from}</span> → <span className="rb-to">{r.to}</span></li>)}</ul></div>
        )}
        <p className="rb-muted">Every line stays within your verified evidence.</p>
      </div>
    </details>
  );
}
