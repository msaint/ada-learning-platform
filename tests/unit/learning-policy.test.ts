import { describe, expect, it } from "vitest";
import { computeMastery, displayStatus, type EvidenceRecord } from "@/lib/learning/mastery";
import { INTERVAL_LADDER, initialReview, nextReview, postpone, formatInZone } from "@/lib/learning/review-scheduler";
import { estimateReadiness } from "@/lib/learning/readiness";
import { topoOrder, validateCurriculum, validateExpansion } from "@/lib/learning/curriculum";
import { chooseNext, type PlannerConcept } from "@/lib/learning/next-action";
import { CurriculumProposalSchema, MultipleChoiceGenSchema, type CurriculumProposal } from "@/lib/schemas/model";
import { ConvertDraftBody } from "@/lib/schemas/api";
import { describeDueReview } from "@/lib/services/account";
import { draftView, MAX_QUESTIONS } from "@/lib/services/drafts";
import { computeTargetSteps } from "@/lib/services/sessions";

const t0 = new Date("2026-01-01T12:00:00Z");
const ev = (o: Partial<EvidenceRecord> & { activityId: string }, minutes = 0): EvidenceRecord => ({
  result: "correct",
  independence: "independent",
  difficulty: 1,
  purpose: "check",
  createdAt: new Date(t0.getTime() + minutes * 60_000),
  ...o,
});

describe("mastery policy", () => {
  it("no evidence → not assessed; exposure alone doesn't count", () => {
    expect(computeMastery([]).status).toBe("not_assessed");
    expect(computeMastery([ev({ activityId: "a", result: "exposure" })]).status).toBe("not_assessed");
  });
  it("one easy success is developing", () => {
    expect(computeMastery([ev({ activityId: "a" })]).status).toBe("developing");
  });
  it("two independent successes incl. difficulty ≥2 → demonstrated (provisional)", () => {
    const m = computeMastery([ev({ activityId: "a" }), ev({ activityId: "b", difficulty: 2 }, 5)]);
    expect(m.status).toBe("demonstrated");
    expect(m.confidence).toBe("provisional");
  });
  it("two easy successes are not enough", () => {
    expect(computeMastery([ev({ activityId: "a" }), ev({ activityId: "b" }, 1)]).status).toBe("developing");
  });
  it("the same activity twice is not two pieces of evidence", () => {
    expect(computeMastery([ev({ activityId: "a", difficulty: 2 }), ev({ activityId: "a", difficulty: 2 }, 1)]).status).toBe("developing");
  });
  it("assisted successes never demonstrate", () => {
    const m = computeMastery([
      ev({ activityId: "a", independence: "assisted", difficulty: 2 }),
      ev({ activityId: "b", independence: "assisted", difficulty: 3 }, 1),
      ev({ activityId: "c", independence: "assisted", difficulty: 2 }, 2),
    ]);
    expect(m.status).toBe("developing");
    expect(m.details.reason).toMatch(/with help/i);
  });
  it("a delayed successful review consolidates", () => {
    const m = computeMastery([ev({ activityId: "a" }), ev({ activityId: "b", difficulty: 2 }, 5), ev({ activityId: "c", difficulty: 2, purpose: "review" }, 60 * 24 + 10)]);
    expect(m.confidence).toBe("consolidated");
  });
  it("a latest miss drops back to developing", () => {
    expect(computeMastery([ev({ activityId: "a" }), ev({ activityId: "b", difficulty: 2 }, 5), ev({ activityId: "c", result: "incorrect" }, 9)]).status).toBe("developing");
  });
  it("review due overlays only evidenced concepts", () => {
    const past = new Date(Date.now() - 1000);
    expect(displayStatus("developing", past)).toBe("review_due");
    expect(displayStatus("not_assessed", past)).toBe("not_assessed");
    expect(displayStatus("demonstrated", new Date(Date.now() + 1e6))).toBe("demonstrated");
  });
});

