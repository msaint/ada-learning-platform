import { db, json, tx } from "@/lib/db/client";
import { AppError, conflict, notFound } from "@/lib/errors";
import { callModel } from "@/lib/ai";
import { validateExpansion } from "@/lib/learning/curriculum";
import { estimateReadiness } from "@/lib/learning/readiness";
import { formatInZone } from "@/lib/learning/review-scheduler";
import type { CourseHeader, CourseListItem, CourseProgress, OutlineView } from "@/lib/schemas/dto";
import type { FetchedSource } from "@/lib/ai/model-adapter";
import { insertConcepts } from "./drafts";
import { computeNextAction, loadActiveGoal, loadConceptStates, loadCourse, loadFinalPassed, loadPlan, type ConceptState } from "./learning-state";
import { track } from "./telemetry";

export async function listCourses(ownerId: string): Promise<CourseListItem[]> {
  const rows = await db()<{ id: string; title: string; intent: "curiosity" | "goal"; updated_at: Date; due: number; open_kind: string | null }[]>`
    select c.id, c.title, c.intent, greatest(c.updated_at, c.last_opened_at) as updated_at,
      (select count(*)::int from review_items r where r.course_id = c.id and r.status = 'active' and r.due_at <= now()) as due,
      (select s.kind from sessions s where s.course_id = c.id and s.status in ('active','paused') limit 1) as open_kind
    from courses c where c.owner_id = ${ownerId} and c.status <> 'archived'
    order by c.last_opened_at desc limit 200`;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    intent: r.intent,
    updatedAt: r.updated_at.toISOString(),
    reviewDueCount: r.due,
    hasOpenSession: !!r.open_kind,
    nextActionLabel: r.open_kind ? "Continue" : r.due ? "Review due" : null,
  }));
}

export async function getCourseHeader(ownerId: string, courseId: string, touch = true): Promise<CourseHeader> {
  const course = await loadCourse(db(), ownerId, courseId);
  if (touch) await db()`update courses set last_opened_at = now() where id = ${courseId}`;
  const goal = await loadActiveGoal(db(), course);
  const history = await db()<{ version: number; goal_text: string; reason: string | null; created_at: Date }[]>`
    select version, goal_text, reason, created_at from course_goal_versions where course_id = ${courseId} order by version desc`;
  const [open] = await db()<{ id: string; kind: "lesson" | "review" | "placement" | "assessment"; status: "active" | "paused" }[]>`
    select id, kind, status from sessions where course_id = ${courseId} and status in ('active','paused') limit 1`;
  const concepts = await loadConceptStates(db(), courseId);
  const finalPassed = await loadFinalPassed(db(), courseId);
  const planConcepts = concepts.filter((c) => c.inPlan);
  const scoped = planConcepts.length > 0 ? planConcepts : concepts;
  return {
    id: course.id,
    title: course.title,
    topic: course.topic,
    intent: course.intent,
    status: course.status,
    version: course.version,
    goal: { version: goal.version, text: goal.goal_text, successCriteria: goal.success_criteria_json, timeBudgetMinutesWeekly: goal.time_budget_minutes_weekly, createdAt: goal.created_at.toISOString() },
    goalHistory: history.map((h) => ({ version: h.version, text: h.goal_text, reason: h.reason, createdAt: h.created_at.toISOString() })),
    nextAction: computeNextAction(concepts, course.intent, open ?? null, { finalPassed }),
    openSession: open ?? null,
    reviewDueCount: concepts.filter((c) => c.display === "review_due").length,
    conceptSummary: {
      total: scoped.length,
      demonstrated: scoped.filter((c) => c.mastery === "demonstrated").length,
      developing: scoped.filter((c) => c.mastery === "developing").length,
    },
  };
}

export async function patchCourse(ownerId: string, courseId: string, input: { title?: string; status?: "active" | "paused" | "archived"; expectedVersion: number }) {
  return tx(async (t) => {
    const c = await loadCourse(t, ownerId, courseId, true);
    if (c.version !== input.expectedVersion) throw conflict("This course was changed elsewhere. Reload to see the latest.");
    await t`update courses set title = ${input.title ?? c.title}, status = ${input.status ?? c.status}, version = version + 1 where id = ${courseId}`;
    return { id: courseId, version: c.version + 1 };
  });
}

