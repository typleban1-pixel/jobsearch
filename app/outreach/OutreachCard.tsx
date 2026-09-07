"use client";
import { useState } from "react";
import type { OutreachRecord } from "../../lib/outreach/draft.ts";

/**
 * One follow-up note: read it, copy it, tweak a line, mark it sent.
 *
 * The text is the composer's, from the person's own pattern; edits are the
 * person's and are saved as such. Copy puts subject and body on the
 * clipboard exactly as shown. The note says the résumé is attached, so the
 * card links the PDF that was submitted with this application.
 */
export function OutreachCard({ r }: { r: OutreachRecord }) {
  const [subject, setSubject] = useState(r.subject);
  const [body, setBody] = useState(r.body);
  const [copied, setCopied] = useState<"subject" | "body" | null>(null);
  const copy = async (what: "subject" | "body") => {
    try { await navigator.clipboard.writeText(what === "subject" ? subject : body); setCopied(what); setTimeout(() => setCopied(null), 1600); }
    catch { /* the textarea is selectable; copying by hand still works */ }
  };
  const dirty = subject !== r.subject || body !== r.body;
  return (
    <article className={`notecard${r.sentAt ? " sent" : ""}`} id={`note-${r.applicationId}`}>
      <header className="notecard-head">
        <div>
          <p className="approw-company">{r.company}</p>
          <p className="approw-title">{r.title}</p>
        </div>
        <div className="notecard-meta">
          {r.sentAt
            ? <span className="statebadge s-submitted">Sent <span aria-hidden="true">✓</span></span>
            : r.needsYourWords
            ? <span className="statebadge s-needs_you">Needs your words</span>
            : <span className="statebadge s-ready">Ready to send</span>}
          {r.jobUrl && <a href={r.jobUrl} target="_blank" rel="noopener noreferrer" className="qapp-listing">View job listing ↗</a>}
          <a href={`/applications/${r.applicationId}/review`} className="qapp-listing">Review application</a>
          <a href={`/applications/${r.applicationId}/resume.pdf`} target="_blank" rel="noopener noreferrer" className="qapp-listing">R&eacute;sum&eacute; PDF to attach ↗</a>
        </div>
      </header>

      {r.problems.length > 0 && (
        <p className="notecard-problems"><b>Check before sending:</b> {r.problems.join("; ")}</p>
      )}

      <form method="post" action="/api/outreach/save" className="noteform">
        <input type="hidden" name="applicationId" value={r.applicationId} />
        <div className="noteform-row">
          <label>Recruiter name <input name="recruiterName" defaultValue={r.recruiterName ?? ""} placeholder="if you know it" /></label>
          <label>Recruiter email <input name="recruiterEmail" type="email" defaultValue={r.recruiterEmail ?? ""} placeholder="if you know it" /></label>
        </div>
        <label className="notefield-label">Subject
          <div className="notefield-copy">
            <input name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            <button type="button" className="btn-quiet" onClick={() => copy("subject")}>{copied === "subject" ? "Copied" : "Copy"}</button>
          </div>
        </label>
        <label className="notefield-label">Note
          <textarea name="body" rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="noteform-actions">
          <button type="button" className="btn-primary" onClick={() => copy("body")}>{copied === "body" ? "Copied" : "Copy note"}</button>
          <button type="submit" name="action" value="save" className="btn-quiet" disabled={!dirty}>Save edits</button>
          {!r.sentAt && <button type="submit" name="action" value="sent" className="btn-quiet">Mark as sent</button>}
        </div>
      </form>
      <form method="post" action="/api/outreach/draft" className="noteform-regen">
        <input type="hidden" name="applicationId" value={r.applicationId} />
        <input type="hidden" name="recruiterName" value={r.recruiterName ?? ""} />
        <input type="hidden" name="recruiterEmail" value={r.recruiterEmail ?? ""} />
        <button type="submit" className="qapp-remove-btn">Start over from the approved material</button>
      </form>
    </article>
  );
}
