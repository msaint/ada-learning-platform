"use client";

import Link from "next/link";
import { GitBranch } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, newKey } from "@/lib/client/api";
import type { NextAction, SessionView, InlineError as InlineErrorT } from "@/lib/schemas/dto";
import { Button, InlineError, Spinner } from "@/components/ui/primitives";
import { ExploreBranchButton } from "@/components/course/explore-branch-button";
import { ActivityView } from "./activity-renderer";
import { FeedbackPanel } from "./feedback";

type View = SessionView & { error?: InlineErrorT | null };
type Busy = null | "start" | "submit" | "next" | "hint" | "explain" | "pause" | "skip" | "reveal" | "difficulty" | "flag" | "breakdown" | "branch";
const KIND_LABEL: Record<SessionView["kind"], string> = { lesson: "Lesson", review: "Review", placement: "Placement", assessment: "Final check" };

export function LessonPlayer({
  courseId,
  initialSession,
  nextAction,
  intent,
  autoStart,
  clearStartParam = false,
}: {
  courseId: string;
  initialSession: View | null;
  nextAction: NextAction;
  intent: "curiosity" | "goal";
  autoStart: { kind?: SessionView["kind"]; focusConceptId?: string } | null;
  clearStartParam?: boolean;
}) {
  const router = useRouter();
  const [session, setSession] = useState<View | null>(initialSession);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<{ message: string; retry?: () => void } | null>(initialSession?.error ? { message: initialSession.error.message } : null);
  const [choice, setChoice] = useState<string | undefined>(initialSession?.draft?.value.choiceId);
  const [text, setText] = useState<string>(initialSession?.draft?.value.text ?? "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "conflict">("idle");
  const [streak, setStreak] = useState(0);
  const [detourOpen, setDetourOpen] = useState(false);
  const [detourText, setDetourText] = useState("");
  const lastGradedActivityIdRef = useRef<string | null>(null);

  const draftVersion = useRef(initialSession?.draft?.version ?? 0);
  const attemptKey = useRef(newKey());
  const assistKey = useRef(newKey());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusRef = useRef<HTMLDivElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const activityId = session?.activity?.id ?? null;
  const sessionPhase = session?.phase ?? null;
  const sessionStatus = session?.status ?? null;
  const started = useRef(false);
  const cleared = useRef(false);

  const adopt = useCallback((s: View, opts: { resetInput?: boolean } = {}) => {
    setSession(s);
    if (opts.resetInput) {
      setChoice(s.draft?.value.choiceId);
      setText(s.draft?.value.text ?? "");
      draftVersion.current = s.draft?.version ?? 0;
      attemptKey.current = newKey();
      assistKey.current = newKey();
      setSaveState("idle");
      setDetourOpen(false);
      setDetourText("");
    }
    if (s.phase === "feedback" && s.feedback?.status === "graded" && s.activity?.id && lastGradedActivityIdRef.current !== s.activity.id) {
      lastGradedActivityIdRef.current = s.activity.id;
      if (s.feedback.result === "correct" && !s.feedback.skipped) setStreak((prev) => prev + 1);
      else if (s.feedback.result === "incorrect" || s.feedback.result === "partial" || s.feedback.skipped) setStreak(0);
    }
    if (s.error) setError({ message: s.error.message, retry: s.error.retryable ? undefined : undefined });
  }, []);

  // Move focus to the new activity/feedback so keyboard and screen-reader users follow transitions.
  // After feedback, focus goes to Continue (the feedback region itself is announced via aria-live).
  useEffect(() => {
    if (sessionPhase === "feedback" && continueRef.current) continueRef.current.focus();
    else focusRef.current?.focus();
  }, [activityId, sessionPhase]);

  const call = useCallback(
    async (kind: Busy, fn: () => Promise<View>, opts: { resetInput?: boolean; retry?: () => void } = {}) => {
      setBusy(kind);
      setError(null);
      try {
        const s = await fn();
        adopt(s, opts);
        if (s.error) setError({ message: s.error.message, retry: opts.retry });
        return s;
      } catch (e) {
        const err = e instanceof ApiError ? e : null;
        setError({ message: err?.message ?? "Something went wrong.", retry: err?.retryable ? opts.retry : undefined });
        if (err?.code === "conflict" && session) {
          const fresh = await api<{ session: View }>(`/sessions/${session.id}`).catch(() => null);
          if (fresh) adopt(fresh.session, { resetInput: true });
        }
      } finally {
        setBusy(null);
      }
    },
    [adopt, session],
  );

  const start = useCallback(
    (body: { kind?: SessionView["kind"]; focusConceptId?: string } = {}) => {
      setStreak(0);
      lastGradedActivityIdRef.current = null;
      return call("start", async () => (await api<{ session: View }>(`/courses/${courseId}/sessions`, { body })).session, { resetInput: true, retry: () => start(body) }).then(() => router.refresh());
    },
    [call, courseId, router],
  );

  const autoStartKind = autoStart?.kind ?? "";
  const autoStartFocus = autoStart?.focusConceptId ?? "";

  useEffect(() => {
    if ((autoStartKind || autoStartFocus) && !started.current) {
      started.current = true;
      start({
        ...(autoStartKind ? { kind: autoStartKind as SessionView["kind"] } : {}),
        ...(autoStartFocus ? { focusConceptId: autoStartFocus } : {}),
      });
    }
    // Drop one-shot query params (?start=1, ?focus=..., ?kind=...) so reloading later doesn't restart the session.
    if (clearStartParam && !cleared.current) {
      cleared.current = true;
      window.history.replaceState(null, "", `/app/courses/${courseId}`);
    }
  }, [autoStartKind, autoStartFocus, start, clearStartParam, courseId]);

  const saveDraft = useCallback(
    (value: { choiceId?: string; text?: string }) => {
      if (!activityId) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setSaveState("saving");
      saveTimer.current = setTimeout(async () => {
        try {
          const r = await api<{ version: number }>(`/activities/${activityId}/draft`, { method: "PUT", body: { draft: value, baseVersion: draftVersion.current } });
          draftVersion.current = r.version;
          setSaveState("saved");
        } catch (e) {
          if (e instanceof ApiError && e.code === "conflict") {
            const d = (e.details as { draft?: { version: number } })?.draft;
            if (d) draftVersion.current = d.version;
            setSaveState("conflict");
          } else setSaveState("idle");
        }
      }, 600);
    },
    [activityId],
  );

  const submitRef = useRef<() => void>(() => {});
  const nextRef = useRef<() => void>(() => {});
  const pickChoiceRef = useRef<(idx: number) => void>(() => {});
  submitRef.current = () => {
    void submit();
  };
  nextRef.current = () => {
    void next();
  };
  pickChoiceRef.current = (idx: number) => {
    const act = session?.activity;
    if (!act || act.kind !== "multiple_choice") return;
    const picked = act.choices[idx];
    if (!picked) return;
    setChoice(picked.id);
    saveDraft({ choiceId: picked.id });
  };

  const activityKind = session?.activity?.kind ?? null;
  const isBusy = busy !== null;
  const hasChoice = Boolean(choice);

  // Keyboard flow when not typing in an input or focusing an interactive button/link:
  // - Multiple choice: 1–5 selects an option; Enter submits once an option is selected.
  // - Explanation: Enter advances to the next activity.
  useEffect(() => {
    if (sessionStatus !== "active" || sessionPhase !== "awaiting_response" || isBusy || !activityKind) return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (activityKind === "multiple_choice") {
        const idx = Number(e.key) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < 5) {
          pickChoiceRef.current(idx);
          return;
        }
        if (e.key === "Enter" && hasChoice && tag !== "BUTTON" && tag !== "A" && tag !== "SUMMARY") {
          e.preventDefault();
          submitRef.current();
        }
      } else if (activityKind === "explanation" && e.key === "Enter" && tag !== "BUTTON" && tag !== "A" && tag !== "SUMMARY") {
        e.preventDefault();
        nextRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessionStatus, sessionPhase, isBusy, activityKind, hasChoice]);

  async function submit(skipped = false) {
    if (!session?.activity) return;
    const a = session.activity;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (a.kind === "explanation") return next();
    const response = skipped ? { skipped: true } : a.kind === "multiple_choice" ? { choiceId: choice } : { text: text.trim() };
    if (!skipped && a.kind === "multiple_choice" && !choice) return;
    if (!skipped && a.kind !== "multiple_choice" && !text.trim()) return;
    const key = attemptKey.current;
    await call(skipped ? "skip" : "submit", async () => (await api<{ session: View }>(`/activities/${a.id}/attempts`, { body: { idempotencyKey: key, response } })).session, {
      retry: () => submit(skipped),
    });
  }

  async function next() {
    if (!session) return;
    const from = session.activity?.id ?? null;
    await call("next", async () => (await api<{ session: View }>(`/sessions/${session.id}/next`, { body: { fromActivityId: from } })).session, { resetInput: true, retry: next });
    router.refresh();
  }

  async function assist(kind: "hint" | "explain") {
    if (!session?.activity) return;
    const key = assistKey.current;
    setBusy(kind);
    setError(null);
    try {
      const r = await api<{ hints?: string[]; altExplanations?: string[] }>(`/activities/${session.activity.id}/${kind}`, { body: { idempotencyKey: key } });
      assistKey.current = newKey();
      setSession((s) => (s ? { ...s, hints: r.hints ?? s.hints, altExplanations: r.altExplanations ?? s.altExplanations } : s));
    } catch (e) {
      setError({ message: e instanceof ApiError ? e.message : "Couldn't get that.", retry: e instanceof ApiError && e.retryable ? () => assist(kind) : undefined });
    } finally {
      setBusy(null);
    }
  }

  /** "Show me the answer" on a withheld (Socratic) miss. */
  async function reveal() {
    if (!session?.activity) return;
    const id = session.activity.id;
    await call("reveal", async () => (await api<{ session: View }>(`/activities/${id}/reveal`, { body: {} })).session);
  }

  async function changeDifficulty(offset: -1 | 0 | 1) {
    if (!session) return;
    const id = session.id;
    await call("difficulty", async () => (await api<{ session: View }>(`/sessions/${id}/difficulty`, { body: { offset } })).session);
  }

  async function flag() {
    if (!session?.activity) return;
    const id = session.activity.id;
    await call("flag", async () => (await api<{ session: View }>(`/activities/${id}/flag`, { body: {} })).session);
  }

  async function breakdown(conceptId: string) {
    setBusy("breakdown");
    setError(null);
    try {
      const r = await api<{ firstConceptId: string }>(`/courses/${courseId}/concepts/${conceptId}/breakdown`, { body: {} });
      const nextView = (await api<{ session: View }>(`/courses/${courseId}/sessions`, { body: { kind: "lesson", focusConceptId: r.firstConceptId } })).session;
      adopt(nextView, { resetInput: true });
      router.refresh();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      setError({ message: err?.message ?? "Couldn't break this concept into simpler steps.", retry: err?.retryable ? () => breakdown(conceptId) : undefined });
    } finally {
      setBusy(null);
    }
  }

  async function startDetour() {
    const q = detourText.trim().slice(0, 300);
    if (q.length < 2) return;
    setBusy("branch");
    setError(null);
    try {
      const r = await api<{ firstConceptId: string }>(`/courses/${courseId}/branches`, { body: { question: q } });
      const nextView = (await api<{ session: View }>(`/courses/${courseId}/sessions`, { body: { kind: "lesson", focusConceptId: r.firstConceptId } })).session;
      setStreak(0);
      lastGradedActivityIdRef.current = null;
      adopt(nextView, { resetInput: true });
      router.refresh();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      setError({ message: err?.message ?? "Couldn't open that side branch.", retry: err?.retryable ? () => startDetour() : undefined });
    } finally {
      setBusy(null);
    }
  }

  async function pause() {
    if (!session) return;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      if (activityId && session.phase === "awaiting_response") {
        await api(`/activities/${activityId}/draft`, { method: "PUT", body: { draft: { choiceId: choice, text }, baseVersion: draftVersion.current } }).catch(() => {});
      }
    }
    await call("pause", async () => (await api<{ session: View }>(`/sessions/${session.id}/pause`, { body: {} })).session);
    router.refresh();
  }

  // ---------------------------------------------------------------- render

  if (!session || session.status === "completed") {
    const s = session?.summary;
    const linkClass = "inline-flex min-h-11 items-center rounded-xl px-4 text-[0.95rem] whitespace-nowrap text-muted hover:bg-surface hover:text-ink";
    const RESULT_MARK: Record<string, string> = { correct: "✓", partial: "~", incorrect: "✗", unknown: "–" };
    const RESULT_SR: Record<string, string> = { correct: "knew it", partial: "partly", incorrect: "not yet", unknown: "skipped" };

    return (
      <section aria-labelledby="learn-start" className="py-6">
        <div ref={focusRef} tabIndex={-1} className="focus:outline-none">
          {s?.placement ? (
            <>
              <h2 id="learn-start" className="mb-2 text-xl font-semibold text-ink">Here&apos;s where you stand</h2>
              <p className="mb-4 text-ink-soft">Placement is done. Ada uses this to skip what you already know.</p>
              <ul className="mb-6 divide-y divide-line rounded-2xl border border-line bg-surface text-sm">
                {s.placement.map((p) => (
                  <li key={p.conceptId} className="flex items-center gap-3 px-4 py-2.5">
                    <span aria-hidden className="w-4 text-center font-semibold text-spark">{RESULT_MARK[p.result]}</span>
                    <span className="sr-only">{RESULT_SR[p.result]}: </span>
                    <span className="min-w-0 flex-1 break-words text-ink">{p.title}</span>
                    {p.conceptId !== s.suggestedConceptId && (
                      <Button size="sm" variant="quiet" onClick={() => start({ kind: "lesson", focusConceptId: p.conceptId })}>
                        Start here
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : s?.assessment ? (
            <>
              <h2 id="learn-start" className="mb-2 text-xl font-semibold text-ink">{s.assessment.passed ? "You passed the final check" : "Not yet — almost there"}</h2>
              <p className="mb-6 text-ink-soft">
                {s.assessment.passed
                  ? "You answered across the whole course, including a problem that combines it. Your readiness estimate now reflects that."
                  : `Practise these, then try again: ${s.assessment.missed.join(", ")}.`}
              </p>
            </>
          ) : s ? (
            <>
              <h2 id="learn-start" className="mb-2 text-xl font-semibold text-ink">Session complete</h2>
              <p className="mb-6 text-ink-soft tabular-nums">
                {s.assessed > 0 ? `You answered ${s.assessed} question${s.assessed === 1 ? "" : "s"}, ${s.correct} correct.` : "Nice work."}{" "}
                {s.conceptsTouched.length > 0 && <>Covered: {s.conceptsTouched.join(", ")}.</>}
              </p>
              {s.reflections && s.reflections.length > 0 && (
                <div className="mb-6 rounded-2xl border border-line bg-surface px-4 py-3 text-sm">
                  <p className="mb-2 font-medium text-ink">Questions you noted</p>
                  <ul className="space-y-2 text-ink-soft">
                    {s.reflections.map((q, i) => (
                      <li key={i} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 flex-1 break-words">{q}</span>
                        <ExploreBranchButton courseId={courseId} question={q} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : nextAction.kind === "placement" ? (
            <>
              <h2 id="learn-start" className="mb-2 text-xl font-semibold text-ink">{busy === "start" ? "Preparing your first question…" : "Find your starting point"}</h2>
              <p className="mb-6 max-w-prose text-ink-soft">
                Ada will ask a few questions, one at a time and from easy to hard, to see what you already know. Nothing is taught until it&apos;s done, and
                answers aren&apos;t revealed, so you can skip anything you don&apos;t know.
              </p>
            </>
          ) : nextAction.kind === "assessment" ? (
            <>
              <h2 id="learn-start" className="mb-2 text-xl font-semibold text-ink">{busy === "start" ? "Preparing the final check…" : "Ready for the final check"}</h2>
              <p className="mb-6 max-w-prose text-ink-soft">
                You&apos;ve shown every concept in this course. The final check mixes them: one question per concept and one problem that combines them. No hints.
              </p>
            </>
          ) : (
            <h2 id="learn-start" className="mb-6 text-xl font-semibold text-ink">{busy === "start" ? "Preparing your next activity…" : nextAction.label}</h2>
          )}
        </div>
        {busy === "start" || busy === "branch" ? (
          <ActivitySkeleton label={busy === "branch" ? "Adding that branch to your course…" : "Ada is preparing an activity for you…"} />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2.5">
              {s?.placement ? (
                <>
                  <Button variant="primary" onClick={() => start(s.suggestedConceptId ? { kind: "lesson", focusConceptId: s.suggestedConceptId } : { kind: "lesson" })}>
                    {s.suggestedConceptId ? `Start with ${s.placement.find((p) => p.conceptId === s.suggestedConceptId)?.title ?? "the suggested concept"}` : "Start learning"}
                  </Button>
                  <Link href={`/app/courses/${courseId}/outline`} className={linkClass}>
                    Choose another concept
                  </Link>
                </>
              ) : nextAction.kind === "placement" ? (
                <>
                  <Button variant="primary" onClick={() => start({ kind: "placement" })}>Start placement</Button>
                  <Button onClick={() => start({ kind: "lesson" })}>Skip — start from the beginning</Button>
                </>
              ) : nextAction.kind === "assessment" ? (
                <>
                  <Button variant="primary" onClick={() => start({ kind: "assessment" })}>Start final check</Button>
                  <Button onClick={() => start({ kind: "lesson" })}>Keep practising first</Button>
                </>
              ) : (
                <>
                  <Button variant="primary" onClick={() => start(nextAction.kind === "review" ? { kind: "review" } : { kind: "lesson" })}>
                    {s ? (nextAction.kind === "review" ? "Start review" : "Keep going") : nextAction.kind === "review" ? "Start review" : "Start"}
                  </Button>
                  {nextAction.kind === "review" && <Button onClick={() => start({ kind: "lesson" })}>Learn something new instead</Button>}
                </>
              )}
              {s && !s.placement && (
                <Link href={`/app/courses/${courseId}/progress`} className={linkClass}>
                  See progress
                </Link>
              )}
              {s && !s.placement && !s.assessment && !detourOpen && (
                <Button variant="quiet" onClick={() => setDetourOpen(true)}>
                  <GitBranch className="size-4" aria-hidden />
                  <span>Ask a side question</span>
                </Button>
              )}
              {intent === "curiosity" && s && (
                <Link href={`/app/courses/${courseId}/outline`} className={linkClass}>
                  Course outline
                </Link>
              )}
            </div>

            {detourOpen && (
              <DetourForm
                value={detourText}
                onChange={setDetourText}
                onSubmit={startDetour}
                onCancel={() => {
                  setDetourOpen(false);
                  setDetourText("");
                }}
                busy={false}
              />
            )}
          </div>
        )}
        {error && <div className="mt-6"><InlineError message={error.message} onRetry={error.retry} retrying={!!busy} /></div>}
      </section>
    );
  }

  if (session.status === "paused") {
    return (
      <section className="py-6">
        <div ref={focusRef} tabIndex={-1} className="focus:outline-none">
          <h2 className="mb-2 text-xl font-semibold text-ink">Paused</h2>
          <p className="mb-6 text-ink-soft">Your place and any unsent answer are saved.</p>
        </div>
        <Button variant="primary" busy={busy === "start"} onClick={() => start({})}>
          Resume
        </Button>
        {error && <div className="mt-6"><InlineError message={error.message} onRetry={error.retry} /></div>}
      </section>
    );
  }

  const a = session.activity;
  const phase = session.phase;
  const answered = phase === "feedback" || phase === "evaluating";
  const assessable = a && (a.kind === "multiple_choice" || a.kind === "free_response");
  const measuring = session.kind === "placement" || session.kind === "assessment";

  const stepNum = Math.max(1, session.position || 1);
  const targetSteps = Math.max(stepNum, session.targetSteps ?? 8);
  const fixedLength = session.kind !== "lesson";
  const completedRatio = answered && fixedLength && stepNum >= targetSteps ? 1 : answered ? stepNum / targetSteps : (stepNum - 0.35) / targetSteps;
  const progressPct = Math.max(8, Math.min(fixedLength && answered && stepNum >= targetSteps ? 100 : 96, Math.round(completedRatio * 100)));
  const stepLabel = session.targetSteps
    ? fixedLength
      ? `${stepNum} of ${targetSteps}`
      : `step ${stepNum} of ~${targetSteps}`
    : `step ${stepNum}`;

  return (
    <section aria-label={KIND_LABEL[session.kind]} className="py-2">
      {/* Session Momentum Header */}
      <div className="mb-6">
        <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted">
          <span className="min-w-0 truncate tabular-nums">
            {KIND_LABEL[session.kind]} · {stepLabel}
            {a ? ` · ${a.conceptTitle}` : ""}
          </span>
          <div className="flex shrink-0 items-center gap-3">
            {streak >= 2 && (
              <span className="font-mono text-xs font-medium text-prism tabular-nums">
                {streak} streak
              </span>
            )}
            <Button variant="quiet" size="sm" onClick={pause} busy={busy === "pause"}>
              Pause
            </Button>
          </div>
        </div>
        <svg viewBox="0 0 100 2" preserveAspectRatio="none" className="block h-2 w-full overflow-hidden rounded-full bg-surface" aria-hidden="true">
          <defs>
            <linearGradient id="ada-progress-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="var(--color-spark)" />
              <stop offset="50%" stopColor="var(--color-accent)" />
              <stop offset="100%" stopColor="var(--color-prism)" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width={progressPct} height="2" rx="1" fill="url(#ada-progress-grad)" className="transition-all duration-300 ease-out" />
        </svg>
      </div>

      {!a || phase === "choosing_next" ? (
        <div ref={focusRef} tabIndex={-1} className="space-y-4 py-4 focus:outline-none">
          {busy === "next" || busy === "branch" ? (
            <ActivitySkeleton label={busy === "branch" ? "Adding that branch to your course…" : "Preparing the next activity…"} />
          ) : (
            !error && <Button variant="primary" onClick={next}>Continue</Button>
          )}
        </div>
      ) : (
        <>
          <div ref={phase === "awaiting_response" ? focusRef : undefined} tabIndex={-1} className="focus:outline-none">
            <ActivityView
              activity={a}
              choice={answered ? session.feedback?.chosenChoiceId ?? choice : choice}
              onChoice={(id) => {
                setChoice(id);
                saveDraft({ choiceId: id });
              }}
              text={answered ? session.feedback?.submittedText ?? text : text}
              onText={(v) => {
                setText(v);
                saveDraft({ text: v });
              }}
              onSubmitShortcut={() => submit()}
              disabled={answered || !!busy}
              feedback={session.feedback}
              altExplanations={session.altExplanations}
              hints={session.hints}
            />
          </div>

          {phase === "awaiting_response" && (
            <div className="mt-6">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  onClick={() => submit()}
                  busy={busy === "submit" || (a.kind === "explanation" && busy === "next")}
                  disabled={!!busy || (a.kind === "multiple_choice" && !choice) || ((a.kind === "free_response" || a.kind === "reflection") && !text.trim())}
                >
                  {a.kind === "explanation" ? a.continueLabel || "Continue" : a.kind === "reflection" ? "Save reflection" : "Check answer"}
                </Button>
                {(a.kind === "free_response" || a.kind === "reflection") && (
                  <span className="text-xs text-muted" aria-live="polite">
                    {busy === "submit" && a.kind === "free_response" ? "Grading your answer…" : saveState === "saving" ? "Saving…" : saveState === "saved" ? "Draft saved" : saveState === "conflict" ? "Edited in another tab — your latest text here will be kept" : "Enter to submit · Shift+Enter for a new line"}
                  </span>
                )}
                {a.kind === "multiple_choice" && (
                  <span className="hidden text-xs text-muted sm:inline">
                    Press 1–{a.choices.length} to pick{choice ? " · Enter to check" : ""}
                  </span>
                )}
                {a.kind === "explanation" && <span className="hidden text-xs text-muted sm:inline">Press Enter to continue</span>}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1" aria-label="Help">
                {measuring ? (
                  assessable && (
                    <Button variant="quiet" size="sm" onClick={() => submit(true)} busy={busy === "skip"} disabled={!!busy}>
                      I don&apos;t know
                    </Button>
                  )
                ) : (
                  <>
                    {assessable && (
                      <Button variant="quiet" size="sm" onClick={() => assist("hint")} busy={busy === "hint"} disabled={!!busy || session.hints.length >= 3}>
                        {session.hints.length > 0 ? `Hint (${session.hints.length}/3)` : "Hint"}
                      </Button>
                    )}
                    <Button variant="quiet" size="sm" onClick={() => assist("explain")} busy={busy === "explain"} disabled={!!busy || session.altExplanations.length >= 3}>
                      {session.altExplanations.length > 0 ? `Explain differently (${session.altExplanations.length}/3)` : "Explain differently"}
                    </Button>
                    {a.kind === "explanation" && session.kind === "lesson" && !detourOpen && (
                      <Button variant="quiet" size="sm" onClick={() => setDetourOpen(true)} disabled={!!busy}>
                        <GitBranch className="size-3.5" aria-hidden />
                        <span>Ask a side question</span>
                      </Button>
                    )}
                    {(assessable || a.kind === "reflection") && (
                      <Button variant="quiet" size="sm" onClick={() => submit(true)} busy={busy === "skip"} disabled={!!busy}>
                        {a.kind === "reflection" ? "Skip" : "Show me the answer"}
                      </Button>
                    )}
                  </>
                )}
                {session.kind === "lesson" && (
                  <span className="ml-auto inline-flex items-center gap-1" role="group" aria-label="Question difficulty">
                    <Button variant="quiet" size="sm" aria-pressed={session.difficultyOffset < 0} disabled={!!busy} onClick={() => changeDifficulty(session.difficultyOffset < 0 ? 0 : -1)} className={session.difficultyOffset < 0 ? "text-ink underline underline-offset-4" : ""}>
                      Easier
                    </Button>
                    <Button variant="quiet" size="sm" aria-pressed={session.difficultyOffset > 0} disabled={!!busy} onClick={() => changeDifficulty(session.difficultyOffset > 0 ? 0 : 1)} className={session.difficultyOffset > 0 ? "text-ink underline underline-offset-4" : ""}>
                      Harder
                    </Button>
                  </span>
                )}
              </div>
              {detourOpen && a.kind === "explanation" && session.kind === "lesson" && (
                <div className="mt-3">
                  <DetourForm
                    value={detourText}
                    onChange={setDetourText}
                    onSubmit={startDetour}
                    onCancel={() => {
                      setDetourOpen(false);
                      setDetourText("");
                    }}
                    busy={busy === "branch"}
                  />
                </div>
              )}
              {measuring && <p className="mt-2 text-xs text-muted">{session.kind === "placement" ? "No hints during placement. It's fine not to know — that's what this finds out." : "No hints during the final check."}</p>}
              {session.kind === "lesson" && session.difficultyOffset !== 0 && (
                <p className="mt-2 text-xs text-muted" aria-live="polite">{session.difficultyOffset > 0 ? "Harder questions from the next one." : "Easier questions from the next one."}</p>
              )}
              {assessable && (session.hints.length > 0 || session.altExplanations.length > 0) && (
                <p className="mt-2 text-xs text-muted">Help used — this answer will count as assisted practice.</p>
              )}
            </div>
          )}

          {answered && session.feedback && (
            <div ref={phase === "evaluating" ? focusRef : undefined} tabIndex={-1} className="mt-6 focus:outline-none">
              <FeedbackPanel feedback={session.feedback} activityKind={a.kind} onFlag={flag} flagging={busy === "flag"} />
              <div className="mt-5 flex flex-wrap gap-2.5">
                {phase === "evaluating" ? (
                  <Button variant="primary" onClick={() => submit()} busy={busy === "submit"}>
                    Retry grading
                  </Button>
                ) : (
                  <>
                    <Button ref={continueRef} variant="primary" onClick={next} busy={busy === "next"}>
                      Continue
                    </Button>
                    {session.feedback.withheld && session.kind === "lesson" && (
                      <Button variant="quiet" onClick={reveal} busy={busy === "reveal"} disabled={!!busy}>
                        Show me the answer
                      </Button>
                    )}
                    {session.suggestBreakdown && session.kind === "lesson" && (
                      <Button variant="quiet" onClick={() => breakdown(session.suggestBreakdown!.conceptId)} busy={busy === "breakdown"} disabled={!!busy}>
                        Break this into simpler steps
                      </Button>
                    )}
                    {session.kind === "lesson" && !detourOpen && (
                      <Button variant="quiet" onClick={() => setDetourOpen(true)} disabled={!!busy}>
                        <GitBranch className="size-4" aria-hidden />
                        <span>Ask a side question</span>
                      </Button>
                    )}
                  </>
                )}
              </div>
              {detourOpen && session.kind === "lesson" && phase === "feedback" && (
                <div className="mt-4">
                  <DetourForm
                    value={detourText}
                    onChange={setDetourText}
                    onSubmit={startDetour}
                    onCancel={() => {
                      setDetourOpen(false);
                      setDetourText("");
                    }}
                    busy={busy === "branch"}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {error && (
        <div className="mt-6">
          <InlineError message={error.message} onRetry={error.retry ?? (phase === "choosing_next" ? next : undefined)} retrying={!!busy} />
        </div>
      )}
      <p className="mt-10 text-xs text-muted">{session.devModel ? "Placeholder content from the development model — not real AI." : "AI-generated lesson content. It can contain mistakes; check anything high-stakes."}</p>
    </section>
  );
}

function DetourForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim().length >= 2 && !busy) onSubmit();
      }}
      className="rounded-xl border border-line bg-surface/80 p-3.5"
    >
      <label htmlFor="lesson-detour" className="mb-1.5 block text-xs font-medium text-ink">
        What side question should Ada add as a branch?
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="lesson-detour"
          autoFocus
          value={value}
          maxLength={300}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          placeholder="e.g. Why doesn't wheel conicity cause oscillation at high speed?"
          className="min-h-10 flex-1 rounded-xl border border-line-strong bg-paper px-3.5 text-sm text-ink placeholder:text-muted/75 focus:border-accent/70 focus:outline-none"
        />
        <div className="flex items-center gap-1.5">
          <Button type="submit" size="sm" variant="secondary" busy={busy} disabled={value.trim().length < 2}>
            Branch into this
          </Button>
          <Button type="button" size="sm" variant="quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}

function ActivitySkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-5 rounded-2xl border border-line bg-surface/50 p-5" role="status" aria-live="polite">
      <Spinner label={label} />
      <div className="space-y-3 pt-1" aria-hidden="true">
        <div className="h-3 w-28 animate-pulse rounded bg-elevated" />
        <div className="h-5 w-4/5 animate-pulse rounded bg-elevated" />
        <div className="h-5 w-3/5 animate-pulse rounded bg-elevated" />
        <div className="grid gap-2.5 pt-3">
          <div className="h-12 w-full animate-pulse rounded-xl bg-elevated/70" />
          <div className="h-12 w-full animate-pulse rounded-xl bg-elevated/70" />
          <div className="h-12 w-full animate-pulse rounded-xl bg-elevated/70" />
        </div>
      </div>
    </div>
  );
}