/** Deletes the course; ON DELETE CASCADE removes sessions, activities, attempts, evidence, reviews, events and notifications. */
export async function deleteCourse(ownerId: string, courseId: string) {
  await tx(async (t) => {
    await loadCourse(t, ownerId, courseId, true);
    await t`delete from courses where id = ${courseId} and owner_id = ${ownerId}`;
  });
}

/** Appends a goal version, re-plans relative to the new goal, preserves all evidence. */
export async function reviseGoal(ownerId: string, courseId: string, input: { goalText: string; intent?: "curiosity" | "goal"; reason?: string; timeBudgetMinutesWeekly?: number | null }) {
  const course = await loadCourse(db(), ownerId, courseId);
  const goal = await loadActiveGoal(db(), course);
  const concepts = await loadConceptStates(db(), courseId);
  const intent = input.intent ?? course.intent;
  const { value, info } = await callModel(ownerId, "expand", (m) =>
    m.expandCurriculum({
      mode: "revise",
      topic: course.topic,
      intent,
      goalText: input.goalText,
      previousGoalText: goal.goal_text,
      request: input.reason ?? "Learner changed their goal",
      existing: concepts.map((c) => ({ slug: c.slug, title: c.title, status: c.display })),
      linkContext: goal.baseline_json?.link_context ?? null,
    }),
  );
  const checked = validateExpansion(value, concepts.map((c) => c.slug), "revise");
  if (!checked.ok) throw new AppError("model_invalid_output", "The revised plan wasn't usable. Please retry.", true);
  const exp = checked.value;
  const result = await tx(async (t) => {
    const c = await loadCourse(t, ownerId, courseId, true);
    const [{ v }] = await t<{ v: number }[]>`select coalesce(max(version), 0)::int as v from course_goal_versions where course_id = ${courseId}`;
    const [g] = await t<{ id: string }[]>`
      insert into course_goal_versions (course_id, version, intent, goal_text, success_criteria_json, time_budget_minutes_weekly, baseline_json, depth, reason)
      values (${courseId}, ${v + 1}, ${intent}, ${input.goalText}, ${json(exp.success_criteria)},
              ${input.timeBudgetMinutesWeekly === undefined ? goal.time_budget_minutes_weekly : input.timeBudgetMinutesWeekly},
              ${json(goal.baseline_json)}, ${goal.depth}, ${input.reason ?? "goal revised"})
      returning id`;
    await t`update courses set active_goal_version_id = ${g.id}, intent = ${intent}, version = version + 1 where id = ${courseId}`;
    const existing = new Map(concepts.map((x) => [x.slug, x.id]));
    const [{ maxPos }] = await t<{ maxPos: number }[]>`select coalesce(max(position), 0)::int as "maxPos" from concepts where course_id = ${courseId}`;
    await insertConcepts(t, courseId, exp.new_concepts, maxPos + 1, "revision", existing);
    const plan = await loadPlan(t, courseId);
    const factCheckSlugs = [...new Set([...(plan.plan_json.fact_check_slugs ?? []), ...exp.new_concepts.filter((n) => n.needs_fact_check).map((n) => n.slug)])];
    await t`insert into course_curriculum_versions (course_id, version, plan_json, reason, model_info_json)
      values (${courseId}, ${plan.version + 1}, ${json({ direction: exp.direction, required_slugs: [...exp.keep_slugs, ...exp.new_concepts.map((n) => n.slug)], fact_check_slugs: factCheckSlugs, explanation: exp.explanation, goal_version: v + 1 })}, 'goal_revised', ${json(info)})`;
    await t`insert into course_events (course_id, event_type, payload_json) values (${courseId}, 'goal_revised', ${json({ from: goal.version, to: v + 1, added: exp.new_concepts.length, kept: exp.keep_slugs.length })})`;
    return { goalVersion: v + 1, explanation: exp.explanation, added: exp.new_concepts.map((n) => n.title), courseVersion: c.version + 1 };
  });
  await track(ownerId, "course_goal_revised", { added: result.added.length });
  return result;
}

