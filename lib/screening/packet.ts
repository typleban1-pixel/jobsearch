/**
 * What the evaluator is allowed to see.
 *
 * The evaluation is only worth having if the evaluator is genuinely
 * blind. Given the evidence behind a claim, it would judge the claim
 * rather than the resume, and the finding "a recruiter would never
 * notice this" is exactly the finding that becomes impossible once you
 * know the thing is there.
 *
 * So the packet is built by naming every field that goes into it, not
 * by removing fields that must not. A whitelist fails closed: a future
 * column added to ResumeDoc is absent from the packet until someone
 * decides it belongs, whereas a blacklist would leak it silently.
 *
 * `sources` is the field this exists to drop. Every line of the resume
 * carries the evidence row ids that justify it; the employer never sees
 * them and neither does the evaluator.
 */
import type { ResumeDoc } from "../render/resume.ts";

export const PACKET_VERSION = 1;

/** A posting demand, as the posting words it. */
export interface PacketRequirement {
  text: string;
  hardness: "HARD" | "PREFERRED" | "UNCLEAR";
}

export interface ScreeningPacket {
  job: {
    title: string;
    company: string;
    /** The posting's own text, as extracted. No internal annotation. */
    requirements: PacketRequirement[];
    description: string | null;
  };
  resume: {
    name: string;
    location: string;
    summary: string;
    roles: Array<{
      title: string; employer: string; location: string | null;
      start: string; end: string | null;
      bullets: string[];
    }>;
    education: Array<{ institution: string; credential: string; field: string | null }>;
    skills: Array<{ label: string; skills: string[] }>;
    projects: Array<{ name: string; description: string }>;
  };
  /** The rendered page, when the layout itself is under evaluation. */
  renderedText: string | null;
}

export interface PacketJob {
  title: string;
  company: string;
  requirements: PacketRequirement[];
  description?: string | null;
}

/**
 * Builds the packet, field by named field.
 *
 * Dates are passed through as the resume prints them, because how a
 * chronology READS is one of the things being evaluated and a
 * reformatted date is a different reading.
 */
export function buildPacket(doc: ResumeDoc, job: PacketJob, renderedText: string | null = null): ScreeningPacket {
  return {
    job: {
      title: job.title,
      company: job.company,
      requirements: job.requirements.map((r) => ({ text: r.text, hardness: r.hardness })),
      description: job.description ?? null,
    },
    resume: {
      name: doc.name,
      location: doc.location,
      summary: doc.summary.text,
      roles: doc.roles.map((r) => ({
        title: r.title, employer: r.employer, location: r.location,
        start: r.start, end: r.end,
        bullets: r.lines.map((l) => l.text),
      })),
      education: doc.education.map((e) => ({
        institution: e.institution, credential: e.credential, field: e.field ?? null,
      })),
      skills: doc.skillGroups.map((g) => ({ label: g.label, skills: [...g.skills] })),
      projects: doc.projects.map((p) => ({ name: p.name, description: p.line.text })),
    },
    renderedText,
  };
}

/**
 * Proves the packet carries no evidence identifiers.
 *
 * Called before every evaluation, not as a formality: the whitelist
 * above is the guarantee, and this is the check that the guarantee held
 * after somebody edits it. A uuid in an employer-facing packet is
 * always a leak, since nothing an employer reads contains one.
 */
export function assertNoEvidenceLeak(packet: ScreeningPacket, knownEvidenceIds: string[] = []): void {
  const serialized = JSON.stringify(packet);

  const uuids = serialized.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  if (uuids.length) {
    throw new Error(`the screening packet contains ${uuids.length} identifier(s), which an employer would never see: ${uuids[0]}`);
  }
  for (const id of knownEvidenceIds) {
    if (id && serialized.includes(id)) {
      throw new Error(`the screening packet contains the evidence id ${id}`);
    }
  }
  for (const banned of ["sources", "evidenceIds", "row_id", "provenance", "rejected", "grounding"]) {
    if (new RegExp(`"${banned}"\\s*:`).test(serialized)) {
      throw new Error(`the screening packet contains a "${banned}" field, which belongs to the evidence system and not to the employer's view`);
    }
  }
}

/** The packet as text, which is what the evaluator actually reads. */
export function renderPacket(packet: ScreeningPacket): string {
  const p = packet;
  const lines: string[] = [
    `POSTING: ${p.job.title} at ${p.job.company}`,
    "",
    "WHAT THE POSTING ASKS FOR:",
    ...p.job.requirements.map((r, i) => `  ${i + 1}. [${r.hardness}] ${r.text}`),
  ];
  if (p.job.description) lines.push("", "POSTING TEXT:", p.job.description);

  lines.push("", "THE RESUME AS SUBMITTED:", "", p.resume.name, p.resume.location, "", p.resume.summary, "");
  for (const r of p.resume.roles) {
    lines.push(`${r.title}`, `${r.employer}${r.location ? `, ${r.location}` : ""} | ${r.start.slice(0, 4)} to ${r.end ? r.end.slice(0, 4) : "present"}`);
    for (const b of r.bullets) lines.push(`  - ${b}`);
    lines.push("");
  }
  if (p.resume.skills.length) {
    lines.push("CAPABILITIES:");
    for (const g of p.resume.skills) lines.push(`  ${g.label}: ${g.skills.join(", ")}`);
    lines.push("");
  }
  for (const pr of p.resume.projects) lines.push(`${pr.name}`, `  ${pr.description}`, "");
  if (p.resume.education.length) {
    lines.push("EDUCATION:");
    for (const e of p.resume.education) lines.push(`  ${e.credential}${e.field ? ` ${e.field}` : ""}, ${e.institution}`);
  }
  return lines.join("\n");
}
