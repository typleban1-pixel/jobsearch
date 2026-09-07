/**
 * Assembling one application.
 *
 * Nothing here submits anything, and nothing here decides anything is
 * good enough. Preparation produces an artifact for a person to read:
 * a tailored resume whose every line cites frozen evidence, and a field
 * list where each entry is either answered with its provenance attached
 * or blocked with the reason stated in a sentence.
 *
 * The job posting is frozen at preparation time. If the employer edits
 * the posting afterwards, the review screen says so rather than quietly
 * applying to text nobody read.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { monthIndexOf } from "../scoring/experienceDuration.ts";
import { resolveField, shouldSkip, type BankedAnswer, type BankProvenance,
         type FormField, type ResolveContext, type ResolvedField } from "./answer.ts";
import { loadRecallStore } from "../feedback/store.ts";
import { reconcileAnswers, type ExistingAnswer } from "./reconcile.ts";
import { matchIntent, isResumeUploadField, ASHBY_RESUME_KEY } from "./intents.ts";
import { classifyOpenEnded } from "./openEnded.ts";
import { composeGroundedAnswer } from "../llm/composeAnswer.ts";
import { resolveFollowUps } from "./followUp.ts";
import { snapshotForm } from "./formSnapshot.ts";
import { tailorBullets, type BulletSource } from "../render/tailor.ts";
import { evidenceTextOf, provenanceStatements } from "../render/evidenceText.ts";
import { classifyRequirement } from "../scoring/requirementClass.ts";
import { composeResume, type ResumeDoc } from "../render/resume.ts";
import { isRecruiterFacing, assertRecruiterFacing } from "../render/languageQuality.ts";
import { selectSummary } from "../render/summary.ts";
import { assembleTailoredDoc, dropSummarySentencesDuplicatedInBullets,
  selectCapabilities } from "../render/tailoredDoc.ts";
import { implementationState } from "../render/projectEvidence.ts";
import { auditClaim, type CitedSource } from "../render/provenance.ts";
import { headerLocation } from "../render/location.ts";
import { renderAndStore } from "../render/artifact.ts";
import { GROUNDING_VERSION } from "../render/grounding.ts";
import type { LlmProvider } from "../llm/provider.ts";
import { CANDIDACY_MODEL_VERSION, mayPrepare, type Verdict } from "../scoring/candidacy.ts";
import { TAXONOMY_VERSION } from "../scoring/requirementClass.ts";
import { FIT_FORMULA_VERSION } from "../scoring/fit.ts";

export const PREPARE_VERSION = 1;

export interface PrepareResult {
  applicationId: string | null;
  status: string;
  /** Why preparation could not run at all. */
  refusedReason?: string;
  fields: ResolvedField[];
  blocked: number;
  answered: number;
  skipped: number;
  resumeId: string | null;
  tailoring: {
    accepted: number; rejected: number; fellBack: number;
    /** The exact document approval will bind to. */
    artifactSha256?: string; pages?: number;
  };
}

async function paged<T>(db: SupabaseClient, table: string, cols: string, f: (q: any) => any, order = "id"): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(table).select(cols)).order(order).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if ((data as T[]).length < 1000) break;
  }
  return out;
}

/**
 * The role, as a short list of themes.
 *
 * Never the posting's own prose. A model handed the job description
 * reaches for its vocabulary, and that vocabulary is the employer's
 * claim about the job, not evidence about the candidate.
 *
 * Which requirements become themes is a classification question, and
 * the classification is COMPUTED rather than read. job_requirements has
 * a requirement_class column, added by migration 0015, and nothing has
 * ever written to it: it is null on all 24,525 rows of all 1,769 jobs,
 * as are concept and taxonomy_version. Scoring classifies in memory at
 * the point of use. This filtered on the stored column, so it matched
 * nothing, for every job, always, and every tailored resume so far was
 * selected against a title and no themes at all.
 *
 * Classifying here, with the same function scoring uses, is the fix.
 * The original design was right about WHAT belongs in a theme set and
 * wrong only about where to get it: 78% of requirements classify SKILL,
 * and the rest are the things that must never steer a resume. A degree
 * requirement, a work-authorization constraint, a licence, "self-
 * starter" and "communication" describe who may apply, not what the
 * work is, and a bullet selected for matching them would be selected
 * for matching nothing.
 */
export interface RoleThemes {
  /** What the writer and the relevance scorer are given. */
  context: string;
  terms: string[];
  /** For diagnostics: how many requirements existed, and why terms were dropped. */
  requirementCount: number;
  excludedByClass: Record<string, number>;
  /** True when the posting genuinely offers nothing to select against. */
  themeless: boolean;
}

/**
 * Conditions of employment that classify as SKILL but are not work.
 *
 * "Chicago hybrid onsite requirement" and "Modesto, CA residency or
 * relocation" describe where and when a person must be, not what they
 * would do, and a bullet chosen for matching one of them was chosen for
 * matching nothing. The classifier does not separate these because
 * scoring has a legitimate use for them, and changing it would move Fit
 * scores across the whole corpus for a resume-selection reason. So the
 * exclusion lives here, where only theme selection sees it.
 *
 * Measured at 2.2% of SKILL-classified terms, 424 of 19,160.
 */
const ADMINISTRATIVE_CONDITION = /\b(?:onsite|on-site|in-office|in-person|hybrid|remote work|relocat|residency|commut|visa|sponsorship|work authorization|authorized to work|clearance|days? (?:a|per) week|per week|shift work|weekend|overtime|salary|compensation|pay range|drug (?:test|screen)|background check|valid driver)/i;

export async function roleThemes(db: SupabaseClient, jobId: string, title: string): Promise<RoleThemes> {
  const reqs = await paged<any>(db, "job_requirements", "normalized_term,raw_text,is_hard_requirement",
    (q) => q.eq("job_id", jobId));
  return themesFrom(reqs, title);
}

/**
 * The same computation, over requirements already in hand.
 *
 * Exists so an analysis over the whole job corpus can load every
 * requirement once instead of making one round trip per posting, and
 * still be running the identical selection rather than a copy of it.
 */
export function themesFrom(reqs: any[], title: string): RoleThemes {
  const siblings = reqs.map((r) => String(r.normalized_term ?? ""));
  const excludedByClass: Record<string, number> = {};
  const terms: string[] = [];

  for (const r of reqs) {
    const term = String(r.normalized_term ?? "").trim();
    if (!term) continue;
    const cls = classifyRequirement(String(r.raw_text ?? ""), term, siblings).requirementClass;
    if (cls !== "SKILL") { excludedByClass[cls] = (excludedByClass[cls] ?? 0) + 1; continue; }
    if (ADMINISTRATIVE_CONDITION.test(term) || ADMINISTRATIVE_CONDITION.test(String(r.raw_text ?? ""))) {
      excludedByClass["ADMINISTRATIVE"] = (excludedByClass["ADMINISTRATIVE"] ?? 0) + 1;
      continue;
    }
    if (!terms.includes(term)) terms.push(term);
  }

  const chosen = terms.slice(0, 12);
  return {
    context: chosen.length ? `${title}. Themes: ${chosen.join(", ")}.` : title,
    terms: chosen,
    requirementCount: reqs.length,
    excludedByClass,
    // A posting with requirements but no skill among them is a real
    // thing and is reported as such. A posting with no requirements at
    // all is a different thing and is also reported. Neither is allowed
    // to look like an ordinary run.
    themeless: chosen.length === 0,
  };
}