/** Follows a curiosity branch inside the same course: extends the graph, never creates a new course or chat. */
export async function addBranch(ownerId: string, courseId: string, question: string) {
  const course = await loadCourse(db(), ownerId, courseId);
  const goal = await loadActiveGoal(db(), course);
  const concepts = await loadConceptStates(db(), courseId);
  const { value, info } = await callModel(ownerId, "expand", (m) =>
    m.expandCurriculum({
      mode: "branch",
      topic: course.topic,
      intent: course.intent,
      goalText: goal.goal_text,
      request: question,
      existing: concepts.map((c) => ({ slug: c.slug, title: c.title, status: c.display })),
      linkContext: goal.baseline_json?.link_context ?? null,
    }),
  );
  const checked = validateExpansion(value, concepts.map((c) => c.slug), "branch");
  if (!checked.ok) throw new AppError("model_invalid_output", "The branch wasn't usable. Please retry.", true);
  const exp = checked.value;
  return tx(async (t) => {
    await loadCourse(t, ownerId, courseId, true);
    const existing = new Map(concepts.map((x) => [x.slug, x.id]));
    const [{ maxPos }] = await t<{ maxPos: number }[]>`select coalesce(max(position), 0)::int as "maxPos" from concepts where course_id = ${courseId}`;
    const ids = await insertConcepts(t, courseId, exp.new_concepts, maxPos + 1, "branch", existing);
    if (exp.anchor_slug) {
      for (const n of exp.new_concepts) {
        if (!n.prerequisites.includes(exp.anchor_slug)) {
          await t`insert into concept_edges (course_id, from_concept_id, to_concept_id, edge_type) values (${courseId}, ${ids.get(exp.anchor_slug)!}, ${ids.get(n.slug)!}, 'related') on conflict do nothing`;
        }
      }
    }
    const plan = await loadPlan(t, courseId);
    const required = [...(plan.plan_json.required_slugs ?? concepts.map((c) => c.slug)), ...exp.new_concepts.map((n) => n.slug)];
    const factCheckSlugs = [...new Set([...(plan.plan_json.fact_check_slugs ?? []), ...exp.new_concepts.filter((n) => n.needs_fact_check).map((n) => n.slug)])];
    await t`insert into course_curriculum_versions (course_id, version, plan_json, reason, model_info_json)
      values (${courseId}, ${plan.version + 1}, ${json({ ...plan.plan_json, required_slugs: required, fact_check_slugs: factCheckSlugs, explanation: exp.explanation })}, 'branch', ${json(info)})`;
    await t`insert into course_events (course_id, event_type, payload_json) values (${courseId}, 'branch_added', ${json({ added: exp.new_concepts.length })})`;
    const firstId = ids.get(exp.new_concepts[0].slug)!;
    return { conceptIds: exp.new_concepts.map((n) => ids.get(n.slug)!), firstConceptId: firstId, explanation: exp.explanation };
  });
}

/**
 * Breaks a concept down into 1–2 simpler prerequisite stepping stones when a learner
 * is struggling, inserting prerequisite edges into the target concept without losing history.
 */
