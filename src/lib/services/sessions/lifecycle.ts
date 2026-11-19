import { db, json, tx } from "@/lib/db/client";
import { runAfterResponse } from "@/lib/background";
import { withClaim } from "@/lib/db/claims";
import { AppError, conflict, notFound } from "@/lib/errors";
import type { ModelInfo } from "@/lib/ai/model-adapter";
import type { ActivitySpec } from "@/lib/schemas/model";
import type { InlineError, SessionSummary, SessionView } from "@/lib/schemas/dto";
import type { SessionKind } from "@/lib/learning/next-action";
import { loadConceptStates, loadCourse, MIN_CONCEPTS_FOR_PLACEMENT } from "../learning-state";
import { track } from "../telemetry";
import { buildActivityContext, generateSpec, insertActivity, planNext, signature } from "./activity-generation";
import { prepareNext, takePrepared } from "./prefetch";
import { getSessionView, loadSession, type ActivityRow, type SessionRow } from "./types";

export async function startOrResumeSession(
  ownerId: string,
  courseId: string,
  opts: { kind?: SessionKind; focusConceptId?: string },
): Promise<SessionView & { error: InlineError | null }> {
  const { sessionId, needsActivity } = await tx(async (t) => {
    const course = await loadCourse(t, ownerId, courseId, true);
    if (course.status === "archived") throw conflict("This course is archived.");
    if (opts.focusConceptId) {
      const [c] = await t`select 1 from concepts where id = ${opts.focusConceptId} and course_id = ${courseId}`;
      if (!c) throw notFound("Concept");
    }
    await t`update courses set last_opened_at = now() where id = ${courseId}`;
    const [open] = await t<SessionRow[]>`select * from sessions where course_id = ${courseId} and status in ('active','paused') for no key update`;
    if (open && (!opts.kind || opts.kind === open.kind)) {
      const checkpoint = opts.focusConceptId ? { ...open.checkpoint_json, focusConceptId: opts.focusConceptId } : open.checkpoint_json;
      await t`update sessions set status = 'active', checkpoint_json = ${json(checkpoint)}, version = version + 1 where id = ${open.id}`;
      if (open.status === "paused") await track(ownerId, "course_resumed", {}, t);
      return { sessionId: open.id, needsActivity: !open.current_activity_id };
    }
    // A different session kind was explicitly requested: close the open one (its records persist).
    if (open) await t`update sessions set status = 'completed', ended_at = now() where id = ${open.id}`;
    const [{ due }] = await t<{ due: number }[]>`
      select count(*)::int as due from review_items where course_id = ${courseId} and status = 'active' and due_at <= now()`;
    if (opts.kind === "review" && due === 0) throw conflict("Nothing is due for review in this course.");
    if (opts.kind === "placement" || opts.kind === "assessment") {
      const concepts = await loadConceptStates(t, courseId);
      const plan = concepts.filter((c) => c.inPlan);
      if (opts.kind === "placement" && plan.length < MIN_CONCEPTS_FOR_PLACEMENT) throw conflict("This course is too small for a placement check.");
      if (opts.kind === "assessment" && (plan.length === 0 || plan.some((c) => c.mastery !== "demonstrated"))) {
        throw conflict("The final check unlocks once every concept in the plan is demonstrated.");
      }
    }
    const kind = opts.kind ?? (due > 0 && !opts.focusConceptId ? "review" : "lesson");
    const [s] = await t<{ id: string }[]>`
      insert into sessions (course_id, owner_id, kind, checkpoint_json) values (${courseId}, ${ownerId}, ${kind}, ${json({ focusConceptId: opts.focusConceptId ?? null })})
      returning id`;
    return { sessionId: s.id, needsActivity: true };
  });
  let error: InlineError | null = null;
  if (needsActivity) {
    try {
      await advanceSession(ownerId, sessionId, null);
    } catch (e) {
      if (!(e instanceof AppError) || !e.retryable) throw e;
      error = { code: e.code, message: e.message, retryable: true };
    }
  }
  return getSessionView(ownerId, sessionId, error);
}

