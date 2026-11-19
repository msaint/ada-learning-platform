import { randomInt } from "node:crypto";
import { json, type Db, type Tx } from "@/lib/db/client";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { callModel } from "@/lib/ai";
import type { ActivityContext, ConceptBrief, FetchedSource, ModelInfo } from "@/lib/ai/model-adapter";
import type { ActivitySpec } from "@/lib/schemas/model";
import type { ActivityFeedback } from "@/lib/schemas/dto";
import { chooseNext, finalAssessmentConcepts, lessonLimits, MIN_RECALL_GAP, type PlannedActivity, type SessionStep } from "@/lib/learning/next-action";
import { computeMastery, type EvidenceRecord } from "@/lib/learning/mastery";
import { loadActiveGoal, loadConceptStates, loadCourse, type ConceptState, type CourseRow } from "../learning-state";
import { FORM_PURPOSES, promptOf, QUESTION_FORMS, type ActivityRow, type AttemptRow, type SessionRow } from "./types";

export type StepRow = { activity_id: string; concept_id: string; kind: SessionStep["kind"]; purpose: SessionStep["purpose"]; result: SessionStep["result"] };
export type Hypothesis = { activity: ActivityRow; result: "correct" | "incorrect" };

export function brief(c: ConceptState, all: ConceptState[]): ConceptBrief {
  return {
    slug: c.slug,
    title: c.title,
    description: c.description,
    assessmentCriteria: c.criteria,
    prerequisites: c.prerequisiteIds.map((id) => all.find((x) => x.id === id)?.title ?? "").filter(Boolean),
  };
}

/**
 * Runs the planner for a session. With a hypothesis ("if the current answer
 * were correct/incorrect"), the current step's result and that concept's
 * mastery are simulated, so we can tell whether the outcome changes what
 * comes next.
 */
export async function planNext(q: Db, ownerId: string, s: SessionRow, hypothesis?: Hypothesis) {
  const course = await loadCourse(q, ownerId, s.course_id);
  const goal = await loadActiveGoal(q, course);
  let concepts = await loadConceptStates(q, course.id);
  let stepsRows: StepRow[] = await q<StepRow[]>`
    select a.id as activity_id, a.concept_id, a.kind, a.purpose, e.result
    from activities a left join attempts at on at.activity_id = a.id left join assessment_evidence e on e.attempt_id = at.id
    where a.session_id = ${s.id} order by a.sequence_no`;
  if (hypothesis) {
    stepsRows = stepsRows.map((r) => (r.activity_id === hypothesis.activity.id ? { ...r, result: hypothesis.result } : r));
    concepts = await simulateOutcome(q, concepts, hypothesis);
  }
  const now = new Date();
  const dueReviews = concepts
    .filter((c) => c.reviewItemId && c.reviewDueAt && c.reviewDueAt <= now)
    .sort((a, b) => a.reviewDueAt!.getTime() - b.reviewDueAt!.getTime())
    .map((c) => ({ reviewItemId: c.reviewItemId!, conceptId: c.id }));
  const decision = chooseNext({
    sessionKind: s.kind,
    intent: course.intent,
    concepts: concepts.map((c) => ({ ...c, status: c.mastery })), // reviews are planned via dueReviews
    sessionSteps: stepsRows.map((r) => ({ conceptId: r.concept_id, kind: r.kind, purpose: r.purpose, result: r.result })),
    dueReviews,
    focusConceptId: s.checkpoint_json.focusConceptId ?? null,
    difficultyOffset: s.checkpoint_json.difficultyOffset ?? 0,
    limits: lessonLimits(goal.time_budget_minutes_weekly, goal.depth),
  });
  return { course, concepts, stepsRows, decision };
}