/**
 * The posting's own vocabulary, for the guard rather than the writer.
 *
 * roleContext above deliberately keeps the posting's prose away from the
 * model, and that is still right. It is not sufficient: the title and
 * the themes are enough for a writer to reach for the employer's words,
 * which is exactly how "professional workflows applicable to legal
 * operations" reached a resume whose evidence says "taught and mentored
 * 250+ students". So the guard is given everything the posting says,
 * including what the writer saw, and refuses any phrase that came from
 * here instead of from the evidence.
 */
async function targetVocabulary(db: SupabaseClient, jobId: string, title: string): Promise<string> {
  const reqs = await paged<any>(db, "job_requirements", "normalized_term,raw_text",
    (q) => q.eq("job_id", jobId));
  const words = reqs.flatMap((r) => [r.normalized_term, r.raw_text]).filter(Boolean);
  return [title, ...words].join(". ");
}

/**
 * Preparation runs on the machine that holds the model key, never in the
 * portal.
 *
 * The deployed portal has a publishable Supabase key and nothing else:
 * no service role, no Anthropic key. So "apply to this" from a job card
 * creates a DRAFT application and stops. The worker picks the DRAFT up,
 * snapshots the form, tailors the resume and maps the questions. That
 * split is a credential boundary, not a convenience.
 */
/**
 * A deliberate bypass of the candidacy gate.
 *
 * Never a default and never implied. Passing this records a row in
 * candidacy_overrides naming who asked and why, and the job is still not
 * a candidate: the override says a person decided to proceed anyway.
 */
export interface CandidacyOverride { invokedBy: string; reason: string }

export interface PrepareOptions {
  /** Complete an existing DRAFT rather than creating one. */
  existingApplicationId?: string;
  override?: CandidacyOverride;
  /**
   * Snapshot a provider whose form is only available in a browser.
   *
   * Injected rather than imported so this module stays free of
   * Playwright: the deployed portal calls preparation code paths and must
   * never pull a browser into its bundle. Providers that publish their
   * form never reach this.
   */
  liveSnapshot?: (job: { source: string; applyUrl: string | null; reviewedOffice: string | null }) => Promise<{
    ok: boolean; reason?: string; snapshot?: unknown; hash?: string;
    offices?: Array<{ value: string; label: string }>;
    officeQuestion?: { key: string; label: string; options: string[] };
  }>;
}

/**
 * The candidacy gate, fail-closed.
 *
 * Every path that is not an explicit pass refuses: a missing verdict, a
 * verdict computed against a different profile or formula, REJECT, and
 * MANUAL_REVIEW all stop here. Before this existed, any job id reaching
 * this function became an application, which is how a posting whose
 * central requirement is legal-operations experience became one.
 *
 * Staleness is version equality, not a timestamp. A verdict describes
 * the truth and scoring state that produced it; when that state moves,
 * the verdict is not wrong, it is about something else.
 */
async function checkCandidacy(db: SupabaseClient, jobId: string): Promise<
  { ok: true; verdict: Verdict; id: string } | { ok: false; refusedReason: string; verdict: Verdict | null; id: string | null }
> {
  // Eligibility first, and independently of the verdict.
  //
  // A candidacy row outlives the assessment that produced it. Home Chef
  // was scored, judged APPLICATION_CANDIDATE and prepared while its
  // published $60,000-$75,000 range went unread; when the range was
  // finally parsed the job became INELIGIBLE and its score was retired,
  // but the candidacy row still said APPLICATION_CANDIDATE and this gate
  // would have let it through again. Candidacy answers "is he a
  // plausible applicant", which is not the same question as "may he
  // apply at all", and the second one has to be asked here.
  const { data: job } = await db.from("jobs")
    .select("status,eligibility,eligibility_reason").eq("id", jobId).maybeSingle();
  if (job && (job.status !== "OPEN" || job.eligibility !== "ELIGIBLE")) {
    return { ok: false, verdict: null, id: null,
      refusedReason: job.eligibility !== "ELIGIBLE"
        ? `the job is ${job.eligibility}${job.eligibility_reason ? ` (${job.eligibility_reason})` : ""}, `
          + "so no candidacy verdict permits an application"
        : `the job is ${job.status} rather than OPEN` };
  }

  const { data: prof } = await db.from("profile").select("profile_version").single();
  const { data: rows } = await db.from("job_candidacy")
    .select("id,verdict,profile_version,formula_version,taxonomy_version,model_version,reason_codes,reason")
    .eq("job_id", jobId).order("created_at", { ascending: false }).limit(20);
  const all = rows ?? [];
  if (!all.length) {
    return { ok: false, verdict: null, id: null,
      refusedReason: "candidacy has never been assessed for this job; score it before preparing an application" };
  }
  const current = all.find((r: any) => r.profile_version === prof?.profile_version
    && r.formula_version === FIT_FORMULA_VERSION && r.taxonomy_version === TAXONOMY_VERSION
    && r.model_version === CANDIDACY_MODEL_VERSION);
  if (!current) {
    const newest = all[0]!;
    return { ok: false, verdict: newest.verdict as Verdict, id: newest.id,
      refusedReason: `the candidacy verdict is stale: it was computed against profile v${newest.profile_version}, `
        + `formula ${newest.formula_version}, taxonomy ${newest.taxonomy_version}, model ${newest.model_version}, `
        + `and the current state is profile v${prof?.profile_version}, formula ${FIT_FORMULA_VERSION}, `
        + `taxonomy ${TAXONOMY_VERSION}, model ${CANDIDACY_MODEL_VERSION}. Rescore before preparing.` };
  }
  if (mayPrepare(current.verdict as Verdict)) return { ok: true, verdict: current.verdict as Verdict, id: current.id };
  // Say what the verdict actually rests on. MANUAL_REVIEW covers an
  // unassessed posting, an unresolved role-defining requirement and a
  // posting with nothing to discriminate on, and "gating credential" was
  // true of only one of those.
  const codes: string[] = ((current as any).reason_codes ?? []) as string[];
  const reason = (current as any).reason ? `: ${(current as any).reason}` : "";
  return { ok: false, verdict: current.verdict as Verdict, id: current.id,
    refusedReason: current.verdict === "MANUAL_REVIEW"
      ? `candidacy is MANUAL_REVIEW (${codes.join(", ") || "no reason code"})${reason}; a person decides before this can proceed`
      : "candidacy is REJECT for this job" };
}

