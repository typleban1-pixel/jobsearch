/**
 * Drafting and recording a recruiter follow-up for one application.
 *
 * The draft is composed by compose.ts from approved material and stored on
 * the application's own audit trail as an OUTREACH_DRAFTED event (edits as
 * OUTREACH_EDITED, the send as OUTREACH_SENT), through the same
 * security-definer function every portal write uses. No new table.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { composeOutreach, type OutreachDraft } from "./compose.ts";

export interface OutreachRecord {
  applicationId: string;
  company: string;
  title: string;
  jobUrl: string | null;
  submittedAt: string | null;
  recruiterName: string | null;
  recruiterEmail: string | null;
  subject: string;
  body: string;
  needsYourWords: boolean;
  problems: string[];
  draftedAt: string;
  sentAt: string | null;
}

/** What one OUTREACH_* event carries in its detail column. */
interface Stored { recruiterName?: string | null; recruiterEmail?: string | null; subject: string; body: string; needsYourWords?: boolean; problems?: string[] }

export async function composeDraftFor(
  db: SupabaseClient, applicationId: string, recruiter: { name?: string | null; email?: string | null } = {},
): Promise<{ draft: OutreachDraft; company: string; title: string } | null> {
  const { data: app } = await db.from("applications").select("id,job_id,submitted_at").eq("id", applicationId).maybeSingle();
  if (!app) return null;
  const [{ data: job }, { data: profile }, { data: desc }, { data: reqs }] = await Promise.all([
    db.from("jobs").select("title,company_id,companies(name)").eq("id", app.job_id).single(),
    db.from("profile").select("legal_first_name,legal_last_name,preferred_name,phone,linkedin_url").single(),
    db.from("job_descriptions").select("description_text").eq("job_id", app.job_id).maybeSingle(),
    db.from("job_requirements").select("raw_text").eq("job_id", app.job_id),
  ]);
  const companies = (job as any)?.companies;
  const company = (Array.isArray(companies) ? companies[0] : companies)?.name ?? "the company";
  const title = (job as any)?.title ?? "the role";
  const requirementText = ((reqs ?? []) as any[]).map((r) => r.raw_text).filter(Boolean).join("\n");
  const draft = composeOutreach({
    company, title,
    recruiterName: recruiter.name ?? null,
    postingText: `${title}\n${(desc as any)?.description_text ?? ""}\n${requirementText}`,
    profile: { preferredName: profile?.preferred_name ?? null, firstName: profile?.legal_first_name ?? "", lastName: profile?.legal_last_name ?? "",
      phone: profile?.phone ?? null, linkedin: profile?.linkedin_url ?? null },
  });
  return { draft, company, title };
}

/** Every application with a note, newest first, each with its latest text and whether it was sent. */
export async function loadOutreach(db: SupabaseClient): Promise<OutreachRecord[]> {
  const { data: events } = await db.from("application_events")
    .select("application_id,event,detail,occurred_at")
    .in("event", ["OUTREACH_DRAFTED", "OUTREACH_EDITED", "OUTREACH_SENT"])
    .order("occurred_at", { ascending: true });
  const byApp = new Map<string, { latest: Stored & { at: string }; sentAt: string | null; draftedAt: string }>();
  for (const e of (events ?? []) as any[]) {
    const cur = byApp.get(e.application_id) ?? { latest: { subject: "", body: "", at: e.occurred_at }, sentAt: null, draftedAt: e.occurred_at };
    if (e.event === "OUTREACH_SENT") { cur.sentAt = e.occurred_at; }
    else {
      try { const parsed = JSON.parse(e.detail) as Stored; cur.latest = { ...parsed, at: e.occurred_at }; }
      catch { /* an unparseable detail is skipped; the previous text stands */ }
      if (e.event === "OUTREACH_DRAFTED") cur.sentAt = null;   // a fresh draft after a send starts over
    }
    byApp.set(e.application_id, cur);
  }
  if (!byApp.size) return [];
  const ids = [...byApp.keys()];
  const { data: apps } = await db.from("applications").select("id,job_id,submitted_at").in("id", ids);
  const jobIds = [...new Set(((apps ?? []) as any[]).map((a) => a.job_id))];
  const { data: jobs } = await db.from("jobs").select("id,title,url,application_form_url,companies(name)").in("id", jobIds);
  const jobById = new Map(((jobs ?? []) as any[]).map((j) => [j.id, j]));
  const out: OutreachRecord[] = [];
  for (const a of (apps ?? []) as any[]) {
    const s = byApp.get(a.id)!; const j = jobById.get(a.job_id);
    const co = j?.companies; const company = (Array.isArray(co) ? co[0] : co)?.name ?? "Unknown";
    out.push({
      applicationId: a.id, company, title: j?.title ?? "", jobUrl: j?.url ?? j?.application_form_url ?? null,
      submittedAt: a.submitted_at ?? null,
      recruiterName: s.latest.recruiterName ?? null, recruiterEmail: s.latest.recruiterEmail ?? null,
      subject: s.latest.subject, body: s.latest.body, needsYourWords: Boolean(s.latest.needsYourWords), problems: s.latest.problems ?? [],
      draftedAt: s.draftedAt, sentAt: s.sentAt,
    });
  }
  return out.sort((x, y) => (Number(Boolean(x.sentAt)) - Number(Boolean(y.sentAt))) || y.draftedAt.localeCompare(x.draftedAt));
}
