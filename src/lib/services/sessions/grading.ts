import { db, json, tx, type Tx } from "@/lib/db/client";
import { runAfterResponse } from "@/lib/background";
import { withClaim } from "@/lib/db/claims";
import { AppError, conflict, invalid } from "@/lib/errors";
import { callModel } from "@/lib/ai";
import type { ConceptBrief } from "@/lib/ai/model-adapter";
import type { EvaluationResult } from "@/lib/schemas/model";
import type { ActivityFeedback, InlineError } from "@/lib/schemas/dto";
import { MIN_RECALL_GAP, type SessionKind } from "@/lib/learning/next-action";
import { computeMastery, type EvidenceRecord } from "@/lib/learning/mastery";
import { initialReview, nextReview } from "@/lib/learning/review-scheduler";
import { track } from "../telemetry";
import { prepareNext } from "./prefetch";
import {
  getSessionView,
  loadActivityForOwner,
  MAX_ALT_EXPLANATIONS,
  MAX_HINTS,
  MEASUREMENT_SESSIONS,
  promptOf,
  WITHHOLD_ON_MISS,
  type ActivityRow,
  type AttemptRow,
} from "./types";

export type Submission = { choiceId: string } | { text: string } | { skipped: true };

// ---------------------------------------------------------------- drafts, hints, explanations

export async function saveActivityDraft(ownerId: string, activityId: string, draft: { choiceId?: string; text?: string }, baseVersion: number) {
  return tx(async (t) => {
    const a = await loadActivityForOwner(t, ownerId, activityId);
    if (a.status !== "presented") throw conflict("This activity has already been answered.");
    const [d] = await t<{ version: number; draft_json: unknown }[]>`select version, draft_json from activity_drafts where activity_id = ${activityId} for update`;
    if (d && d.version !== baseVersion) throw conflict("This answer was changed in another tab.", { draft: { value: d.draft_json, version: d.version } });
    const [r] = await t<{ version: number }[]>`
      insert into activity_drafts (activity_id, owner_id, draft_json, version) values (${activityId}, ${ownerId}, ${json(draft)}, 1)
      on conflict (activity_id) do update set draft_json = excluded.draft_json, version = activity_drafts.version + 1, updated_at = now()
      returning version`;
    return { version: r.version };
  });
}

async function conceptFor(t: Tx, a: ActivityRow) {
  const [c] = await t<{ slug: string; title: string; description: string; assessment_criteria_json: string[]; topic: string; baseline: string | null }[]>`
    select c.slug, c.title, c.description, c.assessment_criteria_json, co.topic, g.baseline_json->>'text' as baseline
    from concepts c join courses co on co.id = c.course_id
    left join course_goal_versions g on g.id = co.active_goal_version_id
    where c.id = ${a.concept_id}`;
  const b: ConceptBrief = { slug: c.slug, title: c.title, description: c.description, assessmentCriteria: c.assessment_criteria_json, prerequisites: [] };
  return { brief: b, topic: c.topic, baseline: c.baseline ?? "" };
}

/**
 * Hints and alternative explanations: checked from a short read, generated
 * with no transaction open, then appended in a short transaction that
 * re-checks the activity (idempotency key, limits, still unanswered).
 */