export async function prepareApplication(
  db: SupabaseClient,
  jobId: string,
  llm: LlmProvider | null,
  opts: PrepareOptions | string = {},
): Promise<PrepareResult> {
  // The old signature passed the draft id positionally.
  const options: PrepareOptions = typeof opts === "string" ? { existingApplicationId: opts } : opts;
  const existingApplicationId = options.existingApplicationId;
  const empty: PrepareResult = { applicationId: null, status: "NOT_PREPARED", fields: [], blocked: 0, answered: 0, skipped: 0, resumeId: null, tailoring: { accepted: 0, rejected: 0, fellBack: 0 } };

  const gate = await checkCandidacy(db, jobId);
  if (!gate.ok) {
    if (!options.override) return { ...empty, refusedReason: gate.refusedReason };
    // Proceeding anyway. The row below is the audit trail, and it is
    // written BEFORE any work happens so a bypass cannot be silent even
    // if preparation then fails.
    await db.from("candidacy_overrides").insert({
      job_id: jobId, overridden_verdict: gate.verdict, candidacy_id: gate.id,
      invoked_by: options.override.invokedBy, reason: options.override.reason,
    });
  }

  const { data: job, error: jobErr } = await db
    .from("jobs")
    .select("id,source,external_id,title,company_id,canonical_opening_id,apply_url,application_form_url")
    .eq("id", jobId).single();
  if (jobErr || !job) return { ...empty, refusedReason: `job not found: ${jobErr?.message ?? jobId}` };

  const { data: version } = await db
    .from("job_versions").select("id,title,city,state,metro,remote_policy").eq("job_id", jobId).eq("is_current", true).single();
  if (!version) return { ...empty, refusedReason: "this job has no current version to freeze" };

  const { data: company } = await db
    .from("companies").select("id,name,ats_provider,ats_token").eq("id", job.company_id).single();

  // A second live application to the same requisition is a database
  // constraint, not a convention. Checking first only buys a readable
  // message instead of a constraint violation.
  if (job.canonical_opening_id && !existingApplicationId) {
    const { data: live } = await db.from("applications")
      .select("id,status").eq("canonical_opening_id", job.canonical_opening_id)
      .not("status", "in", "(REJECTED,WITHDRAWN,ABANDONED)").limit(1);
    if (live?.length) return { ...empty, refusedReason: `application ${live[0]!.id} is already live for this opening (${live[0]!.status})` };
  }

  // 1. The form. No snapshot, no preparation.
  //
  // Providers that publish their form are read over the API. Lever does
  // not publish one, so preparation opens the page and snapshots what
  // the deterministic setup produces. Approval then binds to that, which
  // keeps the invariant: the questions approved are the questions the
  // system may answer and submit against.
  let snap = await snapshotForm(job.source, company?.ats_token ?? null, job.external_id);
  if (!snap.ok && options.liveSnapshot) {
    // An office already chosen for THIS application, if one has been.
    // Read from the answers rather than from a profile field, because it
    // is a fact about this application and must never generalize.
    const { data: officeAnswer } = existingApplicationId
      ? await db.from("application_answers").select("answer_text")
          .eq("application_id", existingApplicationId)
          .in("field_key", ["opportunityLocationId", "opportunityLocationIds"])
          .maybeSingle()
      : { data: null };

    const live = await options.liveSnapshot({
      source: job.source,
      applyUrl: job.application_form_url ?? job.apply_url ?? null,
      reviewedOffice: officeAnswer?.answer_text ?? null,
    });
    if (!live.ok) {
      // Fail closed, and say what a person would have to decide.
      const offices = live.offices?.length
        ? ` Offices offered: ${live.offices.map((o) => o.label).join(" / ")}.`
        : "";
      return { ...empty, refusedReason: `${live.reason ?? "the live form could not be snapshotted"}.${offices}` };
    }
    snap = { ok: true, snapshot: live.snapshot as any, hash: live.hash! };
  }
  if (!snap.ok) return { ...empty, refusedReason: snap.reason };

  // 2. The application itself, with the posting frozen to this version.
  let app: { id: string } | null = null;
  let appErr: { message: string } | null = null;
  if (existingApplicationId) {
    const { data, error } = await db.from("applications")
      .update({ form_snapshot: snap.snapshot as any, form_snapshot_hash: snap.hash,
                prepared_at: new Date().toISOString() })
      .eq("id", existingApplicationId).select("id").single();
    app = data; appErr = error;
  } else {
    const inserted = await db.from("applications").insert({
      job_id: job.id,
      job_version_id: version.id,
      canonical_opening_id: job.canonical_opening_id,
      status: "DRAFT",
      submission_mode: "ASSISTED",
      form_snapshot: snap.snapshot as any,
      form_snapshot_hash: snap.hash,
      prepared_at: new Date().toISOString(),
    }).select("id").single();
    app = inserted.data; appErr = inserted.error;
  }
  if (appErr || !app) return { ...empty, refusedReason: `could not create the application: ${appErr?.message}` };
  await db.from("applications").update({ status: "PREPARING" }).eq("id", app.id);

  // Re-preparing replaces the previous mapping rather than adding to it.
  //
  // Read before anything is destroyed, for two reasons. The human
  // answers in here are carried across where the question has not
  // materially changed, and the whole set is the restore point if the
  // new answers fail to land.
  const { data: priorRows } = await db.from("application_answers")
    .select("*").eq("application_id", app.id);
  const prior: ExistingAnswer[] = (priorRows ?? []).map((r: any) => ({
    id: r.id, fieldKey: r.field_key, fieldLabel: r.field_label, questionText: r.question_text,
    answerText: r.answer_text, confidenceState: r.confidence_state, provenance: r.provenance,
    evidenceIds: r.evidence_ids ?? [], promoteToBank: r.promote_to_bank, questionBankId: r.question_bank_id,
  }));

  // 3. The tailored resume. Every line still has to pass the same guards
  //    the master resume passes; failures fall back to master wording.
  const tailoring = await buildTailoredResume(db, app.id, job, version, llm);

  // The provenance gate fails the whole preparation rather than shipping
  // a resume that is missing a claim whose evidence is still on file as
  // though it had been used. A person decides what to do about the
  // sentence; nothing here decides it quietly.
  if (tailoring.provenanceFailure) {
    await db.from("applications").update({ status: "DRAFT" }).eq("id", app.id);
    return { ...empty, applicationId: app.id, refusedReason: `provenance gate: ${tailoring.provenanceFailure}` };
  }

  // 4. The fields.
  const ctx = await loadContext(db);
  ctx.application = await applicationScope(db, jobId).catch(() => undefined);
  const fields = (snap.snapshot.fields as FormField[]);
  let resolved: ResolvedField[] = [];
  let skipped = 0;

  for (const field of fields) {
    if (shouldSkip(field)) { skipped++; continue; }
    // The resume field is answered by the artifact, not by a lookup. Bound
    // by label OR Ashby's exact `_systemfield_resume` key (defense-in-depth),
    // always to THIS application's own tailored resume artifact.
    if (isResumeUploadField(field)) {
      resolved.push({
        field, intentKey: "resume_upload",
        matchedBy: field.key === ASHBY_RESUME_KEY ? "key:_systemfield_resume" : "pattern:resume_upload",
        answer: tailoring.resumeId ? "the tailored resume prepared for this application" : null,
        confidence: tailoring.resumeId ? "DERIVED" : "BLOCKED",
        blockKind: tailoring.resumeId ? null : "UNKNOWN",
        blockedReason: tailoring.resumeId ? null : "no tailored resume was produced",
        evidenceIds: tailoring.resumeId ? [tailoring.resumeId] : [],
        considered: [], refused: false,
      });
      continue;
    }
    resolved.push(resolveField(field, ctx));
  }

  // 4a. Conditional follow-ups ("If yes, please enter your position title
  //     and dates"). Not applicable when the answer above rules them out:
  //     blanked, derived from that answer. Otherwise still a question, now
  //     carrying the parent question and its answer so it can be read.
  resolved = resolveFollowUps(fields, resolved).resolved;

  // 4a-bis. Open-ended questions the deterministic resolver blocked, that
  // can be answered from evidence: PERSONALITY/interest (from HUMAN_CONFIRMED
  // personality facts) and GROUNDED_OPEN_ENDED motivation/experience (from
  // verified evidence). Composed once, grounding-checked, or left blocked. A
  // question that needs a genuinely new fact stays blocked. Needs the model,
  // so it only runs when one is available.
  if (llm) {
    await composeOpenEndedAnswers(db, llm, resolved, ctx, job, version);
  }

  // 4b. Carry human work across. A person's answer to a question that
  //     has not materially changed is not regenerated, and one to a
  //     question that HAS changed is not silently reused either: it goes
  //     to the log below and the field blocks.
  const reconciled = reconcileAnswers(resolved, prior);
  resolved = reconciled.resolved;

  // 5. Write them. A blocked field carries its reason and what was
  //    considered, because "answer this" is less useful than "answer
  //    this, and here is what you already said that is nearby".
  const rows = resolved.map((r) => ({
    application_id: app.id,
    question_text: r.field.label,
    answer_text: r.answer,
    category: categoryOf(r),
    provenance: provenanceOf(r),
    field_key: r.field.key,
    field_label: r.field.label,
    is_required: r.field.required,
    confidence_state: r.confidence,
    block_kind: r.blockKind,
    blocked_reason: r.blockedReason,
    evidence_ids: r.evidenceIds,
    considered_evidence: r.considered as any,
    resolved_at: r.confidence === "BLOCKED" ? null : new Date().toISOString(),
  }));
  // The replacement is ordered so that a failure costs nothing.
  //
  // PostgREST cannot open a transaction, so the delete and the insert
  // cannot be made one statement. What can be done is to delete only
  // once the new set exists and has been checked, and to put the old set
  // back if the new one is refused. The window where an application has
  // no answers is the round trip between these two calls, and if the
  // insert fails the restore closes it.
  if (rows.length) {
    await db.from("application_answers").delete().eq("application_id", app.id);
    const { error } = await db.from("application_answers").insert(rows);
    if (error) {
      const restored = await restorePriorAnswers(db, app.id, priorRows ?? []);
      // Whatever happened, this application is not mid-preparation any
      // more, and leaving it in PREPARING strands it in a state nothing
      // resumes from and nothing reports. BLOCKED_NEEDS_INPUT is where
      // it actually is, and a later run can legally leave it again.
      await db.from("applications").update({ status: "BLOCKED_NEEDS_INPUT" })
        .eq("id", app.id).eq("status", "PREPARING");
      await db.from("application_events").insert({
        application_id: app.id, event: "PREPARATION_FAILED",
        detail: `the new answers were refused (${error.message}); `
          + (restored.ok
            ? `the previous ${restored.count} answers were put back and nothing was lost`
            : `THE PREVIOUS ANSWERS COULD NOT BE PUT BACK (${restored.why}) and must be re-entered`),
        actor: "system",
      });
      return { ...empty, applicationId: app.id, status: "BLOCKED_NEEDS_INPUT",
        refusedReason: `could not write answers: ${error.message}`
          + (restored.ok ? "; the previous answers were restored" : `; RESTORE ALSO FAILED: ${restored.why}`) };
    }

    // What a person had typed, and what became of it. Written after the
    // answers land so the log never describes a state that was rolled
    // back.
    for (const d of reconciled.dropped) {
      await db.from("application_events").insert({
        application_id: app.id, event: "HUMAN_ANSWER_NOT_CARRIED",
        detail: `"${d.old.questionText ?? d.old.fieldLabel}" was answered ${JSON.stringify(d.old.answerText)}`
          + ` and was not carried forward: ${d.because}`,
        actor: "system",
      });
    }
    if (reconciled.carried.length) {
      await db.from("application_events").insert({
        application_id: app.id, event: "HUMAN_ANSWERS_CARRIED",
        detail: `${reconciled.carried.length} answer${reconciled.carried.length === 1 ? "" : "s"} you gave `
          + `${reconciled.carried.length === 1 ? "was" : "were"} kept: `
          + reconciled.carried.map((c) => c.field.label).join("; "),
        actor: "system",
      });
    }
  }

  // 6. Where it lands. The trigger has already recomputed
  //    all_fields_confident from the rows just written.
  const blocked = resolved.filter((r) => r.confidence === "BLOCKED").length;
  const status = blocked > 0 ? "BLOCKED_NEEDS_INPUT" : "AWAITING_REVIEW";
  await db.from("applications").update({ status }).eq("id", app.id);

  return {
    applicationId: app.id, status, fields: resolved,
    blocked, answered: resolved.length - blocked, skipped,
    resumeId: tailoring.resumeId,
    tailoring: { accepted: tailoring.accepted, rejected: tailoring.rejected,
      fellBack: tailoring.fellBack, artifactSha256: tailoring.artifactSha256, pages: tailoring.pages },
  };
}