describe("review scheduler", () => {
  it("first review is +1 day, then follows the ladder on independent success", () => {
    const r0 = initialReview(t0);
    expect(r0.dueAt.getTime() - t0.getTime()).toBe(864e5);
    let state = { intervalDays: r0.intervalDays, repetitions: r0.repetitions };
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      const n = nextReview(state, { result: "correct", independence: "independent" }, t0);
      seen.push(n.intervalDays);
      state = n;
    }
    expect(seen).toEqual([3, 7, 14, 30, 30]);
    expect(INTERVAL_LADDER).toEqual([1, 3, 7, 14, 30]);
  });
  it("incorrect resets, partial shortens, assisted does not expand", () => {
    expect(nextReview({ intervalDays: 14, repetitions: 3 }, { result: "incorrect", independence: "independent" }, t0)).toMatchObject({ intervalDays: 1, repetitions: 0 });
    expect(nextReview({ intervalDays: 14, repetitions: 3 }, { result: "partial", independence: "independent" }, t0).intervalDays).toBe(7);
    expect(nextReview({ intervalDays: 7, repetitions: 2 }, { result: "correct", independence: "assisted" }, t0)).toMatchObject({ intervalDays: 7, repetitions: 2 });
  });
  it("postpone moves forward from now or the due date and is bounded", () => {
    const now = t0;
    expect(postpone(new Date(t0.getTime() - 864e5), 1, now).getTime()).toBe(t0.getTime() + 864e5);
    expect(postpone(t0, 100, now).getTime()).toBe(t0.getTime() + 14 * 864e5);
  });
  it("formats absolute timestamps in the learner's zone", () => {
    expect(formatInZone(t0, "America/Los_Angeles")).toMatch(/4:00\sAM/);
    expect(formatInZone(t0, "Asia/Tokyo")).toMatch(/9:00\sPM/);
    expect(formatInZone(t0, "Bogus/Zone")).toMatch(/12:00\sPM/);
  });
});

describe("readiness", () => {
  const c = (slug: string, status: "not_assessed" | "developing" | "demonstrated", evidenceCount = 2, importance = 2, prerequisites: string[] = []) => ({ slug, title: slug, status, importance, prerequisites, evidenceCount });
  it("says not enough evidence when under-assessed", () => {
    expect(estimateReadiness([c("a", "developing", 1), c("b", "not_assessed", 0)]).band).toBe("unknown");
  });
  it("bands by coverage of core concepts, never a percentage", () => {
    expect(estimateReadiness([c("a", "developing"), c("b", "not_assessed", 1)]).band).toBe("developing");
    expect(estimateReadiness([c("a", "demonstrated"), c("b", "demonstrated"), c("c", "developing")]).band).toBe("approaching");
    const allShown = [c("a", "demonstrated"), c("b", "demonstrated")];
    expect(estimateReadiness(allShown).band).toBe("approaching");
    expect(estimateReadiness(allShown).basis).toMatch(/final check/);
    const all = estimateReadiness(allShown, { finalAssessmentPassed: true });
    expect(all.band).toBe("demonstrated");
    expect(all.basis).not.toMatch(/%/);
  });
  it("names prerequisite bottlenecks", () => {
    const r = estimateReadiness([c("a", "not_assessed", 2), c("b", "demonstrated", 2, 2, ["a"]), c("x", "demonstrated")]);
    expect(r.basis).toMatch(/Prerequisite still to show: a/);
  });
  it("never inflates developing concepts into demonstrated even if a review is overdue", () => {
    // Only underlying MasteryStatus ("demonstrated") counts; "developing" does not.
    const r = estimateReadiness([c("a", "developing", 3), c("b", "developing", 3)], { finalAssessmentPassed: true });
    expect(r.band).toBe("developing");
    expect(r.basis).toMatch(/0 of 2/);
  });
});

const concept = (slug: string, prerequisites: string[] = []) => ({ slug, title: slug.toUpperCase(), description: "d", assessment_criteria: ["can explain"], importance: 2, prerequisites, needs_fact_check: false });
const proposal = (concepts: CurriculumProposal["concepts"], first = concepts[0]?.slug ?? "x"): CurriculumProposal =>
  CurriculumProposalSchema.parse({ title: "T", direction: "D", concepts, first_concept_slug: first, success_criteria: [] });