export async function addPrerequisiteScaffold(ownerId: string, courseId: string, conceptId: string) {
  const course = await loadCourse(db(), ownerId, courseId);
  const goal = await loadActiveGoal(db(), course);
  const concepts = await loadConceptStates(db(), courseId);
  const target = concepts.find((c) => c.id === conceptId);
  if (!target) throw notFound("Concept");
  const misconceptions = await db()<{ m: string }[]>`
    select at.feedback_json->>'misconception' as m from attempts at join activities a on a.id = at.activity_id
    where a.concept_id = ${conceptId} and at.feedback_json->>'misconception' is not null order by at.submitted_at desc limit 3`;
  const struggleSummary = misconceptions.length
    ? `Repeated misses on "${target.title}". Suspected misconceptions: ${misconceptions.map((x) => x.m).join("; ")}`
    : `Repeated misses on "${target.title}". Learner asked to break this concept into simpler stepping stones.`;
  const { value, info } = await callModel(ownerId, "expand", (m) =>
    m.expandCurriculum({
      mode: "scaffold",
      topic: course.topic,
      intent: course.intent,
      goalText: goal.goal_text,
      request: struggleSummary,
      existing: concepts.map((c) => ({ slug: c.slug, title: c.title, status: c.display })),
      targetConcept: { slug: target.slug, title: target.title, description: target.description },
      linkContext: goal.baseline_json?.link_context ?? null,
    }),
  );
  // Ensure new stepping-stone concepts never depend on the target itself (which would create a cycle once linked as prerequisites of target).
  const sanitized = {
    ...value,
    new_concepts: value.new_concepts.slice(0, 2).map((n) => ({ ...n, prerequisites: n.prerequisites.filter((p) => p !== target.slug) })),
  };
  const checked = validateExpansion(sanitized, concepts.map((c) => c.slug), "scaffold");
  if (!checked.ok) throw new AppError("model_invalid_output", "Couldn't build stepping stones for that concept. Please retry.", true);
  const exp = checked.value;
  const result = await tx(async (t) => {
    await loadCourse(t, ownerId, courseId, true);
    const existing = new Map(concepts.map((x) => [x.slug, x.id]));
    const [{ maxPos }] = await t<{ maxPos: number }[]>`select coalesce(max(position), 0)::int as "maxPos" from concepts where course_id = ${courseId}`;
    const ids = await insertConcepts(t, courseId, exp.new_concepts, maxPos + 1, "revision", existing);
    // Link every newly created stepping stone as a prerequisite of the struggling target concept.
    for (const n of exp.new_concepts) {
      const newId = ids.get(n.slug)!;
      await t`insert into concept_edges (course_id, from_concept_id, to_concept_id, edge_type) values (${courseId}, ${newId}, ${target.id}, 'prerequisite') on conflict do nothing`;
    }
    const plan = await loadPlan(t, courseId);
    const required = [...new Set([...(plan.plan_json.required_slugs ?? concepts.map((c) => c.slug)), ...exp.new_concepts.map((n) => n.slug)])];
    const factCheckSlugs = [...new Set([...(plan.plan_json.fact_check_slugs ?? []), ...exp.new_concepts.filter((n) => n.needs_fact_check).map((n) => n.slug)])];
    await t`insert into course_curriculum_versions (course_id, version, plan_json, reason, model_info_json)
      values (${courseId}, ${plan.version + 1}, ${json({ ...plan.plan_json, required_slugs: required, fact_check_slugs: factCheckSlugs, explanation: exp.explanation || `Added simpler stepping stones before "${target.title}".` })}, 'scaffold', ${json(info)})`;
    await t`insert into course_events (course_id, event_type, payload_json) values (${courseId}, 'concept_scaffolded', ${json({ targetConceptId: target.id, added: exp.new_concepts.length })})`;
    const firstId = ids.get(exp.new_concepts[0].slug)!;
    return { conceptIds: exp.new_concepts.map((n) => ids.get(n.slug)!), firstConceptId: firstId, explanation: exp.explanation };
  });
  await track(ownerId, "concept_scaffolded", { added: result.conceptIds.length });
  return result;
}

function depthOf(c: ConceptState, byId: Map<string, ConceptState>, seen = new Set<string>()): number {
  if (seen.has(c.id) || c.prerequisiteIds.length === 0) return 0;
  seen.add(c.id);
  return 1 + Math.max(...c.prerequisiteIds.map((p) => (byId.get(p) ? depthOf(byId.get(p)!, byId, seen) : -1)));
}