export async function requestHint(ownerId: string, activityId: string, key: string) {
  return withClaim(`assist:${activityId}`, async () => {
    const check = (a: Awaited<ReturnType<typeof loadActivityForOwner>>) => {
      if (a.hints_json.some((h) => h.key === key)) return { hints: a.hints_json.map((h) => h.text) };
      if (a.status !== "presented" || a.session_status === "completed") throw conflict("Hints are available before you answer.");
      if (MEASUREMENT_SESSIONS.has(a.session_kind)) throw conflict("Hints aren't available during placement or the final check.");
      if (a.kind !== "multiple_choice" && a.kind !== "free_response") throw invalid("Hints are only available for questions.");
      if (a.hints_json.length >= MAX_HINTS) throw conflict("No more hints for this question — try your best answer.");
      return null;
    };
    const before = await tx(async (t) => {
      const a = await loadActivityForOwner(t, ownerId, activityId);
      return { a, done: check(a), c: await conceptFor(t, a) };
    });
    if (before.done) return before.done;
    const { a, c } = before;
    const s = a.spec_json;
    const answerKey = s.kind === "multiple_choice" ? s.choices.find((x) => x.id === s.correctChoiceId)!.text : s.kind === "free_response" ? s.idealAnswerPrivate : "";
    const { value } = await callModel(ownerId, "hint", (m) =>
      m.hint({ topic: c.topic, concept: c.brief, promptMarkdown: promptOf(s), previousHints: a.hints_json.map((h) => h.text), answerKey }),
    );
    return tx(async (t) => {
      const cur = await loadActivityForOwner(t, ownerId, activityId);
      const done = check(cur); // answered meanwhile → conflict; same key already stored → return it
      if (done) return done;
      const hints = [...cur.hints_json, { key, text: value.hintMarkdown }];
      await t`update activities set hints_json = ${json(hints)} where id = ${cur.id}`;
      return { hints: hints.map((h) => h.text) };
    });
  });
}

export async function requestExplanation(ownerId: string, activityId: string, key: string) {
  return withClaim(`assist:${activityId}`, async () => {
    const check = (a: Awaited<ReturnType<typeof loadActivityForOwner>>) => {
      if (a.alt_explanations_json.some((h) => h.key === key)) return { altExplanations: a.alt_explanations_json.map((h) => h.text) };
      if (a.session_status === "completed") throw conflict("This session is complete.");
      if (MEASUREMENT_SESSIONS.has(a.session_kind)) throw conflict("Explanations aren't available during placement or the final check.");
      if (a.alt_explanations_json.length >= MAX_ALT_EXPLANATIONS) throw conflict("That's all the alternative explanations for now.");
      return null;
    };
    const before = await tx(async (t) => {
      const a = await loadActivityForOwner(t, ownerId, activityId);
      return { a, done: check(a), c: await conceptFor(t, a) };
    });
    if (before.done) return before.done;
    const { a, c } = before;
    const { value } = await callModel(ownerId, "explain", (m) =>
      m.explainDifferently({
        topic: c.topic,
        concept: c.brief,
        activityPrompt: promptOf(a.spec_json),
        previousExplanations: [a.kind === "explanation" ? promptOf(a.spec_json) : "", ...a.alt_explanations_json.map((h) => h.text)].filter(Boolean).map((x) => x.slice(0, 1500)),
        learnerBaseline: c.baseline,
      }),
    );
    return tx(async (t) => {
      const cur = await loadActivityForOwner(t, ownerId, activityId);
      const done = check(cur);
      if (done) return done;
      const alts = [...cur.alt_explanations_json, { key, text: value.bodyMarkdown }];
      await t`update activities set alt_explanations_json = ${json(alts)} where id = ${cur.id}`;
      return { altExplanations: alts.map((h) => h.text) };
    });
  });
}

// ---------------------------------------------------------------- attempts, evidence, mastery, reviews

/**
 * Submits an answer exactly once. Multiple choice is graded deterministically
 * on the server; free response is persisted first (never lost), then graded
 * by the model against the rubric. Evidence + mastery + review scheduling are
 * written atomically with the graded attempt.
 */