describe("curriculum validation", () => {
  it("accepts a valid graph and orders prerequisites first", () => {
    const r = validateCurriculum(proposal([concept("c", ["b"]), concept("a"), concept("b", ["a"])], "a"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.concepts.map((x) => x.slug)).toEqual(["a", "b", "c"]);
  });
  it("rejects duplicate slugs, unknown refs, cycles and size limits", () => {
    expect(validateCurriculum(proposal([concept("a"), concept("a"), concept("b")]))).toMatchObject({ ok: false });
    expect(validateCurriculum(proposal([concept("a", ["zzz"]), concept("b"), concept("c")]))).toMatchObject({ ok: false });
    const cyc = validateCurriculum(proposal([concept("a", ["c"]), concept("b", ["a"]), concept("c", ["b"])]));
    expect(cyc.ok).toBe(false);
    if (!cyc.ok) expect(cyc.errors.join()).toMatch(/cycle/);
    expect(validateCurriculum(proposal([concept("a"), concept("b")]))).toMatchObject({ ok: false });
    expect(() => proposal(Array.from({ length: 31 }, (_, i) => concept(`n${i}`)))).toThrow();
  });
  it("repairs a first concept that has prerequisites", () => {
    const r = validateCurriculum(proposal([concept("a"), concept("b", ["a"]), concept("c")], "b"));
    expect(r.ok && r.value.first_concept_slug).toBe("a");
  });
  it("normalises slugs", () => {
    const p = proposal([concept("Hello World!"), concept("b"), concept("c")]);
    expect(p.concepts[0].slug).toBe("hello-world");
  });
  it("topoOrder returns null on cycles", () => {
    expect(topoOrder([{ slug: "a", prerequisites: ["b"] }, { slug: "b", prerequisites: ["a"] }])).toBeNull();
  });
  it("expansion rejects slug collisions and unknown anchors, and supports scaffold mode", () => {
    const base = { anchor_slug: null, keep_slugs: [], direction: "", success_criteria: [], explanation: "" };
    expect(validateExpansion({ ...base, new_concepts: [concept("a")] }, ["a"], "branch").ok).toBe(false);
    expect(validateExpansion({ ...base, anchor_slug: "nope", new_concepts: [concept("x")] }, ["a"], "branch").ok).toBe(false);
    expect(validateExpansion({ ...base, new_concepts: [concept("x", ["a"])] }, ["a"], "branch").ok).toBe(true);
    expect(validateExpansion({ ...base, anchor_slug: "a", new_concepts: [concept("prep-a")] }, ["a"], "scaffold").ok).toBe(true);
    expect(validateExpansion({ ...base, anchor_slug: "a", new_concepts: [] }, ["a"], "scaffold").ok).toBe(false);
  });
  it("defaults needs_fact_check to false when omitted", () => {
    const raw = (slug: string) => ({ slug, title: slug.toUpperCase(), description: "d", assessment_criteria: ["can explain"], importance: 2, prerequisites: [] });
    const p = CurriculumProposalSchema.parse({ title: "T", direction: "D", concepts: [raw("a"), raw("b"), raw("c")], first_concept_slug: "a", success_criteria: [] });
    expect(p.concepts.every((x) => x.needs_fact_check === false)).toBe(true);
  });
});

describe("activity schema", () => {
  it("rejects MC whose answer isn't a choice, duplicate choices, or order-dependent choices, and accepts optional reasoning", () => {
    const base = { kind: "multiple_choice", promptMarkdown: "Q", rationale: "R", difficulty: 1 };
    expect(MultipleChoiceGenSchema.safeParse({ ...base, choices: [{ id: "a", text: "1" }, { id: "b", text: "2" }, { id: "c", text: "3" }], correctChoiceId: "z" }).success).toBe(false);
    expect(MultipleChoiceGenSchema.safeParse({ ...base, choices: [{ id: "a", text: "1" }, { id: "b", text: "1" }, { id: "c", text: "3" }], correctChoiceId: "a" }).success).toBe(false);
    expect(MultipleChoiceGenSchema.safeParse({ ...base, choices: [{ id: "a", text: "1" }, { id: "b", text: "2" }, { id: "c", text: "All of the above" }], correctChoiceId: "c" }).success).toBe(false);
    expect(MultipleChoiceGenSchema.safeParse({ ...base, choices: [{ id: "a", text: "1" }, { id: "b", text: "2" }, { id: "c", text: "None of the above." }], correctChoiceId: "c" }).success).toBe(false);
    expect(MultipleChoiceGenSchema.safeParse({ ...base, choices: [{ id: "a", text: "1" }, { id: "b", text: "2" }, { id: "c", text: "Both A and B" }], correctChoiceId: "c" }).success).toBe(false);
    expect(MultipleChoiceGenSchema.safeParse({ ...base, choices: [{ id: "a", text: "1" }, { id: "b", text: "2" }, { id: "c", text: "3" }], correctChoiceId: "a" }).success).toBe(true);
    const withReasoning = MultipleChoiceGenSchema.safeParse({
      ...base,
      choices: [{ id: "a", text: "1" }, { id: "b", text: "2" }, { id: "c", text: "3" }],
      reasoning: "1 is the smallest positive integer, so a is uniquely right.",
      correctChoiceId: "a",
    });
    expect(withReasoning.success).toBe(true);
  });
});

describe("next-action planner", () => {
  const pc = (id: string, o: Partial<PlannerConcept> = {}): PlannerConcept => ({
    id,
    title: id,
    position: Number(id.replace(/\D/g, "")) || 0,
    prerequisiteIds: [],
    status: "not_assessed",
    inPlan: true,
    history: { explained: false, predicted: false, assessments: 0, lastAssessKind: null, reviewActivities: 0 },
    ...o,
  });
  const base = { sessionKind: "lesson" as const, intent: "goal" as const, sessionSteps: [], dueReviews: [] };

  it("predicts before teaching, then teaches", () => {
    expect(chooseNext({ ...base, concepts: [pc("c1")] })).toMatchObject({ kind: "multiple_choice", purpose: "prediction" });
    const h = { explained: false, predicted: true, assessments: 0, lastAssessKind: null, reviewActivities: 0 };
    expect(chooseNext({ ...base, concepts: [pc("c1", { history: h })] })).toMatchObject({ kind: "explanation", purpose: "teach" });
  });
  it("respects prerequisites", () => {
    const d = chooseNext({ ...base, concepts: [pc("c2", { prerequisiteIds: ["c1"], position: 0 }), pc("c1", { position: 1 })] });
    expect(d).toMatchObject({ conceptId: "c1" });
  });
  it("probes after a first miss, explains after a second, then re-tests", () => {
    const miss = { conceptId: "c1", kind: "multiple_choice" as const, purpose: "check" as const, result: "incorrect" as const };
    expect(chooseNext({ ...base, concepts: [pc("c1")], sessionSteps: [miss] })).toMatchObject({ kind: "multiple_choice", purpose: "probe", difficulty: 1 });
    const probeMiss = { conceptId: "c1", kind: "multiple_choice" as const, purpose: "probe" as const, result: "incorrect" as const };
    expect(chooseNext({ ...base, concepts: [pc("c1")], sessionSteps: [miss, probeMiss] })).toMatchObject({ kind: "explanation", purpose: "remediate" });
    const steps2 = [miss, probeMiss, { conceptId: "c1", kind: "explanation" as const, purpose: "remediate" as const, result: null }];
    expect(chooseNext({ ...base, concepts: [pc("c1")], sessionSteps: steps2 })).toMatchObject({ kind: "multiple_choice", purpose: "check", difficulty: 2 });
    const probeHit = { conceptId: "c1", kind: "multiple_choice" as const, purpose: "probe" as const, result: "correct" as const };
    expect(chooseNext({ ...base, concepts: [pc("c1")], sessionSteps: [miss, probeHit] })).toMatchObject({ kind: "free_response", purpose: "check", difficulty: 2 });
  });
  it("review sessions use due items with alternating fresh variants and stop when done", () => {
    const concepts = [pc("c1", { status: "demonstrated", history: { explained: true, predicted: true, assessments: 3, lastAssessKind: "free_response", reviewActivities: 1 } })];
    const d = chooseNext({ ...base, sessionKind: "review", concepts, dueReviews: [{ reviewItemId: "r1", conceptId: "c1" }] });
    expect(d).toMatchObject({ purpose: "review", kind: "free_response", reviewItemId: "r1" });
    const done = chooseNext({ ...base, sessionKind: "review", concepts, dueReviews: [{ reviewItemId: "r1", conceptId: "c1" }], sessionSteps: [{ conceptId: "c1", kind: "free_response", purpose: "review", result: "correct" }] });
    expect(done.action).toBe("complete");
  });
  it("lessons are bounded and curiosity sessions end with a reflection", () => {
    const steps = Array.from({ length: 7 }, () => ({ conceptId: "c1", kind: "multiple_choice" as const, purpose: "check" as const, result: "correct" as const }));
    expect(chooseNext({ ...base, intent: "curiosity", concepts: [pc("c1"), pc("c2")], sessionSteps: steps })).toMatchObject({ kind: "reflection" });
    expect(chooseNext({ ...base, concepts: [pc("c1")], sessionSteps: [...steps, steps[0]] }).action).toBe("complete");
  });
  it("uses learner-selected focus", () => {
    expect(chooseNext({ ...base, concepts: [pc("c1"), pc("c9")], focusConceptId: "c9" })).toMatchObject({ conceptId: "c9" });
  });

  it("computes honest session target steps across lesson, review, placement, and assessment", () => {
    // Quick lesson caps at 5 steps
    expect(computeTargetSteps({ kind: "lesson", position: 2, currentUnanswered: true, stepCount: 2, planCount: 6, dueCount: 0, timeBudgetMinutesWeekly: 20, depth: "quick" })).toBe(5);
    // Review session keeps total invariant before and after answering step 1 of 2
    expect(computeTargetSteps({ kind: "review", position: 1, currentUnanswered: true, stepCount: 1, planCount: 6, dueCount: 2, timeBudgetMinutesWeekly: null, depth: "standard" })).toBe(2);
    expect(computeTargetSteps({ kind: "review", position: 1, currentUnanswered: false, stepCount: 1, planCount: 6, dueCount: 1, timeBudgetMinutesWeekly: null, depth: "standard" })).toBe(2);
    // Placement caps at PLACEMENT_MAX (5), assessment is planCount + 1 integrative
    expect(computeTargetSteps({ kind: "placement", position: 1, currentUnanswered: true, stepCount: 1, planCount: 4, dueCount: 0, timeBudgetMinutesWeekly: null, depth: "standard" })).toBe(4);
    expect(computeTargetSteps({ kind: "assessment", position: 1, currentUnanswered: true, stepCount: 1, planCount: 4, dueCount: 0, timeBudgetMinutesWeekly: null, depth: "standard" })).toBe(5);
  });
});

describe("course draft view & conversion schema", () => {
  it("populates clarifying question step counts and rich concept previews from proposal_json", () => {
    const collecting = draftView({
      id: "d1",
      owner_id: "u1",
      topic: "SQL window functions",
      status: "collecting",
      version: 2,
      converted_course_id: null,
      last_error: null,
      proposal_json: null,
      state_json: {
        answers: [{ field: "desired_outcome", question: "What for?", options: ["Interviews"], answer: "Interviews", reasonCode: "goal" }],
        pending: { question: "Current SQL comfort?", options: ["Basic joins", "Subqueries"], field: "baseline", reasonCode: "level" },
        startNow: false,
        interpretation: null,
        adjustment: null,
        processedKeys: [],
      },
    });
    expect(collecting.nextQuestion).toMatchObject({
      text: "Current SQL comfort?",
      step: 2,
      maxSteps: MAX_QUESTIONS,
    });

    const ready = draftView({
      id: "d1",
      owner_id: "u1",
      topic: "SQL window functions",
      status: "ready",
      version: 4,
      converted_course_id: null,
      last_error: null,
      state_json: {
        answers: [],
        pending: null,
        startNow: true,
        interpretation: null,
        adjustment: null,
        processedKeys: [],
      },
      proposal_json: {
        curriculum: {
          title: "Practical Window Functions",
          direction: "Move from partitions to frames.",
          first_concept_slug: "partitions",
          suggested_minutes_weekly: 45,
          cadence_note: "Two short sessions a week.",
          success_criteria: ["Write ranking and rolling-sum queries"],
          concepts: [
            {
              slug: "partitions",
              title: "OVER and PARTITION BY",
              description: "Compute aggregates per group without collapsing rows.",
              assessment_criteria: ["Explain difference from GROUP BY"],
              importance: 3,
              prerequisites: [],
              needs_fact_check: false,
            },
            {
              slug: "frames",
              title: "Sliding Window Frames",
              description: "Control ROWS vs RANGE bounds for moving averages.",
              assessment_criteria: ["Write a 7-day rolling sum"],
              importance: 2,
              prerequisites: ["partitions"],
              needs_fact_check: false,
            },
          ],
        },
        interpretation: {
          intent: "goal",
          goal_text: "Pass SQL analytics interviews",
          depth: "standard",
          baseline: "Comfortable with GROUP BY",
          time_budget_minutes_weekly: 45,
          success_criteria: [],
          assumptions: ["PostgreSQL syntax"],
          link_context: null,
        },
        modelInfo: { provider: "mock", model: "mock", operation: "compile", latencyMs: 10 },
      },
    });

    expect(ready.proposal?.initialConceptTitles).toEqual(["OVER and PARTITION BY", "Sliding Window Frames"]);
    expect(ready.proposal?.initialConcepts).toEqual([
      {
        slug: "partitions",
        title: "OVER and PARTITION BY",
        description: "Compute aggregates per group without collapsing rows.",
        prerequisiteTitles: [],
        isFirst: true,
      },
      {
        slug: "frames",
        title: "Sliding Window Frames",
        description: "Control ROWS vs RANGE bounds for moving averages.",
        prerequisiteTitles: ["OVER and PARTITION BY"],
        isFirst: false,
      },
    ]);
  });

  it("validates optional trimmed custom title in ConvertDraftBody", () => {
    expect(ConvertDraftBody.parse({})).toEqual({});
    expect(ConvertDraftBody.parse({ title: "  My Custom SQL Course  " })).toEqual({ title: "My Custom SQL Course" });
    expect(ConvertDraftBody.safeParse({ title: "   " }).success).toBe(false);
    expect(ConvertDraftBody.safeParse({ title: "x".repeat(121) }).success).toBe(false);
  });
});

describe("focused outline study & review age formatting", () => {
  it("prioritizes focusConceptId in review sessions, step 1 of focused lessons, and demonstrated concept revisits", () => {
    const mk = (id: string, status: PlannerConcept["status"] = "not_assessed", needsRecall = false): PlannerConcept => ({
      id,
      title: id,
      position: Number(id.replace(/\D/g, "")) || 0,
      prerequisiteIds: [],
      status,
      inPlan: true,
      needsRecall,
      history: { explained: false, predicted: false, assessments: 0, lastAssessKind: null, reviewActivities: 0 },
    });

    // Review session prioritizes the focused due concept first
    const reviewPick = chooseNext({
      sessionKind: "review",
      intent: "goal",
      concepts: [mk("c1", "review_due"), mk("c2", "review_due")],
      sessionSteps: [],
      dueReviews: [
        { reviewItemId: "r1", conceptId: "c1" },
        { reviewItemId: "r2", conceptId: "c2" },
      ],
      focusConceptId: "c2",
    });
    expect(reviewPick).toMatchObject({ action: "activity", conceptId: "c2", purpose: "review", reviewItemId: "r2" });

    // Focused lesson step 1 is not hijacked by another concept's pending recall
    const focusedStep1 = chooseNext({
      sessionKind: "lesson",
      intent: "goal",
      concepts: [mk("c1", "developing", true), mk("c2", "not_assessed", false)],
      sessionSteps: [],
      dueReviews: [],
      focusConceptId: "c2",
    });
    expect(focusedStep1).toMatchObject({ action: "activity", conceptId: "c2" });

    // Explicitly focusing an already-demonstrated concept gives a transfer challenge on that concept
    const demonstratedRevisit = chooseNext({
      sessionKind: "lesson",
      intent: "goal",
      concepts: [mk("c1", "demonstrated"), mk("c2", "not_assessed")],
      sessionSteps: [],
      dueReviews: [],
      focusConceptId: "c1",
    });
    expect(demonstratedRevisit).toMatchObject({ action: "activity", conceptId: "c1", purpose: "transfer", difficulty: 3 });
  });

  it("distinguishes reviews due today from multi-day overdue items", () => {
    const now = new Date("2026-03-10T18:00:00Z");
    expect(describeDueReview(new Date("2026-03-10T10:00:00Z"), now, "UTC")).toEqual({ dueLabel: "Due today", overdue: false });
    expect(describeDueReview(new Date("2026-03-07T12:00:00Z"), now, "UTC")).toEqual({ dueLabel: "Overdue · 3d", overdue: true });
    const future = describeDueReview(new Date("2026-03-12T15:00:00Z"), now, "UTC");
    expect(future.overdue).toBe(false);
    expect(future.dueLabel).not.toContain("Overdue");
  });
});


