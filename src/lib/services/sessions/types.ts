import { db, type Tx } from "@/lib/db/client";
import { usingMockModel } from "@/lib/env";
import { notFound } from "@/lib/errors";
import type { FetchedSource } from "@/lib/ai/model-adapter";
import type { ActivitySpec } from "@/lib/schemas/model";
import type { ActivityFeedback, InlineError, LearnerActivity, SessionPhase, SessionView } from "@/lib/schemas/dto";
import { FINAL_MAX_CONCEPTS, lessonLimits, PLACEMENT_MAX, type SessionKind } from "@/lib/learning/next-action";

export type SessionRow = {
  id: string;
  course_id: string;
  owner_id: string;
  kind: SessionKind;
  status: "active" | "paused" | "completed";
  current_activity_id: string | null;
  checkpoint_json: { focusConceptId?: string | null; summary?: SessionView["summary"]; pausedAt?: string; difficultyOffset?: number };
  version: number;
};

export type Assist = { key: string; text: string };

export type ActivityRow = {
  id: string;
  session_id: string;
  course_id: string;
  concept_id: string;
  review_item_id: string | null;
  sequence_no: number;
  kind: ActivitySpec["kind"];
  purpose: string;
  spec_json: ActivitySpec;
  status: "presented" | "evaluating" | "answered" | "completed";
  hints_json: Assist[];
  alt_explanations_json: Assist[];
  model_info_json: Record<string, unknown>;
};

export type AttemptRow = {
  id: string;
  activity_id: string;
  owner_id: string;
  submission_json: { choiceId?: string; text?: string; skipped?: boolean };
  hint_count: number;
  explanation_revealed: boolean;
  idempotency_key: string;
  status: "pending_evaluation" | "graded";
  feedback_json: (ActivityFeedback & { misconception?: string | null }) | null;
};

export const MAX_HINTS = 3;
/** Purposes whose wrong answers are not revealed: a narrower question (or the course itself) comes next. */
export const WITHHOLD_ON_MISS = new Set(["check", "apply", "transfer", "recall", "defend", "placement"]);
/** Sessions where help (hints, alternative explanations, difficulty changes) would distort the measurement. */
export const MEASUREMENT_SESSIONS = new Set<SessionKind>(["placement", "assessment"]);
/** Rotating question forms (predict, explain why, find the flaw, apply, connect). */
export const QUESTION_FORMS = [
  "ask the learner to predict an outcome and say why",
  "ask the learner to explain why something happens",
  "present a plausible-but-wrong claim and ask the learner to find the flaw",
  "ask the learner to apply the idea to a new, concrete case",
  "ask the learner to connect this idea to another concept in the course",
];
export const FORM_PURPOSES = new Set(["check", "apply", "transfer", "recall", "final", "review"]);
export const MAX_ALT_EXPLANATIONS = 3;

export const promptOf = (s: ActivitySpec) => ("promptMarkdown" in s ? s.promptMarkdown : s.bodyMarkdown);