export async function submitAttempt(ownerId: string, activityId: string, key: string, response: Submission) {
  const phase1 = await tx(async (t) => {
    const a = await loadActivityForOwner(t, ownerId, activityId);
    const [byKey] = await t<AttemptRow[]>`select * from attempts where owner_id = ${ownerId} and idempotency_key = ${key}`;
    if (byKey && byKey.activity_id !== activityId) throw conflict("Idempotency key reused for a different activity.");
    const [existing] = await t<AttemptRow[]>`select * from attempts where activity_id = ${activityId}`;
    if (existing) return { sessionId: a.session_id, attempt: existing, activity: a };
    if (a.session_status === "completed") throw conflict("This session is complete.");
    if (a.kind === "explanation") throw invalid("There's nothing to submit for an explanation.");
    const spec = a.spec_json;
    const skipped = "skipped" in response;
    if (!skipped) {
      if (spec.kind === "multiple_choice" && !("choiceId" in response && spec.choices.some((c) => c.id === response.choiceId))) throw invalid("Choose one of the options.");
      if ((spec.kind === "free_response" || spec.kind === "reflection") && !("text" in response)) throw invalid("Write an answer first.");
    }
    const hintCount = a.hints_json.length;
    const revealed = a.alt_explanations_json.length > 0;
    const independence = skipped || hintCount > 0 || revealed ? "assisted" : "independent";
    const needsModel = spec.kind === "free_response" && !skipped;
    const [attempt] = await t<AttemptRow[]>`
      insert into attempts (activity_id, owner_id, submission_json, hint_count, explanation_revealed, idempotency_key, status)
      values (${activityId}, ${ownerId}, ${json(response)}, ${hintCount}, ${revealed}, ${key}, ${needsModel ? "pending_evaluation" : "graded"})
      returning *`;
    await t`delete from activity_drafts where activity_id = ${activityId}`;
    if (needsModel) {
      await t`update activities set status = 'evaluating' where id = ${activityId}`;
      return { sessionId: a.session_id, attempt, activity: a };
    }
    let feedback: ActivityFeedback;
    let result: EvidenceRecord["result"];
    let rubric: unknown = {};
    if (skipped) {
      result = "exposure";
      feedback = {
        status: "graded",
        result: "exposure",
        independence: "assisted",
        skipped: true,
        ...(a.session_kind === "placement"
          ? { feedbackMarkdown: "No problem — that tells Ada where to start. You'll learn this in the course." }
          : {
              feedbackMarkdown: "Here's the answer. This counts as seeing it, not as independent evidence.",
              ...(spec.kind === "multiple_choice" ? { correctChoiceId: spec.correctChoiceId, rationale: spec.rationale } : {}),
              ...(spec.kind === "free_response" ? { exampleAnswer: spec.idealAnswerPrivate } : {}),
            }),
      };
    } else if (spec.kind === "multiple_choice") {
      const choiceId = (response as { choiceId: string }).choiceId;
      result = choiceId === spec.correctChoiceId ? "correct" : "incorrect";
      rubric = { type: "exact_choice", correctChoiceId: spec.correctChoiceId };
      const withhold = result === "incorrect" && shouldWithhold(a);
      feedback = withhold
        ? {
            status: "graded",
            result,
            independence,
            chosenChoiceId: choiceId,
            withheld: true,
            feedbackMarkdown:
              a.session_kind === "placement"
                ? "Not quite — noted. Placement doesn't reveal answers; you'll work through this in the course."
                : "Not quite. Instead of handing you the answer, Ada will ask a narrower question next.",
          }
        : {
            status: "graded",
            result,
            independence,
            chosenChoiceId: choiceId,
            correctChoiceId: spec.correctChoiceId,
            rationale: spec.rationale,
            feedbackMarkdown:
              result === "correct"
                ? independence === "assisted"
                  ? "Right — with help, so this counts as assisted practice."
                  : "That's right."
                : a.purpose === "prediction"
                  ? "Not quite — that's fine for a prediction. Here's why:"
                  : "Not quite. Here's why:",
          };
    } else {
      result = "exposure"; // reflection: noted, never scored
      feedback = { status: "graded", result: "exposure", independence, submittedText: (response as { text: string }).text, feedbackMarkdown: "Thanks — noted. Questions like this help Ada suggest where to explore next." };
    }
    await recordEvidence(t, ownerId, a, attempt, {
      result,
      score: result === "correct" ? 1 : result === "incorrect" ? 0 : null,
      independence,
      rubric,
      reason: skipped ? "skipped" : spec.kind === "reflection" ? "reflection (not scored)" : `choice ${"choiceId" in response ? response.choiceId : ""}`,
      evaluator: { type: skipped || spec.kind !== "multiple_choice" ? "none" : "deterministic", version: 1 },
      feedback,
    });
    return { sessionId: a.session_id, attempt: { ...attempt, status: "graded" as const, feedback_json: feedback }, activity: a };
  });

  let error: InlineError | null = null;
  if (phase1.attempt.status === "pending_evaluation") {
    try {
      await evaluatePending(ownerId, phase1.activity, phase1.attempt);
    } catch (e) {
      if (!(e instanceof AppError) || !(e.retryable || e.code === "rate_limited")) throw e;
      error = { code: e.code, message: "Your answer is saved, but grading didn't finish. Retry to grade it.", retryable: true };
      await track(ownerId, "model_error", { op: "evaluate", code: e.code });
    }
  }
  // The outcome is known: generate the next step while the learner reads the feedback.
  if (!error) await runAfterResponse("prepare_next", () => prepareNext(ownerId, phase1.sessionId));
  return getSessionView(ownerId, phase1.sessionId, error);
}

