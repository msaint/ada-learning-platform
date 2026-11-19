import { db, json } from "@/lib/db/client";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { ModelInfo } from "@/lib/ai/model-adapter";
import type { ActivitySpec } from "@/lib/schemas/model";
import type { PlannerDecision } from "@/lib/learning/next-action";
import { buildActivityContext, generateSpec, planNext, signature } from "./activity-generation";
import { loadSession, type ActivityRow } from "./types";

const PREPARED_STALE_MS = 120_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Uses a prepared activity if one matches the real decision. If it's still
 * generating, waits for it (bounded) rather than starting a duplicate call.
 * Called with no transaction open, so no connection is held while waiting.
 */
export async function takePrepared(sessionId: string, afterActivityId: string, sig: string) {
  const started = Date.now();
  const maxWait = Math.min(env().ADA_MODEL_TIMEOUT_MS + 5000, 55_000);
  for (;;) {
    const [r] = await db()<{ status: string; mode: string; spec_json: ActivitySpec | null; model_info_json: ModelInfo | null; created_at: Date }[]>`
      select status, mode, spec_json, model_info_json, created_at from prepared_activities
      where session_id = ${sessionId} and after_activity_id = ${afterActivityId} and signature = ${sig}`;
    if (!r || r.status === "failed") return null;
    if (r.status === "ready" && r.spec_json && r.model_info_json) return { spec: r.spec_json, info: r.model_info_json, mode: r.mode, waitedMs: Date.now() - started };
    if (Date.now() - r.created_at.getTime() > PREPARED_STALE_MS || Date.now() - started > maxWait) return null;
    await sleep(200);
  }
}

/**
 * Prepares the next activity for a session's current activity:
 *  - once it's graded ("graded"): the real next step is known, so it's generated
 *    while the learner reads feedback — fully adaptive, no extra cost;
 *  - while it's being answered ("presented"): only if every possible outcome
 *    leads to the same next step (e.g. after an explanation, in placement).
 * Never throws; a failure just means the next step is generated live.
 */
export async function prepareNext(ownerId: string, sessionId: string) {
  const s = await loadSession(db(), ownerId, sessionId).catch(() => null);
  if (!s || s.status !== "active" || !s.current_activity_id) return;
  const afterId = s.current_activity_id;
  const [a] = await db()<ActivityRow[]>`select * from activities where id = ${afterId}`;
  if (!a) return;
  let decision: PlannerDecision;
  let plan: Awaited<ReturnType<typeof planNext>>;
  let mode: "presented" | "graded";
  if (a.status === "answered") {
    mode = "graded";
    plan = await planNext(db(), ownerId, s);
    decision = plan.decision;
  } else if (a.status === "presented") {
    mode = "presented";
    if (a.kind === "reflection") return;
    const plans =
      a.kind === "explanation"
        ? [await planNext(db(), ownerId, s)]
        : [await planNext(db(), ownerId, s, { activity: a, result: "correct" }), await planNext(db(), ownerId, s, { activity: a, result: "incorrect" })];
    const sigs = new Set(plans.map((p) => (p.decision.action === "activity" ? signature(p.decision) : "complete")));
    if (sigs.size !== 1) return; // the answer decides what's next: wait for grading
    plan = plans[0];
    decision = plan.decision;
  } else return;
  if (decision.action !== "activity") return;
  const sig = signature(decision);
  const [row] = await db()<{ id: string }[]>`
    insert into prepared_activities (session_id, after_activity_id, signature, mode, status)
    values (${s.id}, ${afterId}, ${sig}, ${mode}, 'generating') on conflict do nothing returning id`;
  if (!row) return; // already prepared or being prepared
  try {
    const ctx = await buildActivityContext(db(), ownerId, plan.course, plan.concepts, s, decision, plan.stepsRows.length + 1);
    const { spec, info } = await generateSpec(ownerId, ctx, decision);
    await db()`update prepared_activities set status = 'ready', spec_json = ${json(spec)}, model_info_json = ${json(info)} where id = ${row.id}`;
  } catch (e) {
    await db()`update prepared_activities set status = 'failed', error_code = ${e instanceof AppError ? e.code : "internal"} where id = ${row.id}`;
  }
}