export async function pauseSession(ownerId: string, sessionId: string) {
  await tx(async (t) => {
    const s = await loadSession(t, ownerId, sessionId, true);
    if (s.status === "completed") throw conflict("This session is already complete.");
    await t`update sessions set status = 'paused', checkpoint_json = ${json({ ...s.checkpoint_json, pausedAt: new Date().toISOString() })}, version = version + 1 where id = ${s.id}`;
  });
  return getSessionView(ownerId, sessionId);
}

/**
 * Server-owned transition: completes the current activity (only once it has
 * feedback, or is an explanation) and either generates the next validated
 * activity or completes the session. A stale `fromActivityId` is a no-op that
 * returns the current state, so double clicks never create two activities.
 *
 * No database connection is held while the model runs: the step is decided
 * from a plain read, generated outside any transaction, then applied in a
 * short transaction that re-checks the session hasn't moved. A claim on the
 * session makes a concurrent request wait instead of generating a duplicate.
 */
export async function advanceSession(ownerId: string, sessionId: string, fromActivityId: string | null) {
  let newActivityId: string | null = null;
  const guard = (a: ActivityRow) => {
    if (a.status === "presented" && a.kind !== "explanation") throw conflict("Answer or skip this activity first.");
    if (a.status === "evaluating") throw conflict("This answer is still being graded.");
  };
  await withClaim(`session:${sessionId}`, async () => {
    type Generated = { spec: ActivitySpec; info: ModelInfo; prepared?: { mode: string; waitedMs: number } };
    const generatedBySignature = new Map<string, Generated>();
    for (let attempt = 0; attempt < 3; attempt++) {
      // 1. Decide (plain reads, no locks).
      const s = await loadSession(db(), ownerId, sessionId);
      if (s.status === "completed") return;
      if ((s.current_activity_id ?? null) !== fromActivityId) return; // stale request
      if (s.current_activity_id) {
        const [a] = await db()<ActivityRow[]>`select * from activities where id = ${s.current_activity_id}`;
        guard(a);
      }
      const { course, concepts, stepsRows, decision } = await planNext(db(), ownerId, s);
      const seq = stepsRows.length + 1;

      // 2. Generate (no transaction, no connection held).
      let generated: Generated | null = null;
      if (decision.action === "activity") {
        const sig = signature(decision);
        generated = generatedBySignature.get(sig) ?? null;
        if (!generated) {
          const prepared = s.current_activity_id ? await takePrepared(s.id, s.current_activity_id, sig) : null;
          generated = prepared
            ? { spec: prepared.spec, info: prepared.info, prepared: { mode: prepared.mode, waitedMs: prepared.waitedMs } }
            : await generateSpec(ownerId, await buildActivityContext(db(), ownerId, course, concepts, s, decision, seq), decision);
          generatedBySignature.set(sig, generated);
        }
      }

      // 3. Apply (short transaction; re-check that nothing moved meanwhile).
      const outcome = await tx(async (t) => {
        const cur = await loadSession(t, ownerId, sessionId, true);
        if (cur.status === "completed" || (cur.current_activity_id ?? null) !== fromActivityId) return "done" as const;
        if (cur.version !== s.version) return "retry" as const; // paused / difficulty changed while generating
        if (cur.status === "paused") await t`update sessions set status = 'active' where id = ${cur.id}`;
        if (cur.current_activity_id) {
          const [a] = await t<ActivityRow[]>`select * from activities where id = ${cur.current_activity_id} for no key update`;
          guard(a);
          if (a.status !== "completed") await t`update activities set status = 'completed' where id = ${a.id}`;
        }
        if (decision.action === "complete") {
          const titleOf = (id: string) => concepts.find((c) => c.id === id)?.title ?? "";
          const summary: SessionSummary = {
            reason: decision.reason,
            assessed: stepsRows.filter((r) => r.result && r.result !== "exposure").length,
            correct: stepsRows.filter((r) => r.result === "correct").length,
            conceptsTouched: [...new Set(stepsRows.map((r) => titleOf(r.concept_id)).filter(Boolean))],
          };
          const reflRows = await t<{ text: string }[]>`
            select at.submission_json->>'text' as text from attempts at join activities a on a.id = at.activity_id
            where a.session_id = ${cur.id} and a.kind = 'reflection' and at.submission_json ? 'text'
            order by a.sequence_no asc`;
          const reflections = reflRows.map((r) => r.text?.trim()).filter((x): x is string => Boolean(x && x.length >= 2));
          if (reflections.length > 0) summary.reflections = reflections;
          if (cur.kind === "placement") {
            summary.placement = stepsRows.map((r) => ({
              conceptId: r.concept_id,
              title: titleOf(r.concept_id),
              result: r.result === "correct" || r.result === "partial" || r.result === "incorrect" ? r.result : "unknown",
            }));
            // Suggest the first plan concept the learner didn't clearly show (by course order).
            const strong = new Set(stepsRows.filter((r) => r.result === "correct").map((r) => r.concept_id));
            const firstGap = concepts.filter((c) => c.inPlan).sort((a, b) => a.position - b.position).find((c) => !strong.has(c.id));
            summary.suggestedConceptId = firstGap?.id ?? null;
          }
          if (cur.kind === "assessment") {
            const finals = stepsRows.filter((r) => r.purpose === "final");
            const integrative = stepsRows.find((r) => r.purpose === "integrative");
            const missed = [...new Set(finals.filter((r) => r.result !== "correct").map((r) => titleOf(r.concept_id)))];
            const passed = finals.length > 0 && missed.length === 0 && !!integrative && (integrative.result === "correct" || integrative.result === "partial");
            if (integrative && !(integrative.result === "correct" || integrative.result === "partial")) missed.push("Putting it together");
            summary.assessment = { passed, missed };
            await t`insert into course_events (course_id, event_type, payload_json) values (${course.id}, 'final_assessment', ${json({ sessionId: cur.id, passed, missed })})`;
          }
          await t`update sessions set status = 'completed', ended_at = now(), checkpoint_json = ${json({ ...cur.checkpoint_json, summary })}, version = version + 1 where id = ${cur.id}`;
          await t`insert into course_events (course_id, event_type, payload_json) values (${course.id}, 'session_completed', ${json({ sessionId: cur.id, ...summary, conceptsTouched: summary.conceptsTouched.length })})`;
          await track(ownerId, "session_completed", { kind: cur.kind, activities: stepsRows.length }, t);
          return "done" as const;
        }
        const g = generated!;
        const activityId = await insertActivity(t, cur, course, decision, seq, g.spec, {
          ...g.info,
          plannerReason: decision.reason,
          prefetched: !!g.prepared,
          ...(g.prepared ? { prefetchMode: g.prepared.mode, prefetchWaitMs: g.prepared.waitedMs } : {}),
        });
        if (cur.current_activity_id) await t`delete from prepared_activities where session_id = ${cur.id} and after_activity_id = ${cur.current_activity_id}`;
        await t`update sessions set current_activity_id = ${activityId}, version = version + 1 where id = ${cur.id}`;
        if (stepsRows.length === 0) await track(ownerId, "first_activity_rendered", { kind: decision.kind }, t);
        newActivityId = activityId;
        return "done" as const;
      });
      if (outcome === "done") return;
    }
    throw new AppError("conflict", "This lesson changed while Ada was preparing the next step. Try again.", true);
  });
  // While the learner works on this activity, prepare the next one if its outcome can't change it.
  if (newActivityId) await runAfterResponse("prepare_next", () => prepareNext(ownerId, sessionId));
  return getSessionView(ownerId, sessionId);
}

/** "Harder" / "Easier": shifts difficulty for the rest of this lesson (applies from the next question). */
export async function setDifficulty(ownerId: string, sessionId: string, offset: -1 | 0 | 1) {
  await tx(async (t) => {
    const s = await loadSession(t, ownerId, sessionId, true);
    if (s.status === "completed") throw conflict("This session is complete.");
    if (s.kind !== "lesson") throw conflict("Difficulty can be changed during lessons.");
    await t`update sessions set checkpoint_json = ${json({ ...s.checkpoint_json, difficultyOffset: offset })}, version = version + 1 where id = ${s.id}`;
  });
  // Anything prepared at the old difficulty won't match; prepare again at the new one.
  await runAfterResponse("prepare_next", () => prepareNext(ownerId, sessionId));
  return getSessionView(ownerId, sessionId);
}