/** Concept state as it would be if the hypothesised answer were recorded (independent, unassisted). */
export async function simulateOutcome(q: Db, concepts: ConceptState[], h: Hypothesis): Promise<ConceptState[]> {
  const a = h.activity;
  const rows = await q<{ activity_id: string; result: EvidenceRecord["result"]; independence: EvidenceRecord["independence"]; difficulty: number | null; purpose: string; recall: "prompted" | "unprompted"; created_at: Date }[]>`
    select at.activity_id, e.result, e.independence, e.difficulty, e.purpose, e.recall, e.created_at
    from assessment_evidence e join attempts at on at.id = e.attempt_id where e.concept_id = ${a.concept_id} order by e.created_at`;
  const recentSame = await q<{ concept_id: string }[]>`
    select concept_id from activities where session_id = ${a.session_id} and sequence_no >= ${a.sequence_no - MIN_RECALL_GAP} and sequence_no < ${a.sequence_no}`;
  const recall = recentSame.some((r) => r.concept_id === a.concept_id) ? "prompted" : "unprompted";
  const difficulty = "difficulty" in a.spec_json ? a.spec_json.difficulty : null;
  const m = computeMastery([
    ...rows.map((r) => ({ activityId: r.activity_id, result: r.result, independence: r.independence, difficulty: r.difficulty, purpose: r.purpose, recall: r.recall, createdAt: r.created_at })),
    { activityId: a.id, result: h.result, independence: "independent", difficulty, purpose: a.purpose, recall, createdAt: new Date() },
  ]);
  const counts = a.purpose !== "prediction" && a.purpose !== "placement";
  return concepts.map((c) =>
    c.id !== a.concept_id
      ? c
      : {
          ...c,
          mastery: m.status,
          needsRecall: m.details.needsRecall && m.status !== "demonstrated",
          history: {
            ...c.history,
            assessments: c.history.assessments + (counts ? 1 : 0),
            lastAssessKind: counts ? a.kind : c.history.lastAssessKind,
            predicted: c.history.predicted || a.purpose === "prediction" || a.purpose === "placement",
            placedOut: c.history.placedOut || (a.purpose === "placement" && h.result === "correct" && (difficulty ?? 1) >= 2),
          },
        },
  );
}

/** What a planned activity is, for matching a prepared one to the real decision. */
export function signature(d: PlannedActivity): string {
  return [d.conceptId, d.kind, d.purpose, d.difficulty, d.reviewItemId ?? ""].join("|");
}

export async function buildActivityContext(q: Db, ownerId: string, course: CourseRow, concepts: ConceptState[], s: SessionRow, d: PlannedActivity, seq: number): Promise<ActivityContext> {
  const concept = concepts.find((c) => c.id === d.conceptId)!;
  const goal = await loadActiveGoal(q, course);
  const recent = await q<{ result: string; reason: string }[]>`
    select result, reason from assessment_evidence where concept_id = ${concept.id} and result <> 'exposure' order by created_at desc limit 5`;
  const misconceptions = await q<{ m: string }[]>`
    select at.feedback_json->>'misconception' as m from attempts at join activities a on a.id = at.activity_id
    where a.concept_id = ${concept.id} and at.feedback_json->>'misconception' is not null order by at.submitted_at desc limit 3`;
  const prior = await q<{ p: string }[]>`
    select coalesce(spec_json->>'promptMarkdown', spec_json->>'title', '') as p from activities
    where concept_id = ${concept.id} order by created_at desc limit 6`;
  const followUp = d.purpose === "probe" || d.purpose === "defend" ? await previousAnswer(q, s.id, concept.id, d.purpose === "probe") : null;
  const courseConcepts = d.purpose === "integrative" ? finalAssessmentConcepts(concepts.map((c) => ({ ...c, status: c.mastery }))).map((c) => c.title) : undefined;
  const questionForm = FORM_PURPOSES.has(d.purpose) ? QUESTION_FORMS[(seq + concept.position) % QUESTION_FORMS.length] : null;
  const grounding = env().ADA_WEB_GROUNDING;
  const webGrounding = d.kind === "explanation" && (grounding === "on" || (grounding === "auto" && concept.needsFactCheck));
  return {
    topic: course.topic,
    intent: course.intent,
    goalText: goal.goal_text,
    baseline: goal.baseline_json?.text ?? "",
    timeBudgetMinutesWeekly: goal.time_budget_minutes_weekly,
    concept: brief(concept, concepts),
    kind: d.kind,
    purpose: d.purpose,
    difficulty: d.difficulty,
    recentEvidence: recent,
    misconceptions: misconceptions.map((r) => r.m),
    priorPrompts: prior.map((r) => r.p.slice(0, 300)).filter(Boolean),
    assistanceUsed: 0,
    linkContext: goal.baseline_json?.link_context ?? null,
    questionForm,
    followUp,
    courseConcepts,
    difficultyPreference: s.checkpoint_json.difficultyOffset ?? 0,
    webGrounding,
  };
}