async function evaluatePending(ownerId: string, activity: ActivityRow, attempt: AttemptRow) {
  const spec = activity.spec_json;
  if (spec.kind !== "free_response") return;
  const [c] = await db()<{ slug: string; title: string; description: string; assessment_criteria_json: string[]; topic: string }[]>`
    select c.slug, c.title, c.description, c.assessment_criteria_json, co.topic from concepts c join courses co on co.id = c.course_id where c.id = ${activity.concept_id}`;
  const { value, info } = await callModel(ownerId, "evaluate", (m) =>
    m.evaluateAnswer({
      topic: c.topic,
      concept: { slug: c.slug, title: c.title, description: c.description, assessmentCriteria: c.assessment_criteria_json, prerequisites: [] },
      promptMarkdown: spec.promptMarkdown,
      rubric: spec.rubric,
      idealAnswer: spec.idealAnswerPrivate,
      response: attempt.submission_json.text ?? "",
      withholdAnswer: shouldWithhold(activity as ActivityRow & { session_kind: SessionKind }),
    }),
  );
  await tx(async (t) => {
    const [cur] = await t<AttemptRow[]>`select * from attempts where id = ${attempt.id} for update`;
    if (cur.status !== "pending_evaluation") return; // graded concurrently
    const independence = cur.hint_count > 0 || cur.explanation_revealed ? "assisted" : "independent";
    const withhold = value.result !== "correct" && shouldWithhold(activity as ActivityRow & { session_kind: SessionKind });
    const feedback = freeResponseFeedback(value, independence, spec.idealAnswerPrivate, cur.submission_json.text ?? "", withhold);
    await recordEvidence(t, ownerId, activity, cur, {
      result: value.result,
      score: value.score,
      independence,
      rubric: { rubric: spec.rubric, criteria: value.criteria, rubricVersion: 1 },
      reason: value.misconception ?? value.criteria.map((x) => `${x.criterion}: ${x.met}`).join("; ").slice(0, 500),
      evaluator: { type: "model_rubric", provider: info.provider, model: info.model, rubricVersion: 1 },
      feedback,
      misconception: value.misconception,
    });
  });
}

/** Socratic: lesson misses and placement probes don't reveal the answer (reviews and the final check do). */
function shouldWithhold(a: { purpose: string; session_kind: SessionKind }) {
  return WITHHOLD_ON_MISS.has(a.purpose) && (a.session_kind === "lesson" || a.session_kind === "placement");
}