export function categoryOf(r: ResolvedField): string {
  // A generic low-stakes survey answer is its own category, whatever
  // intent the wording happened to match; it is not the sensitive
  // question the catalog might otherwise classify it as.
  if (r.confidence === "LOW_STAKES_SURVEY") return "F_LOW_STAKES_SURVEY";
  // A grounded, AI-drafted open-ended answer is category C by definition.
  if (r.confidence === "AI_DRAFTED_GROUNDED") return "C_AI_DRAFTED_GROUNDED";
  const intent = r.intentKey ? matchIntent(r.field.label).intent : null;
  return intent?.category ?? "E_UNKNOWN";
}

export function provenanceOf(r: ResolvedField): string {
  switch (r.confidence) {
    case "VERIFIED": return "PROFILE";
    case "DERIVED": return "CALCULATED";
    case "HUMAN_CONFIRMED": return "USER_RESPONSE";
    // Not evidence about the person: a generic answer to a non-substantive
    // survey question, recorded as such rather than disguised as a
    // profile-, calculation- or user-sourced value.
    case "LOW_STAKES_SURVEY": return "GENERIC_SURVEY";
    // Composed from verified/human-confirmed evidence and grounding-checked.
    case "AI_DRAFTED_GROUNDED": return "AI_DRAFT_FROM_VERIFIED_EVIDENCE";
    default: return "USER_RESPONSE";
  }
}

/** HUMAN_CONFIRMED personality/interest facts, with their scope limits. */
async function loadPersonalityFacts(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from("evidence").select("summary,detail").contains("tags", ["PERSONALITY"]);
  return (data ?? []).map((e: any) => e.detail ? `${e.summary} (${e.detail})` : e.summary);
}

/**
 * Verified evidence as plain fact strings, from the frozen profile version
 * the master resume was cut from -- the same rows the resume grounding
 * trusts. Trimmed and capped so a grounded draft has real material without
 * an unbounded prompt.
 */
async function buildGroundedFacts(
  db: SupabaseClient, job: any, version: any,
): Promise<{ facts: string[]; jobContext: { title: string | null; company: string | null; description: string | null } }> {
  const { data: master } = await db.from("resumes").select("label").eq("is_master", true).maybeSingle();
  const pv = Number(String(master?.label ?? "").match(/profile version (\d+)/)?.[1] ?? 0);
  const rows = await paged<any>(db, "profile_version_rows", "source_table,row_data",
    (q) => q.eq("profile_version", pv), "row_id");
  const WANT = new Set(["profile", "employment_records", "projects", "education", "skills", "metrics", "evidence"]);
  const facts: string[] = [];
  let skills = 0;
  for (const r of rows) {
    if (!WANT.has(r.source_table)) continue;
    // A verified skills list is long; a compact sample is enough context.
    if (r.source_table === "skills" && skills++ >= 25) continue;
    const t = evidenceTextOf(r.source_table, r.row_data);
    if (t) facts.push(t.length > 300 ? t.slice(0, 300) + "…" : t);
  }
  const { data: co } = await db.from("companies").select("name").eq("id", job.company_id).maybeSingle();
  const { data: d } = await db.from("job_descriptions").select("description_text").eq("job_id", job.id).maybeSingle();
  const description = d?.description_text ? String(d.description_text).slice(0, 1600) : null;
  return { facts, jobContext: { title: version?.title ?? job.title ?? null, company: co?.name ?? null, description } };
}