/** Model call + validation for one planned activity (no database writes). */
export async function generateSpec(ownerId: string, ctx: ActivityContext, d: PlannedActivity): Promise<{ spec: ActivitySpec; info: ModelInfo }> {
  const { value, info } = await callModel(ownerId, "activity", (m) => m.generateActivity(ctx));
  if (value.kind !== d.kind) throw new AppError("model_invalid_output", "Generated activity had the wrong type.", true);
  let spec: ActivitySpec = { ...value, version: 1, conceptId: d.conceptId } as ActivitySpec;
  if (spec.kind === "multiple_choice") spec = shuffleChoices(spec);
  if ("difficulty" in spec) spec = { ...spec, difficulty: d.difficulty } as ActivitySpec;
  return { spec, info };
}

export async function insertActivity(t: Tx, s: SessionRow, course: CourseRow, d: PlannedActivity, seq: number, spec: ActivitySpec, info: Record<string, unknown>) {
  const [row] = await t<{ id: string }[]>`
    insert into activities (session_id, course_id, concept_id, review_item_id, sequence_no, kind, purpose, spec_json, model_info_json)
    values (${s.id}, ${course.id}, ${d.conceptId}, ${d.reviewItemId ?? null}, ${seq}, ${spec.kind}, ${d.purpose}, ${json(spec)}, ${json(info)})
    returning id`;
  // Verified provenance: only pages the provider reported searching or fetching.
  for (const src of ((info.sources as FetchedSource[] | undefined) ?? []).slice(0, 6)) {
    if (!/^https?:\/\//i.test(src.url)) continue;
    await t`insert into source_references (course_id, activity_id, title, url, retrieved_at, source_type)
      values (${course.id}, ${row.id}, ${(src.title ?? src.url).slice(0, 300)}, ${src.url.slice(0, 2000)}, ${src.retrievedAt ?? new Date().toISOString()}, 'web_search')`;
  }
  return row.id;
}

/** The learner's most recent answer on a concept in this session (for Socratic probes and devil's-advocate follow-ups). */
export async function previousAnswer(t: Db, sessionId: string, conceptId: string, includeKey: boolean) {
  const [r] = await t<{ spec_json: ActivitySpec; submission_json: AttemptRow["submission_json"]; feedback_json: (ActivityFeedback & { misconception?: string | null }) | null }[]>`
    select a.spec_json, at.submission_json, at.feedback_json from activities a join attempts at on at.activity_id = a.id
    where a.session_id = ${sessionId} and a.concept_id = ${conceptId} and a.kind in ('multiple_choice','free_response')
    order by a.sequence_no desc limit 1`;
  if (!r) return null;
  const spec = r.spec_json;
  const learnerAnswer =
    spec.kind === "multiple_choice"
      ? (spec.choices.find((c) => c.id === r.submission_json.choiceId)?.text ?? "(no choice)")
      : (r.submission_json.text ?? "(no answer)");
  const answerKey = !includeKey ? null : spec.kind === "multiple_choice" ? (spec.choices.find((c) => c.id === spec.correctChoiceId)?.text ?? null) : spec.kind === "free_response" ? spec.idealAnswerPrivate : null;
  return { promptMarkdown: promptOf(spec).slice(0, 1500), learnerAnswer: learnerAnswer.slice(0, 2000), answerKey, misconception: r.feedback_json?.misconception ?? null };
}

/** Shuffles choices once at generation (persisted, so a reload shows the same order) and relabels ids a–e. */
export function shuffleChoices(spec: Extract<ActivitySpec, { kind: "multiple_choice" }>, rand: (n: number) => number = (n) => randomInt(n)) {
  const choices = [...spec.choices];
  for (let i = choices.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  const ids = ["a", "b", "c", "d", "e"];
  const relabeled = choices.map((c, i) => ({ id: ids[i], text: c.text, _orig: c.id }));
  const correct = relabeled.find((c) => c._orig === spec.correctChoiceId)!.id;
  return { ...spec, choices: relabeled.map(({ id, text }) => ({ id, text })), correctChoiceId: correct };
}