function freeResponseFeedback(v: EvaluationResult, independence: "independent" | "assisted", ideal: string, submitted: string, withhold = false): ActivityFeedback {
  const note =
    v.result === "uncertain"
      ? "\n\n_Ada isn't confident grading this one, so it won't count either way._"
      : v.result === "correct" && independence === "assisted"
        ? "\n\n_You used help on this one, so it counts as assisted practice._"
        : "";
  if (withhold) return { status: "graded", result: v.result, independence, feedbackMarkdown: v.feedbackMarkdown + note, criteria: v.criteria, submittedText: submitted, withheld: true };
  return { status: "graded", result: v.result, independence, feedbackMarkdown: v.feedbackMarkdown + note, criteria: v.criteria, exampleAnswer: ideal, submittedText: submitted };
}

async function recordEvidence(
  t: Tx,
  ownerId: string,
  a: ActivityRow,
  attempt: AttemptRow,
  e: {
    result: EvidenceRecord["result"];
    score: number | null;
    independence: "independent" | "assisted";
    rubric: unknown;
    reason: string;
    evaluator: Record<string, unknown>;
    feedback: ActivityFeedback;
    misconception?: string | null;
  },
) {
  const difficulty = "difficulty" in a.spec_json ? a.spec_json.difficulty : null;
  const feedbackJson = e.misconception ? { ...e.feedback, misconception: e.misconception } : e.feedback;
  await t`update attempts set status = 'graded', feedback_json = ${json(feedbackJson)} where id = ${attempt.id}`;
  await t`update activities set status = 'answered' where id = ${a.id}`;
  // "Prompted" = answered within MIN_RECALL_GAP steps of another activity on the same concept in this session.
  const recentSame = await t<{ concept_id: string }[]>`
    select concept_id from activities where session_id = ${a.session_id} and sequence_no >= ${a.sequence_no - MIN_RECALL_GAP} and sequence_no < ${a.sequence_no}`;
  const recall = recentSame.some((r) => r.concept_id === a.concept_id) ? "prompted" : "unprompted";
  await t`insert into assessment_evidence (attempt_id, course_id, concept_id, activity_kind, purpose, result, score, independence, difficulty, rubric_json, reason, evaluator_json, recall)
    values (${attempt.id}, ${a.course_id}, ${a.concept_id}, ${a.kind}, ${a.purpose}, ${e.result}, ${e.score}, ${e.independence}, ${difficulty}, ${json(e.rubric)}, ${e.reason}, ${json(e.evaluator)}, ${recall})`;
  await recomputeMastery(t, a.course_id, a.concept_id);
  if (e.result !== "exposure") await scheduleReview(t, ownerId, a, e.result, e.independence);
  await track(ownerId, "attempt_submitted", { kind: a.kind, result: e.result, independence: e.independence }, t);
}

export async function recomputeMastery(t: Tx, courseId: string, conceptId: string) {
  const rows = await t<{ activity_id: string; result: EvidenceRecord["result"]; independence: EvidenceRecord["independence"]; difficulty: number | null; purpose: string; recall: "prompted" | "unprompted"; created_at: Date }[]>`
    select at.activity_id, e.result, e.independence, e.difficulty, e.purpose, e.recall, e.created_at
    from assessment_evidence e join attempts at on at.id = e.attempt_id where e.concept_id = ${conceptId} order by e.created_at`;
  const m = computeMastery(rows.map((r) => ({ activityId: r.activity_id, result: r.result, independence: r.independence, difficulty: r.difficulty, purpose: r.purpose, recall: r.recall, createdAt: r.created_at })));
  await t`insert into mastery_estimates (course_id, concept_id, status, confidence, last_independent_success_at, last_assessed_at, details_json, updated_at)
    values (${courseId}, ${conceptId}, ${m.status}, ${m.confidence}, ${m.lastIndependentSuccessAt}, ${m.lastAssessedAt}, ${json(m.details)}, now())
    on conflict (course_id, concept_id) do update set status = excluded.status, confidence = excluded.confidence,
      last_independent_success_at = excluded.last_independent_success_at, last_assessed_at = excluded.last_assessed_at,
      details_json = excluded.details_json, updated_at = now()`;
  return m;
}