/**
 * Answer the open-ended questions the deterministic resolver blocked but
 * evidence can support, in place. PERSONALITY from the personality facts,
 * GROUNDED_OPEN_ENDED from verified evidence; NEW_FACT_REQUIRED and
 * everything else stay exactly as the resolver left them. Each composed
 * answer is grounding-checked inside composeGroundedAnswer and only replaces
 * a BLOCKED field if it passed.
 */
async function composeOpenEndedAnswers(
  db: SupabaseClient, llm: LlmProvider, resolved: ResolvedField[],
  ctx: ResolveContext, job: any, version: any,
): Promise<void> {
  const candidates = resolved
    .map((r, i) => ({ r, i, cls: classifyOpenEnded(r.field.label, r.field.type, r.field.key) }))
    .filter((c) => c.r.confidence === "BLOCKED" && !c.r.refused
      && (c.cls.kind === "PERSONALITY" || c.cls.kind === "GROUNDED_OPEN_ENDED"));
  if (!candidates.length) return;

  const personality = candidates.some((c) => c.cls.kind === "PERSONALITY") ? await loadPersonalityFacts(db) : [];
  const grounded = candidates.some((c) => c.cls.kind === "GROUNDED_OPEN_ENDED")
    ? await buildGroundedFacts(db, job, version) : { facts: [], jobContext: { title: null, company: null, description: null } };
  const applicantName = [ctx.profile?.legal_first_name, ctx.profile?.legal_last_name].filter(Boolean).join(" ") || undefined;

  for (const c of candidates) {
    const isPersonality = c.cls.kind === "PERSONALITY";
    // One question's draft failing (the model ran past its output limit,
    // the API refused) leaves THAT field blocked with the reason; it does
    // not abandon a preparation whose every other field is answered.
    const res = await composeGroundedAnswer({
      llm, question: c.r.field.label, kind: c.cls.kind as "PERSONALITY" | "GROUNDED_OPEN_ENDED",
      facts: isPersonality ? personality : grounded.facts,
      charLimit: null, applicantName,
      jobContext: isPersonality ? undefined : grounded.jobContext,
    }).catch((e: Error) => ({ ok: false as const, answer: null, reason: `the model could not draft this answer: ${e.message.slice(0, 160)}`, usage: [] }));
    if (!res.ok) {
      resolved[c.i] = { ...c.r, blockedReason: `${c.r.blockedReason ?? "no rule produces an answer for this field"}. ${res.reason ?? ""}`.trim() };
    }
    if (res.ok && res.answer) {
      resolved[c.i] = {
        ...c.r, answer: res.answer, confidence: "AI_DRAFTED_GROUNDED",
        intentKey: isPersonality ? "personality_fun_fact" : "grounded_open_ended",
        matchedBy: `composed (${c.cls.kind}), grounding-checked`,
        blockKind: null, blockedReason: null, evidenceIds: [],
        considered: [{ rowId: null, what: `grounded answer composed from ${isPersonality ? "HUMAN_CONFIRMED personality facts" : "verified evidence"}`,
          whyRejected: "n/a: this is the accepted answer, verified to introduce no unsupported facts" }],
        refused: false,
      };
    }
    // else: leave the field BLOCKED with the resolver's original reason.
  }
}

/** The frozen rows an answer may rest on. */
/**
 * Puts an application's previous answers back after a failed write.
 *
 * The rows are re-inserted exactly as they were read, ids included, so
 * anything referring to an answer by id still refers to the same answer.
 * If this cannot be done the caller says so loudly rather than reporting
 * a tidy failure over a destroyed field list.
 */
async function restorePriorAnswers(
  db: SupabaseClient, applicationId: string, priorRows: any[],
): Promise<{ ok: true; count: number } | { ok: false; why: string }> {
  if (!priorRows.length) return { ok: true, count: 0 };
  await db.from("application_answers").delete().eq("application_id", applicationId);
  const { error } = await db.from("application_answers").insert(priorRows);
  return error ? { ok: false, why: error.message } : { ok: true, count: priorRows.length };
}

export async function loadContext(db: SupabaseClient): Promise<ResolveContext> {
  const { data: master } = await db.from("resumes").select("label").eq("is_master", true).single();
  const version = Number(String(master?.label ?? "").match(/profile version (\d+)/)?.[1] ?? 0);
  const rows = await paged<any>(db, "profile_version_rows", "row_id,source_table,row_data",
    (q) => q.eq("profile_version", version).eq("source_table", "profile"), "row_id");
  const profileRow = rows[0];
  if (!profileRow) throw new Error(`no frozen profile row in version ${version}`);

  // Only approved AND reusable answers. reuse_allowed defaults false, so
  // an answer given for one employer stays with that employer until the
  // user says otherwise.
  //
  // answer_provenance travels with the answer because it is what decides
  // the confidence the answer may be given at. Reading it here rather
  // than assuming one keeps the bank from laundering a self-declaration
  // into a verified fact simply by having been stored.
  const bank = new Map<string, BankedAnswer>();
  const banked = await paged<any>(db, "question_bank", "intent_key,approved_answer,evidence_ids,reuse_allowed,answer_provenance",
    (q) => q.eq("reuse_allowed", true).not("approved_answer", "is", null));
  for (const b of banked) bank.set(b.intent_key, {
    answer: b.approved_answer, evidenceIds: b.evidence_ids ?? [],
    provenance: (b.answer_provenance ?? null) as BankProvenance | null,
  });

  // Employment records back the current-role questions. Newest first so
  // "most recent" is unambiguous even before is_current is consulted.
  const empRows = await paged<any>(db, "profile_version_rows", "row_id,source_table,row_data",
    (q) => q.eq("profile_version", version).eq("source_table", "employment_records"), "row_id");
  const employment = empRows
    .map((r) => ({
      rowId: r.row_id, employer: r.row_data.employer,
      // Employer-facing answers use the employer-facing title, matching
      // the resume (display_title ?? actual_title), so a form's "current
      // title" field and the resume never disagree.
      title: r.row_data.display_title ?? r.row_data.actual_title ?? null,
      isCurrent: Boolean(r.row_data.is_current), start: r.row_data.start_month ?? null,
      end: r.row_data.end_month ?? null, status: r.row_data.status ?? null,
      actualTitle: r.row_data.actual_title ?? null,
    }))
    .sort((a, b) => String(b.start ?? "").localeCompare(String(a.start ?? "")));

  // Education records back "school" / "degree" / "highest education"
  // fields. Sorted most-recent first so [0] is the credential a single
  // such field wants (which, for this profile, is also the highest).
  const eduRows = await paged<any>(db, "profile_version_rows", "row_id,source_table,row_data",
    (q) => q.eq("profile_version", version).eq("source_table", "education"), "row_id");
  const education = eduRows
    .map((r) => ({
      rowId: r.row_id, institution: r.row_data.institution, credential: r.row_data.credential ?? null,
      fieldOfStudy: r.row_data.field_of_study ?? null, end: r.row_data.end_month ?? null,
      completed: Boolean(r.row_data.completed),
    }))
    .sort((a, b) => String(b.end ?? "").localeCompare(String(a.end ?? "")));

  // What earlier human corrections established. Absent tables mean an
  // empty store, which is exactly the behaviour before any of this
  // existed: the resolver simply has less to draw on.
  const learned = await loadRecallStore(db).catch(() => ({ mappings: [], contextual: [] }));

  const nowMonthIndex = monthIndexOf(new Date().toISOString());
  return { profileRowId: profileRow.row_id, profile: profileRow.row_data, bank, employment, education, learned, nowMonthIndex };
}