export function activitySources(info: Record<string, unknown> | undefined) {
  const list = ((info?.sources as FetchedSource[] | undefined) ?? []).filter((x) => /^https?:\/\//i.test(x.url)).slice(0, 6);
  return list.length ? { sources: list.map((x) => ({ url: x.url, title: x.title })) } : {};
}

export async function loadSession(t: Tx | ReturnType<typeof db>, ownerId: string, sessionId: string, forUpdate = false): Promise<SessionRow> {
  const rows = forUpdate
    ? await t<SessionRow[]>`select * from sessions where id = ${sessionId} and owner_id = ${ownerId} for no key update`
    : await t<SessionRow[]>`select * from sessions where id = ${sessionId} and owner_id = ${ownerId}`;
  if (!rows[0]) throw notFound("Session");
  return rows[0];
}

export async function loadActivityForOwner(t: Tx, ownerId: string, activityId: string) {
  const [a] = await t<(ActivityRow & { owner_id: string; session_status: SessionRow["status"]; session_kind: SessionKind })[]>`
    select a.*, s.owner_id, s.status as session_status, s.kind as session_kind from activities a join sessions s on s.id = a.session_id
    where a.id = ${activityId} and s.owner_id = ${ownerId} for no key update of a`;
  if (!a) throw notFound("Activity");
  return a;
}

/** Strips every teacher-only field (reasoning, answer key, rationale, rubric, ideal answer). */
export function toLearnerActivity(a: Pick<ActivityRow, "id" | "spec_json" | "purpose"> & { model_info_json?: Record<string, unknown> }, conceptTitle: string): LearnerActivity {
  const s = a.spec_json;
  const base = { id: a.id, purpose: a.purpose, conceptTitle };
  switch (s.kind) {
    case "explanation":
      return { ...base, kind: "explanation", title: s.title, bodyMarkdown: s.bodyMarkdown, continueLabel: s.continueLabel, ...activitySources(a.model_info_json) };
    case "multiple_choice":
      return { ...base, kind: "multiple_choice", promptMarkdown: s.promptMarkdown, choices: s.choices.map((c) => ({ id: c.id, text: c.text })), difficulty: s.difficulty };
    case "free_response":
      return { ...base, kind: "free_response", promptMarkdown: s.promptMarkdown, difficulty: s.difficulty };
    default:
      return { ...base, kind: "reflection", promptMarkdown: s.promptMarkdown };
  }
}

export function phaseOf(s: SessionRow, a: ActivityRow | null): SessionPhase {
  if (s.status === "completed") return "completed";
  if (s.status === "paused") return "paused";
  if (!a || a.status === "completed") return "choosing_next";
  if (a.status === "presented") return "awaiting_response";
  if (a.status === "evaluating") return "evaluating";
  return "feedback";
}

export function computeTargetSteps(input: {
  kind: SessionKind;
  position: number;
  currentUnanswered: boolean;
  stepCount: number;
  planCount: number;
  dueCount: number;
  timeBudgetMinutesWeekly: number | null;
  depth: string | null;
}): number {
  const pos = Math.max(1, input.position);
  switch (input.kind) {
    case "placement":
      return Math.max(pos, Math.min(PLACEMENT_MAX, Math.max(1, input.planCount)));
    case "assessment":
      return Math.max(pos, Math.min(FINAL_MAX_CONCEPTS, Math.max(1, input.planCount)) + 1);
    case "review": {
      const answeredInSession = Math.max(0, input.stepCount - (input.currentUnanswered ? 1 : 0));
      return Math.max(pos, Math.min(3, Math.max(1, answeredInSession + input.dueCount)));
    }
    default:
      return Math.max(pos, lessonLimits(input.timeBudgetMinutesWeekly, input.depth).lesson);
  }
}

export async function getSessionView(ownerId: string, sessionId: string, error: InlineError | null = null): Promise<SessionView & { error: InlineError | null }> {
  const s = await loadSession(db(), ownerId, sessionId);
  let activity: ActivityRow | null = null;
  let conceptTitle = "";
  let attempt: AttemptRow | null = null;
  let draft: SessionView["draft"] = null;
  if (s.current_activity_id) {
    const [a] = await db()<(ActivityRow & { concept_title: string })[]>`
      select a.*, c.title as concept_title from activities a join concepts c on c.id = a.concept_id where a.id = ${s.current_activity_id}`;
    activity = a ?? null;
    conceptTitle = a?.concept_title ?? "";
    if (a) {
      [attempt] = await db()<AttemptRow[]>`select * from attempts where activity_id = ${a.id}`;
      const [d] = await db()<{ draft_json: { choiceId?: string; text?: string }; version: number }[]>`
        select draft_json, version from activity_drafts where activity_id = ${a.id} and owner_id = ${ownerId}`;
      draft = d ? { value: d.draft_json, version: d.version } : null;
    }
  }
  let suggestBreakdown: SessionView["suggestBreakdown"] = null;
  if (s.status === "active" && s.kind === "lesson" && activity) {
    const [m] = await db()<{ status: string }[]>`select status from mastery_estimates where concept_id = ${activity.concept_id}`;
    if (m?.status !== "demonstrated") {
      const [{ misses }] = await db()<{ misses: number }[]>`
        select count(*)::int as misses from assessment_evidence where concept_id = ${activity.concept_id} and result in ('incorrect', 'partial')`;
      if (misses >= 2) suggestBreakdown = { conceptId: activity.concept_id, conceptTitle };
    }
  }
  const position = activity?.sequence_no ?? 0;
  let targetSteps: number | undefined;
  if (s.status !== "completed") {
    const [pacing] = await db()<{
      time_budget_minutes_weekly: number | null;
      depth: string | null;
      plan_count: number;
      due_count: number;
      step_count: number;
    }[]>`
      select g.time_budget_minutes_weekly, g.depth,
        coalesce(
          (select jsonb_array_length(cv.plan_json->'required_slugs') from course_curriculum_versions cv
           where cv.course_id = co.id and jsonb_typeof(cv.plan_json->'required_slugs') = 'array'
           order by cv.version desc limit 1),
          (select count(*)::int from concepts c where c.course_id = co.id)
        )::int as plan_count,
        (select count(*)::int from review_items r where r.course_id = co.id and r.status = 'active' and r.due_at <= now()) as due_count,
        (select count(*)::int from activities act where act.session_id = ${s.id}) as step_count
      from courses co
      left join course_goal_versions g on g.id = co.active_goal_version_id
      where co.id = ${s.course_id}`;
    if (pacing) {
      targetSteps = computeTargetSteps({
        kind: s.kind,
        position,
        currentUnanswered: activity?.status === "presented" || activity?.status === "evaluating",
        stepCount: pacing.step_count,
        planCount: pacing.plan_count,
        dueCount: pacing.due_count,
        timeBudgetMinutesWeekly: pacing.time_budget_minutes_weekly,
        depth: pacing.depth,
      });
    }
  }
  const feedback: ActivityFeedback | null = attempt
    ? attempt.status === "graded"
      ? attempt.feedback_json
      : {
          status: "pending_evaluation",
          result: null,
          independence: attempt.hint_count > 0 || attempt.explanation_revealed ? "assisted" : "independent",
          feedbackMarkdown: "Your answer is saved. Grading didn't finish — you can retry.",
          submittedText: attempt.submission_json.text,
        }
    : null;
  return {
    id: s.id,
    courseId: s.course_id,
    kind: s.kind,
    status: s.status,
    difficultyOffset: s.checkpoint_json.difficultyOffset ?? 0,
    phase: phaseOf(s, activity),
    position,
    targetSteps,
    activity: activity && s.status !== "completed" ? toLearnerActivity(activity, conceptTitle) : null,
    draft,
    hints: activity?.hints_json.map((h) => h.text) ?? [],
    altExplanations: activity?.alt_explanations_json.map((h) => h.text) ?? [],
    feedback: s.status === "completed" ? null : feedback,
    summary: s.checkpoint_json.summary ?? null,
    suggestBreakdown,
    devModel: usingMockModel(),
    aiGenerated: true,
    error,
  };
}
