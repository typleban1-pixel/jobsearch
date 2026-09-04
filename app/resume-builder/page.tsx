import { redirect } from "next/navigation";
import { currentSession } from "../../lib/portal/session.ts";
import { PrimaryNav } from "../PrimaryNav.tsx";
import { ResumeBuilder, type RecentResume } from "./ResumeBuilder.tsx";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { data } = await session.client.from("resume_generations")
    .select("id,resume_id,detected_title,detected_company,corrected_title,corrected_company,finished_at")
    .eq("status", "DONE").order("finished_at", { ascending: false }).limit(10);

  const recent: RecentResume[] = (data ?? []).map((r: any) => ({
    id: r.id,
    resumeId: r.resume_id,
    title: r.corrected_title ?? r.detected_title ?? "Untitled role",
    company: r.corrected_company ?? r.detected_company ?? null,
    finishedAt: r.finished_at,
  }));

  return (
    <main className="jobs resumebuilder">
      <header className="applyhead">
        <h1>Resume Builder</h1>
        <PrimaryNav current="resume-builder" />
      </header>
      <ResumeBuilder recent={recent} />
    </main>
  );
}