async function scheduleReview(t: Tx, ownerId: string, a: ActivityRow, result: Exclude<EvidenceRecord["result"], "exposure">, independence: "independent" | "assisted") {
  const now = new Date();
  if (a.review_item_id) {
    const [r] = await t<{ id: string; interval_days: number; repetitions: number; status: string }[]>`select * from review_items where id = ${a.review_item_id} for update`;
    if (r && r.status === "active") {
      const next = nextReview({ intervalDays: r.interval_days, repetitions: r.repetitions }, { result, independence }, now);
      await t`update review_items set interval_days = ${next.intervalDays}, repetitions = ${next.repetitions}, due_at = ${next.dueAt}, last_review_at = ${now} where id = ${r.id}`;
      await track(ownerId, "review_completed", { result }, t);
    }
    return;
  }
  const [existing] = await t`select id from review_items where concept_id = ${a.concept_id} and status = 'active'`;
  if (existing) return;
  const init = initialReview(now);
  await t`insert into review_items (course_id, concept_id, owner_id, due_at, interval_days, repetitions)
    values (${a.course_id}, ${a.concept_id}, ${ownerId}, ${init.dueAt}, ${init.intervalDays}, ${init.repetitions}) on conflict do nothing`;
}

// ---------------------------------------------------------------- learner controls on graded attempts

/** "Show me the answer" for a withheld (Socratic) miss. Evidence is unchanged; it was already a miss. */
export async function revealAnswer(ownerId: string, activityId: string) {
  const sessionId = await tx(async (t) => {
    const a = await loadActivityForOwner(t, ownerId, activityId);
    const [at] = await t<AttemptRow[]>`select * from attempts where activity_id = ${activityId} for update`;
    if (!at || at.status !== "graded" || !at.feedback_json) throw conflict("Answer the question first.");
    if (!at.feedback_json.withheld) return a.session_id; // already visible (idempotent)
    const spec = a.spec_json;
    const feedback = {
      ...at.feedback_json,
      withheld: false,
      revealed: true,
      ...(spec.kind === "multiple_choice" ? { correctChoiceId: spec.correctChoiceId, rationale: spec.rationale } : {}),
      ...(spec.kind === "free_response" ? { exampleAnswer: spec.idealAnswerPrivate } : {}),
    };
    await t`update attempts set feedback_json = ${json(feedback)}, explanation_revealed = true where id = ${at.id}`;
    return a.session_id;
  });
  return getSessionView(ownerId, sessionId);
}

/** "That felt misgraded" on a graded free-response attempt. Marks feedback_json.flagged and records non-PII telemetry. */
export async function flagGrading(ownerId: string, activityId: string, note?: string) {
  const sessionId = await tx(async (t) => {
    const a = await loadActivityForOwner(t, ownerId, activityId);
    if (a.kind !== "free_response") throw invalid("Only free-response grading can be flagged.");
    const [at] = await t<AttemptRow[]>`select * from attempts where activity_id = ${activityId} for update`;
    if (!at || at.status !== "graded" || !at.feedback_json) throw conflict("Answer the question first.");
    if (at.feedback_json.flagged) return a.session_id; // idempotent
    const feedback = { ...at.feedback_json, flagged: true };
    await t`update attempts set feedback_json = ${json(feedback)} where id = ${at.id}`;
    await track(
      ownerId,
      "grading_flagged",
      { result: at.feedback_json.result ?? "unknown", hasNote: Boolean(note?.trim()), activityKind: a.kind },
      t,
    );
    return a.session_id;
  });
  return getSessionView(ownerId, sessionId);
}