export async function getOutline(ownerId: string, courseId: string): Promise<OutlineView> {
  await loadCourse(db(), ownerId, courseId);
  const concepts = await loadConceptStates(db(), courseId);
  const plan = await loadPlan(db(), courseId);
  const evidence = await db()<{ concept_id: string; result: string; independence: string; activity_kind: string; created_at: Date; reason: string }[]>`
    select concept_id, result, independence, activity_kind, created_at, reason from assessment_evidence
    where course_id = ${courseId} order by created_at desc`;
  const relatedEdges = await db()<{ from_concept_id: string; to_concept_id: string }[]>`
    select from_concept_id, to_concept_id from concept_edges where course_id = ${courseId} and edge_type = 'related'`;
  const explanations = await db()<{
    id: string;
    concept_id: string;
    spec_json: { title?: string; bodyMarkdown?: string };
    alt_explanations_json: { text: string }[];
    model_info_json: Record<string, unknown>;
    created_at: Date;
  }[]>`
    select id, concept_id, spec_json, alt_explanations_json, model_info_json, created_at from activities
    where course_id = ${courseId} and kind = 'explanation' order by created_at asc`;
  const sourceRows = await db()<{ activity_id: string; title: string; url: string }[]>`
    select activity_id, title, url from source_references
    where course_id = ${courseId} and activity_id is not null order by retrieved_at asc`;

  const sourcesByActivity = new Map<string, { url: string; title: string | null }[]>();
  for (const s of sourceRows) {
    const list = sourcesByActivity.get(s.activity_id) ?? [];
    if (!list.some((x) => x.url === s.url)) list.push({ url: s.url, title: s.title || null });
    sourcesByActivity.set(s.activity_id, list);
  }

  const byId = new Map(concepts.map((c) => [c.id, c]));
  return {
    courseId,
    curriculumVersion: plan.version,
    revisionNote: plan.plan_json.explanation ?? null,
    concepts: concepts.map((c) => {
      const conceptEvidence = evidence.filter((e) => e.concept_id === c.id);
      const misses = conceptEvidence.filter((e) => e.result === "incorrect" || e.result === "partial").length;
      const unlocksTitles = concepts.filter((other) => other.prerequisiteIds.includes(c.id)).map((other) => other.title);
      const relatedIds = new Set<string>();
      for (const edge of relatedEdges) {
        if (edge.from_concept_id === c.id) relatedIds.add(edge.to_concept_id);
        if (edge.to_concept_id === c.id) relatedIds.add(edge.from_concept_id);
      }
      const relatedTitles = [...relatedIds].map((id) => byId.get(id)?.title ?? "").filter(Boolean);
      const notes = explanations
        .filter((a) => a.concept_id === c.id && typeof a.spec_json?.bodyMarkdown === "string" && a.spec_json.bodyMarkdown.length > 0)
        .map((a) => {
          const mergedSources = new Map<string, { url: string; title: string | null }>();
          for (const s of sourcesByActivity.get(a.id) ?? []) mergedSources.set(s.url, s);
          for (const s of ((a.model_info_json?.sources as FetchedSource[] | undefined) ?? []).filter((x) => /^https?:\/\//i.test(x.url))) {
            if (!mergedSources.has(s.url)) mergedSources.set(s.url, { url: s.url, title: s.title });
          }
          return {
            id: a.id,
            title: a.spec_json.title ?? null,
            bodyMarkdown: a.spec_json.bodyMarkdown!,
            altExplanations: (a.alt_explanations_json ?? []).map((x) => x.text).filter(Boolean),
            sources: [...mergedSources.values()],
            at: a.created_at.toISOString(),
          };
        });
      return {
        id: c.id,
        slug: c.slug,
        title: c.title,
        description: c.description,
        criteria: c.criteria,
        status: c.display,
        depth: Math.min(3, depthOf(c, byId)),
        prerequisiteTitles: c.prerequisiteIds.map((p) => byId.get(p)?.title ?? "").filter(Boolean),
        unmetPrerequisiteTitles: c.prerequisiteIds
          .map((p) => byId.get(p))
          .filter((p): p is NonNullable<typeof p> => Boolean(p && p.mastery !== "demonstrated"))
          .map((p) => p.title),
        unlocksTitles,
        relatedTitles,
        struggling: c.mastery !== "demonstrated" && misses >= 2,
        notes,
        origin: c.origin,
        inCurrentPlan: c.inPlan,
        evidence: conceptEvidence
          .slice(0, 6)
          .map((e) => ({ result: e.result, independence: e.independence, kind: e.activity_kind, at: e.created_at.toISOString(), reason: e.result === "exposure" ? "" : e.reason.slice(0, 200) })),
      };
    }),
  };
}

export async function getProgress(ownerId: string, courseId: string, timezone: string): Promise<CourseProgress> {
  const course = await loadCourse(db(), ownerId, courseId);
  const goal = await loadActiveGoal(db(), course);
  const concepts = await loadConceptStates(db(), courseId);
  const [open] = await db()<{ kind: string }[]>`select kind from sessions where course_id = ${courseId} and status in ('active','paused') limit 1`;
  const [counts] = await db()<{ sessions: number; activities: number }[]>`
    select (select count(*)::int from sessions where course_id = ${courseId}) as sessions,
           (select count(*)::int from activities where course_id = ${courseId}) as activities`;
  const reviews = await db()<{ concept_id: string; title: string; due_at: Date }[]>`
    select c.id as concept_id, c.title, r.due_at from review_items r join concepts c on c.id = r.concept_id
    where r.course_id = ${courseId} and r.status = 'active' order by r.due_at limit 10`;
  const now = new Date();
  const finalPassed = await loadFinalPassed(db(), courseId);
  const progress: CourseProgress = {
    courseId,
    intent: course.intent,
    goalText: goal.goal_text,
    concepts: concepts.map((c) => ({ id: c.id, title: c.title, status: c.display, evidenceCount: c.evidenceCount, reason: c.masteryReason })),
    canDo: concepts.filter((c) => c.mastery === "demonstrated").map((c) => ({ id: c.id, title: c.title, criteria: c.criteria })),
    needsPractice: concepts.filter((c) => c.mastery === "developing").map((c) => ({ id: c.id, title: c.title, reason: c.masteryReason })),
    dueToRevisit: reviews.map((r) => ({
      conceptId: r.concept_id,
      conceptTitle: r.title,
      dueAt: r.due_at.toISOString(),
      dueLabel: r.due_at <= now ? "Due now" : formatInZone(r.due_at, timezone),
      dueNow: r.due_at <= now,
    })),
    activity: counts,
    nextAction: computeNextAction(concepts, course.intent, open ?? null, { finalPassed }),
  };
  if (course.intent === "goal") {
    const required = concepts.filter((c) => c.inPlan);
    progress.readiness = estimateReadiness(
      required.map((c) => ({ slug: c.slug, title: c.title, status: c.mastery, importance: c.importance, prerequisites: c.prerequisiteIds.map((p) => concepts.find((x) => x.id === p)?.slug ?? ""), evidenceCount: c.evidenceCount })),
      { finalAssessmentPassed: finalPassed },
    );
  } else {
    const explored = await db()<{ concept_id: string }[]>`select distinct concept_id from activities where course_id = ${courseId}`;
    const exploredSet = new Set(explored.map((e) => e.concept_id));
    const explanations = await db()<{ title: string; created_at: Date }[]>`
      select c.title, e.created_at from assessment_evidence e join concepts c on c.id = e.concept_id
      where e.course_id = ${courseId} and e.activity_kind = 'free_response' and e.result = 'correct' order by e.created_at desc limit 5`;
    const reflections = await db()<{ text: string }[]>`
      select at.submission_json->>'text' as text from attempts at join activities a on a.id = at.activity_id
      where a.course_id = ${courseId} and a.kind = 'reflection' and at.submission_json ? 'text' order by at.submitted_at desc limit 5`;
    progress.curiosity = {
      exploredCount: exploredSet.size,
      branchCount: concepts.filter((c) => c.origin === "branch").length,
      recentExplanations: explanations.map((e) => ({ conceptTitle: e.title, at: formatInZone(e.created_at, timezone) })),
      openQuestions: reflections.map((r) => r.text).filter(Boolean),
      suggestedBranches: concepts.filter((c) => !exploredSet.has(c.id)).slice(0, 4).map((c) => c.title),
    };
  }
  return progress;
}