/**
 * The posting facts that scope what may be recalled.
 *
 * A confirmed answer about commuting to Chicago is usable here only if
 * "here" is Chicago, so the application has to say where it is before
 * anything can be reused for it.
 */
export async function applicationScope(db: SupabaseClient, jobId: string): Promise<ResolveContext["application"]> {
  const [{ data: version }, { data: job }, { data: card }, { data: cand }] = await Promise.all([
    db.from("job_versions").select("city,state,metro,remote_policy,salary_min,salary_max,salary_period")
      .eq("job_id", jobId).eq("is_current", true).single(),
    db.from("jobs").select("company_id").eq("id", jobId).single(),
    db.from("job_card_summary").select("match_score,match_provisional").eq("job_id", jobId).maybeSingle(),
    db.from("job_candidacy").select("verdict,hard_met,hard_total").eq("job_id", jobId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const { data: company } = job?.company_id
    ? await db.from("companies").select("name,ats_provider").eq("id", job.company_id).single()
    : { data: null };

  return {
    provider: company?.ats_provider ?? null,
    employer: company?.name ?? null,
    jobId,
    conditions: {
      locationCity: version?.city ?? null,
      locationState: version?.state ?? null,
      locationMetro: version?.metro ?? null,
      remotePolicy: version?.remote_policy ?? null,
    },
    // What the salary-expectation rule weighs: the posted range, the place,
    // and the current read of the match.
    posting: {
      salaryMin: version?.salary_min ?? null, salaryMax: version?.salary_max ?? null, salaryPeriod: version?.salary_period ?? null,
      remotePolicy: version?.remote_policy ?? null, metro: version?.metro ?? null,
      matchScore: card?.match_score ?? null, matchProvisional: Boolean(card?.match_provisional),
      candidacyVerdict: cand?.verdict ?? null, hardMet: cand?.hard_met ?? null, hardTotal: cand?.hard_total ?? null,
    },
  };
}

interface TailorOutcome {
  resumeId: string | null; accepted: number; rejected: number; fellBack: number;
  artifactSha256?: string; pages?: number; droppedForDensity?: number;
  /** Set when the provenance gate stopped preparation, and why. */
  provenanceFailure?: string;
  /** Rewrites the gate sent back to their master wording. */
  revertedForProvenance?: Array<{ from: string; to: string; why: string }>;
}

/**
 * The individual recorded statements a row holds.
 *
 * The provenance audit compares a claim against the statement it draws
 * on rather than the whole row, so that a qualifier attached to some
 * other responsibility in the same record is not read as a bound on this
 * sentence.
 */
export interface TailoredComposition {
  /** Absent only when there is no master resume to tailor from. */
  doc?: ResumeDoc;
  masterDoc?: ResumeDoc;
  masterResumeId?: string;
  profileVersion?: number;
  rows?: any[];
  themes?: RoleThemes;
  result?: Awaited<ReturnType<typeof tailorBullets>>;
  dropped?: Array<{ line: string; why: string }>;
  revertedForProvenance?: Array<{ from: string; to: string; why: string }>;
  /** Set when the provenance gate stopped composition, and why. */
  provenanceFailure?: string;
}

/**
 * Everything between the frozen profile and a finished ResumeDoc, with
 * no writes of any kind.
 *
 * Split out of buildTailoredResume so that a candidate can be generated
 * and audited without touching an application. The two callers must run
 * the identical path or the audit is measuring a different pipeline than
 * the one that produces real applications, which is exactly the drift
 * that made a stale diagnostic look authoritative.
 */
export interface RequirementInput {
  normalized_term?: string | null;
  raw_text?: string | null;
  is_hard_requirement?: string | null;
}
export interface ComposeInput {
  /** Normalized requirements, from a stored job OR extracted from pasted text. */
  requirements: RequirementInput[];
  /** The role title the resume is tailored to. */
  title: string;
  /** Posting location, used for the header line only. */
  location?: { city?: string | null; state?: string | null; metro?: string | null; remote_policy?: string | null };
  /**
   * The posting's own description, for the LAYOUT signals only (an AI or
   * startup posting leads with RentPup). Never fed to the model and never
   * used to choose capabilities: those come from the requirements.
   */
  postingText?: string | null;
}

/**
 * The one authoritative tailoring path.
 *
 * Normalized requirements + the frozen profile evidence -> aggressively
 * reframed, grounding-checked resume document. Both the application
 * pipeline and the standalone Resume Builder go through here, so a resume
 * built from a pasted posting is bounded by exactly the same evidence and
 * the same guards as one built from an ingested job. The ONLY thing that
 * differs is where `requirements` came from -- a job_requirements read or
 * a live extraction of pasted text. Everything below, from the master
 * claims to the provenance gate, is identical.
 */
export async function composeFromRequirements(
  db: SupabaseClient, input: ComposeInput, llm: LlmProvider | null,
  // Write-nothing preview seam: when supplied, tailor against these frozen
  // rows + master claims instead of the live is_master resume and its
  // profile_version. Used to render a PROPOSED truth without cutting a
  // version or touching the master. Production callers never pass it.
  preview?: { rows: any[]; profileVersion: number; claims: Array<{ claim: string; evidence_ids: string[] }> },
): Promise<TailoredComposition> {
  const title = input.title;
  const location = input.location ?? {};
  let master: { id: string; label: string };
  let profileVersion: number;
  let claims: Array<{ claim: string; evidence_ids: string[] }>;
  let rows: any[];
  if (preview) {
    master = { id: "preview", label: `Master resume, profile version ${preview.profileVersion}` };
    profileVersion = preview.profileVersion;
    claims = preview.claims;
    rows = preview.rows;
  } else {
    const { data: m } = await db.from("resumes").select("id,label,content").eq("is_master", true).single();
    if (!m) return {};
    master = m;
    profileVersion = Number(String(m.label).match(/profile version (\d+)/)?.[1] ?? 0);
    claims = await paged<any>(db, "resume_claims", "claim,evidence_ids", (q) => q.eq("resume_id", m.id));
    rows = await paged<any>(db, "profile_version_rows", "row_id,source_table,row_data",
      (q) => q.eq("profile_version", profileVersion), "row_id");
  }

  const text = new Map<string, string>();
  for (const r of rows) {
    const t = evidenceTextOf(r.source_table, r.row_data);
    if (t) text.set(r.row_id, t);
  }
  const metrics = rows.filter((r) => r.source_table === "metrics").map((r) => String(r.row_data.approved_wording));
  const entities = [
    ...rows.filter((r) => r.source_table === "employment_records").map((r) => r.row_data.employer),
    ...rows.filter((r) => r.source_table === "education").map((r) => r.row_data.institution),
    ...rows.filter((r) => r.source_table === "skills").map((r) => r.row_data.name),
    ...rows.filter((r) => r.source_table === "projects").map((r) => r.row_data.name),
  ].filter(Boolean) as string[];

  // A claim resting on evidence that declares itself paused, partial or
  // conditional may be stated in that evidence's own words or not at
  // all. Computed from the rows the claim cites rather than from where
  // the claim came from, so it holds for any future claim that touches
  // such a row, project or otherwise.
  const rowById = new Map(rows.map((r) => [r.row_id, r]));
  const fixedState = (ids: string[]): string | undefined => {
    for (const id of ids) {
      const row = rowById.get(id);
      if (!row) continue;
      const st = implementationState(row.row_data);
      if (st !== "CURRENT" && st !== "NONE") return st;
    }
    return undefined;
  };

  const sources: BulletSource[] = claims.map((c) => ({
    original: c.claim,
    evidence: (c.evidence_ids ?? [])
      .filter((id: string) => text.has(id))
      .map((id: string) => ({ id, text: text.get(id)!, kind: "frozen_row" })),
    implementationState: fixedState(c.evidence_ids ?? []),
  })).filter((s) => s.evidence.length > 0);

  const themes = themesFrom(input.requirements, title);
  const context = themes.context;
  if (themes.themeless) {
    // Visible, not silent. A resume selected against a title alone is
    // not tailored to anything, and the run says so rather than
    // producing a document that looks ordinary.
    console.warn(`[prepare] no themes for ${JSON.stringify(title)}: ${themes.requirementCount} requirement(s), `
      + `excluded by class ${JSON.stringify(themes.excludedByClass)}. `
      + "Selection will rank claims against the job title alone.");
  }
  // The posting's own vocabulary for the terminology guard: title plus
  // every requirement term, exactly as targetVocabulary joined them, but
  // from the requirements already in hand rather than a DB read by jobId.
  const targetText = [title, ...input.requirements.flatMap((r) => [r.normalized_term, r.raw_text]).filter(Boolean)].join(". ");
  // The whole frozen profile's text, so the terminology guard can tell
  // a word the candidate uses from a word the posting supplied. It
  // licenses vocabulary only: every other guard still judges a claim
  // against the rows it cites.
  const profileVocabulary = rows.map((r) => evidenceTextOf(r.source_table, r.row_data)).filter(Boolean).join(" ");
  const result = await tailorBullets(llm, sources, context,
    { approvedMetrics: metrics, knownEntities: entities, targetJobText: targetText, profileVocabulary });

  // The provenance gate, before anything is stored.
  //
  // Tailoring checks a rewrite against the evidence text it was handed.
  // This checks it against the rows it CITES, which is a different
  // question, and it caught a live rewrite the other guards accepted:
  // "Executed product development initiatives from concept through
  // implementation" introduced conducting and manufacturing, neither of
  // which its cited row contains.
  //
  // A rewrite that does not survive falls back to the master wording,
  // which was audited when the master was generated. If the master
  // wording does not survive either, preparation stops. It does not drop
  // the line: a resume quietly missing a claim, with the evidence still
  // recorded as if it were used, is a worse outcome than no resume.
  const auditSources: CitedSource[] = rows.map((r) => ({
    id: r.row_id,
    text: evidenceTextOf(r.source_table, r.row_data) ?? "",
    statements: provenanceStatements(r.row_data),
  }));
  const auditById = new Map(auditSources.map((a) => [a.id, a]));
  const masterEvidence = new Map(claims.map((c) => [c.claim, (c.evidence_ids ?? []) as string[]]));

  const vetted: typeof result.accepted = [];
  const revertedForProvenance: Array<{ from: string; to: string; why: string }> = [];
  for (const a of result.accepted) {
    const verdict = auditClaim({
      claim: a.text,
      cited: a.evidenceIds.map((id) => auditById.get(id)!).filter(Boolean),
      profile: auditSources,
    });
    if (verdict.verdict === "SUPPORTED") { vetted.push(a); continue; }

    const fallbackIds = masterEvidence.get(a.original) ?? a.evidenceIds;
    const fallback = auditClaim({
      claim: a.original,
      cited: fallbackIds.map((id) => auditById.get(id)!).filter(Boolean),
      profile: auditSources,
    });
    if (fallback.verdict !== "SUPPORTED") {
      return {
        provenanceFailure: `neither the tailored wording nor the master wording of ${JSON.stringify(a.original.slice(0, 60))} `
          + `is supported by the evidence it cites (${verdict.verdict} then ${fallback.verdict}: ${fallback.reason})`,
      };
    }
    revertedForProvenance.push({ from: a.text, to: a.original, why: `${verdict.verdict}: ${verdict.reason}` });
    vetted.push({ ...a, text: a.original, evidenceIds: fallbackIds, generation: "SELECTED" });
  }
  result.accepted = vetted;

  // Recruiter-language gate on the tailored bullets.
  //
  // The master composer (composeResume) guards its own lines, but the
  // tailored path selects and reframes verified EVIDENCE that never passed
  // that gate. That evidence is written for many purposes, some of it in
  // implementation language captured from a repository ("a scheduled job
  // recomputes obligation statuses ... spooled ... reported to the
  // operator"). It is legitimate evidence and stays in the truth store; it
  // must never become a résumé bullet. Provenance (above) only asks whether
  // a line is grounded -- an implementation bullet is perfectly grounded --
  // so it let engineering documentation onto the résumé. This drops any
  // tailored line that reads as internals, preferring the audited master
  // wording when it is recruiter-facing, and dropping the line otherwise: a
  // résumé missing one internal bullet is correct; jargon is not.
  const recruiterVetted: typeof vetted = [];
  const droppedForLanguage: string[] = [];
  for (const a of vetted) {
    if (isRecruiterFacing(a.text)) { recruiterVetted.push(a); continue; }
    if (a.text !== a.original && isRecruiterFacing(a.original)) {
      const ids = masterEvidence.get(a.original) ?? a.evidenceIds;
      const fb = auditClaim({ claim: a.original, cited: ids.map((id) => auditById.get(id)!).filter(Boolean), profile: auditSources });
      if (fb.verdict === "SUPPORTED") { recruiterVetted.push({ ...a, text: a.original, evidenceIds: ids, generation: "SELECTED" }); continue; }
    }
    droppedForLanguage.push(a.text);
  }
  result.accepted = recruiterVetted;

  // The document itself. Composed here so the candidate path and the
  // application path produce the same bytes from the same inputs.
  const { data: profileRow } = await db.from("profile")
    .select("legal_first_name,legal_last_name,preferred_name,city,state,relocation_destination_city,relocation_destination_state,relocation_destination_metro,relocation_is_definite,relocation_date")
    .single();
  const masterDoc = composeResume(
    rows.map((r) => ({ row_id: r.row_id, source_table: r.source_table, row_data: r.row_data })) as any,
    { first: profileRow!.legal_first_name, last: profileRow!.legal_last_name } as any,
    `${profileRow!.preferred_name ?? profileRow!.legal_first_name} ${profileRow!.legal_last_name}`,
  );
  // The scorer gets the themes themselves, not the context sentence cut
  // on punctuation: splitting "Themes: a, b, c." reintroduced the title
  // and the word "Themes" as if they were requirements.
  const contextTerms = themes.terms.length ? themes.terms : [title];
  // The posting's own words go along for the layout signals (an AI or
  // startup posting leads with RentPup); they take no part in which
  // capabilities are selected.
  const postingText = `${title}\n${String(input.postingText ?? "")}`;
  const { doc: assembled, dropped, summaryIncomplete } = assembleTailoredDoc(
    masterDoc,
    result.accepted.map((a) => ({ original: a.original, claim: a.text, evidenceIds: a.evidenceIds, generation: a.generation })),
    contextTerms, undefined, title, postingText,
  );

  // Removing verbatim repetition left nothing usable. Regenerating is the
  // correct answer; assembling replacement prose here would put wording on
  // a resume that no evidence produced.
  if (summaryIncomplete) {
    return { provenanceFailure: "the summary was left structurally incomplete after removing "
      + "sentences repeated verbatim in the experience bullets; regenerate rather than pad it" };
  }
  // The employer sees a narrower capability set than the profile holds.
  // Replacing it on the document means the renderer is never handed
  // anything it must not print.
  //
  // The header states where he is, and — only for a posting in the
  // market he is definitely moving to — that he is moving there. It is
  // never softened to "open to relocation" and never carries a date,
  // because no date is known.
  const summarySelection = selectSummary(
    rows.map((r) => ({ row_id: r.row_id, source_table: r.source_table, row_data: r.row_data })) as any,
    title,
    contextTerms,
  );

  const doc: ResumeDoc = {
    ...assembled,
    location: headerLocation(
      {
        city: profileRow!.city, state: profileRow!.state,
        destinationCity: profileRow!.relocation_destination_city,
        destinationState: profileRow!.relocation_destination_state,
        destinationMetro: profileRow!.relocation_destination_metro,
        relocationIsDefinite: profileRow!.relocation_is_definite,
        relocationDate: profileRow!.relocation_date,
      },
      {
        city: location.city, state: location.state, metro: location.metro,
        isRemote: location.remote_policy === "FULLY_REMOTE" || location.remote_policy === "REMOTE_WITH_TRAVEL",
      },
    ) || assembled.location,
    skillGroups: selectCapabilities(assembled, contextTerms, title),
    // The summary is chosen for this posting the same way the capability
    // list is. Structure is fixed; contents are not, so a marketing role
    // is not told about physical product development and a product role
    // is not told about video.
    summary: summarySelection.line,
  };

  // Verbatim repetition, checked against the summary that is actually
  // shipped.
  //
  // assembleTailoredDoc runs this too, but selectSummary above replaces
  // the summary afterwards, so the only check that matters is this one.
  // Popl's document passed the earlier check and still reached the
  // renderer with its final summary ending in a sentence stated word for
  // word as a bullet.
  const finalSummary = dropSummarySentencesDuplicatedInBullets(doc.summary, doc.roles, doc.projects);
  if (finalSummary.removed.length > 0) {
    for (const r of finalSummary.removed) {
      dropped.push({ line: r, why: "stated verbatim as an experience bullet; the bullet carries the evidence" });
    }
    if (finalSummary.incomplete) {
      return { provenanceFailure: "the summary was left structurally incomplete after removing "
        + "sentences repeated verbatim in the experience bullets; regenerate rather than pad it" };
    }
    doc.summary = finalSummary.summary;
  }

  // Final defensive gate, the same one composeResume applies to the master:
  // no assembled line -- summary, experience bullet or project line -- may
  // read as engineering documentation. The per-bullet filter above is the
  // primary defence; this makes a regression fail LOUDLY (as a provenance
  // failure the caller records and stops on) rather than silently shipping
  // internals, which is how a pre-guard artifact slipped through before.
  const asText = (v: any): string => typeof v === "string" ? v : (v && typeof v.text === "string" ? v.text : "");
  try {
    assertRecruiterFacing([
      { text: asText(doc.summary), where: "summary" },
      ...(doc.roles ?? []).flatMap((r: any) => (r.lines ?? []).map((l: any) => ({ text: asText(l), where: r.title ?? r.employer }))),
      ...(doc.projects ?? []).flatMap((p: any) => [
        { text: asText(p.line), where: p.name },
        ...(p.optional ?? []).map((l: any) => ({ text: asText(l), where: p.name })),
      ]),
    ].filter((l) => l.text));
  } catch (e) {
    return { provenanceFailure: `a tailored line read as engineering documentation rather than recruiter-facing prose: ${(e as Error).message}` };
  }

  return { doc, masterDoc, masterResumeId: master.id, profileVersion, rows, themes, result, dropped, revertedForProvenance };
}

/**
 * The application path's adapter: load this job's stored requirements and
 * compose. Unchanged for every existing caller (buildTailoredResume,
 * prepare-handoff) -- same signature, same behaviour -- it just now
 * routes through the shared composeFromRequirements so the Resume Builder
 * cannot drift from it.
 */
export async function composeTailoredResume(
  db: SupabaseClient, job: any, version: any, llm: LlmProvider | null,
): Promise<TailoredComposition> {
  const requirements = await paged<RequirementInput>(db, "job_requirements",
    "normalized_term,raw_text,is_hard_requirement", (q) => q.eq("job_id", job.id));
  const { data: desc } = await db.from("job_descriptions").select("description_text").eq("job_id", job.id).maybeSingle();
  return composeFromRequirements(db, {
    requirements,
    title: version.title ?? job.title,
    location: { city: version.city, state: version.state, metro: version.metro, remote_policy: version.remote_policy },
    postingText: version.description_text ?? desc?.description_text ?? null,
  }, llm);
}

/**
 * The application's tailored resume: composed, stored, rendered, linked.
 *
 * Every decision about CONTENT happens in composeTailoredResume. What
 * remains here is persistence, and it is the only part a candidate run
 * must not perform.
 */
export async function buildTailoredResume(
  db: SupabaseClient, applicationId: string, job: any, version: any, llm: LlmProvider | null,
): Promise<TailorOutcome> {
  const c = await composeTailoredResume(db, job, version, llm);
  if (c.provenanceFailure) {
    return { resumeId: null, accepted: 0, rejected: 0, fellBack: 0, provenanceFailure: c.provenanceFailure };
  }
  if (!c.doc || !c.result || !c.masterResumeId) return { resumeId: null, accepted: 0, rejected: 0, fellBack: 0 };
  const { doc, result, dropped = [], revertedForProvenance } = c;

  const { data: resume, error } = await db.from("resumes").insert({
    label: `Tailored for ${job.title}`,
    is_master: false,
    content: { lines: result.accepted.map((a) => a.text) } as any,
    tailored_for_job_id: job.id,
    tailored_for_job_version_id: version.id,
    derived_from: c.masterResumeId,
    tailoring_strategy: "REFRAME_WITHIN_CITED_EVIDENCE",
    grounding_version: GROUNDING_VERSION,
  }).select("id").single();
  if (error || !resume) return { resumeId: null, accepted: 0, rejected: 0, fellBack: 0 };

  // Accepted and rejected lines both persist. A rejected proposal is the
  // record of what the model tried and why it was refused, which is the
  // only way the guards can be argued with later.
  const claimRows = [
    ...result.accepted.map((a) => ({
      resume_id: resume.id, claim: a.text, evidence_ids: a.evidenceIds,
      source_text: a.sourceText, generation: a.generation,
      grounding_checks: { ok: true, checks: a.verdict.checks, version: GROUNDING_VERSION } as any,
    })),
    ...result.rejected.map((r) => ({
      resume_id: resume.id, claim: r.proposed, evidence_ids: r.evidenceIds,
      source_text: r.sourceText, generation: "REFRAMED",
      grounding_checks: { ok: false, failedCheck: r.failedCheck, detail: r.failureDetail, version: GROUNDING_VERSION } as any,
    })),
  ];
  if (claimRows.length) await db.from("resume_claims").insert(claimRows);
  await db.from("applications").update({ resume_id: resume.id }).eq("id", applicationId);

  // Rendered now and stored, because approval has to bind to an artifact
  // rather than to a description of one. Nothing re-renders at fill time.
  const rendered = await renderAndStore(db, resume.id, doc);

  return {
    resumeId: resume.id, accepted: result.accepted.length, rejected: result.rejected.length,
    fellBack: result.fellBack, artifactSha256: rendered.sha256, pages: rendered.pages,
    droppedForDensity: dropped.length,
    revertedForProvenance,
  };
}
