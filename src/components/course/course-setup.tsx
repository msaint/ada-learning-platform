"use client";

import { ArrowLeft, ArrowUp, Check, Loader2, Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, newKey } from "@/lib/client/api";
import type { CourseDraftView, DraftInterpretationPreview, DraftSetupStage, DraftTurn } from "@/lib/schemas/dto";
import { Button, InlineError, Spinner } from "@/components/ui/primitives";

type Pending = null | "answer" | "back" | "propose" | "convert" | "adjust" | "background";

type TurnExchange = { question?: string; answer: string };

function groupTurnExchanges(turns: DraftTurn[]): TurnExchange[] {
  const out: TurnExchange[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role === "ada") {
      const next = turns[i + 1];
      if (next && next.role === "learner") {
        out.push({ question: t.text, answer: next.text });
        i++;
      } else {
        out.push({ question: t.text, answer: "" });
      }
    } else {
      out.push({ answer: t.text });
    }
  }
  return out;
}

export function CourseSetup({ initial }: { initial: CourseDraftView }) {
  const router = useRouter();
  const [draft, setDraft] = useState(initial);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<{ message: string; retry?: () => void } | null>(
    initial.error ? { message: initial.error.message } : null,
  );
  const [adjusting, setAdjusting] = useState(false);
  const [adjustment, setAdjustment] = useState("");
  const [bgOpen, setBgOpen] = useState(false);
  const [bgText, setBgText] = useState(initial.background ?? "");
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const answerKey = useRef(newKey());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const autoAdvancedVersionRef = useRef<number>(-1);

  useEffect(() => {
    headingRef.current?.focus();
  }, [draft.nextQuestion?.text, draft.state]);

  function retryCurrentStep(d: CourseDraftView) {
    const stepOnly = d.stage === "understanding";
    return run("propose", () =>
      api<{ draft: CourseDraftView }>(`/course-drafts/${d.id}/propose`, {
        body: { expectedVersion: d.version, ...(stepOnly ? { stepOnly: true } : {}) },
      }),
    );
  }

  function apply(d: CourseDraftView) {
    setDraft(d);
    if (d.proposal?.title !== draft.proposal?.title) {
      setTitleOverride(null);
      setEditingTitle(false);
    }
    if (d.error) {
      setError({
        message: d.error.message,
        retry: d.error.retryable ? () => void retryCurrentStep(d) : undefined,
      });
    } else {
      setError(null);
    }
  }

  async function run(kind: Pending, fn: () => Promise<{ draft: CourseDraftView }>) {
    setPending(kind);
    setError(null);
    try {
      const r = await fn();
      apply(r.draft);
      return r.draft;
    } catch (e) {
      if (e instanceof ApiError && e.code === "conflict" && (e.details as { draft?: CourseDraftView })?.draft) {
        apply((e.details as { draft: CourseDraftView }).draft);
        setError({ message: e.message });
      } else {
        setError({ message: e instanceof ApiError ? e.message : "Something went wrong.", retry: e instanceof ApiError && e.retryable ? () => run(kind, fn) : undefined });
      }
    } finally {
      setPending(null);
    }
  }

  async function answer(value: string | null) {
    const key = answerKey.current;
    const body =
      value === null
        ? { startNow: true, stepOnly: true, expectedVersion: draft.version, idempotencyKey: key }
        : { answer: value, stepOnly: true, expectedVersion: draft.version, idempotencyKey: key };
    const d = await run("answer", () => api(`/course-drafts/${draft.id}/answer`, { body }));
    if (d) {
      setText("");
      answerKey.current = newKey();
    }
  }

  const q = draft.nextQuestion;
  const effectiveStage: DraftSetupStage =
    draft.stage ??
    (draft.state === "converted"
      ? "converted"
      : draft.state === "ready"
        ? "ready"
        : q
          ? "questioning"
          : "compiling");

  const thinking = pending === "answer" || pending === "propose" || pending === "adjust" || pending === "back" || pending === "background";
  const isPending = pending !== null;
  const hasError = Boolean(error || draft.error);
  const shouldAutoStep = (draft.stage === "understanding" || draft.stage === "compiling") && !hasError && !isPending;

  const autoStepRef = useRef<() => void>(() => {});
  autoStepRef.current = () => {
    void retryCurrentStep(draft);
  };

  // Drive multi-stage setup automatically:
  // 1) "understanding" runs clarifyCourse (stepOnly: true) -> asks a question OR reveals real interpretation in ~2-3s.
  // 2) "compiling" runs compileCurriculum -> builds the full concept graph while showing the revealed interpretation.
  useEffect(() => {
    if (!shouldAutoStep) return;
    if (autoAdvancedVersionRef.current === draft.version) return;
    autoAdvancedVersionRef.current = draft.version;
    autoStepRef.current();
  }, [shouldAutoStep, draft.id, draft.version]);

  const canQuickPick = draft.state === "collecting" && Boolean(q?.options.length) && !thinking && !pending;

  const quickPickRef = useRef<{ options: string[]; answer: (v: string) => void }>({
    options: [],
    answer: () => {},
  });
  quickPickRef.current = { options: q?.options ?? [], answer: (v: string) => void answer(v) };

  useEffect(() => {
    if (!canQuickPick) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const n = Number.parseInt(e.key, 10);
      if (!Number.isInteger(n) || n < 1) return;
      const opt = quickPickRef.current.options[n - 1];
      if (opt) {
        e.preventDefault();
        quickPickRef.current.answer(opt);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canQuickPick, draft.version]);

  async function startCourse() {
    setPending("convert");
    setError(null);
    const candidate = (editingTitle ? titleInput : titleOverride ?? "").trim();
    const customTitle = candidate && candidate !== draft.proposal?.title ? candidate.slice(0, 120) : undefined;
    try {
      const r = await api<{ courseId: string }>(`/course-drafts/${draft.id}/convert`, {
        body: customTitle ? { title: customTitle } : {},
      });
      // Starting a course is a clear signal: open straight into its first step.
      router.push(`/app/courses/${r.courseId}?start=1`);
      router.refresh();
    } catch (e) {
      setError({ message: e instanceof ApiError ? e.message : "Couldn't create the course.", retry: startCourse });
      setPending(null);
    }
  }

  const safeSources = draft.sourcesRead.filter((s) => /^https?:\/\//i.test(s.url));
  const exchanges = groupTurnExchanges(draft.turns.slice(1));
  const displayedTitle = titleOverride ?? draft.proposal?.title ?? "";
  const hasLink = /https?:\/\//i.test(draft.topic) || safeSources.length > 0;
  const showProgressCard = (thinking && pending !== "back") || (draft.state === "collecting" && !q && !hasError);
  const step1Done =
    pending !== "background" &&
    (Boolean(draft.interpretation) || effectiveStage === "compiling" || pending === "adjust");

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 md:py-16">
      <p className="mb-1 text-sm text-muted">New course</p>
      <p className={`${safeSources.length ? "mb-3" : "mb-8"} text-xl font-semibold break-words text-ink`}>{draft.topic}</p>
      {safeSources.length > 0 && (
        <p className="mb-8 text-sm text-muted">
          Ada read:{" "}
          {safeSources.map((s, i) => (
            <span key={s.url}>
              {i > 0 && " · "}
              <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="text-ink-soft underline underline-offset-2 hover:text-ink">
                {s.title?.trim() || hostOf(s.url)}
              </a>
            </span>
          ))}
        </p>
      )}

      {exchanges.length > 0 && (
        <ol aria-label="Your answers so far" className="mb-8 divide-y divide-line rounded-xl border border-line bg-surface/60 px-4 py-1 text-sm break-words">
          {exchanges.map((ex, i) => (
            <li key={i} className="py-2.5">
              {ex.question && <p className="text-xs text-muted">{ex.question}</p>}
              {ex.answer && <p className={`${ex.question ? "mt-0.5" : ""} font-medium text-ink`}>{ex.answer}</p>}
            </li>
          ))}
        </ol>
      )}

      {thinking && pending === "back" && (
        <div className="mb-6">
          <Spinner label="Going back…" />
        </div>
      )}

      {showProgressCard && (
        <div className="mb-6 space-y-4">
          <SetupProgressCard
            step1Done={step1Done}
            answeringQuestion={Boolean(q && pending === "answer")}
            adjustingPlan={pending === "adjust"}
            hasLink={hasLink}
            interpretation={pending === "background" ? undefined : draft.interpretation}
          />
          {!thinking && draft.state === "collecting" && !q && !hasError && !draft.stage && (
            <Button size="sm" onClick={() => void retryCurrentStep(draft)}>
              Continue
            </Button>
          )}
        </div>
      )}

      {draft.state === "collecting" && q && !thinking && (
        <section aria-labelledby="ada-question">
          {q.step && q.maxSteps && (
            <p className="mb-2 text-xs text-muted tabular-nums">
              Question {q.step} of up to {q.maxSteps}
            </p>
          )}
          <h1 id="ada-question" ref={headingRef} tabIndex={-1} className="mb-5 text-2xl leading-snug font-semibold tracking-tight text-ink focus:outline-none">
            {q.text}
          </h1>
          {q.options.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2.5" role="group" aria-label="Quick answers">
              {q.options.map((o, idx) => (
                <Button key={o} onClick={() => answer(o)} disabled={!!pending}>
                  <span aria-hidden="true" className="font-mono text-xs text-muted tabular-nums">
                    {idx + 1}
                  </span>
                  <span>{o}</span>
                </Button>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) answer(text.trim());
            }}
            className="relative"
          >
            <label htmlFor="custom-answer" className="sr-only">
              Or answer in your own words
            </label>
            <input
              id="custom-answer"
              value={text}
              maxLength={1000}
              onChange={(e) => setText(e.target.value)}
              placeholder="Or answer in your own words"
              className="min-h-12 w-full rounded-xl border border-line-strong bg-surface px-4 pr-14 text-ink placeholder:text-muted/75 focus:border-accent/70 focus:outline-none"
            />
            <button
              type="submit"
              aria-label="Send answer"
              disabled={!text.trim() || !!pending}
              className="btn-tactile-primary absolute top-1/2 right-1.5 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-lg bg-accent text-accent-ink hover:bg-accent-strong disabled:opacity-35"
            >
              <ArrowUp className="size-4 stroke-[2.25]" aria-hidden />
            </button>
          </form>
          <div className="mt-4 flex flex-wrap items-center gap-1">
            {draft.canGoBack && (
              <Button variant="quiet" size="sm" onClick={() => run("back", () => api(`/course-drafts/${draft.id}/back`, { body: { expectedVersion: draft.version } }))} disabled={!!pending}>
                <ArrowLeft className="size-4" aria-hidden /> Back
              </Button>
            )}
            <Button variant="quiet" size="sm" onClick={() => answer(null)} disabled={!!pending} className="ml-auto">
              Start now — let Ada decide
            </Button>
          </div>
        </section>
      )}

      {draft.state === "ready" && draft.proposal && !thinking && (
        <section aria-labelledby="proposal-title" className="rounded-2xl border border-line-strong bg-surface p-6">
          <p className="mb-1.5 text-xs font-medium text-prism tabular-nums">
            {draft.proposal.intent === "goal" ? "Goal course" : "Curiosity course"}
            {draft.proposal.suggestedMinutesWeekly ? ` · About ${draft.proposal.suggestedMinutesWeekly} min/week` : ""}
          </p>

          {editingTitle ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const cleaned = titleInput.trim();
                if (cleaned) setTitleOverride(cleaned.slice(0, 120));
                setEditingTitle(false);
              }}
              className="mb-3 flex flex-wrap items-center gap-2"
            >
              <label htmlFor="proposal-title-input" className="sr-only">
                Course title
              </label>
              <input
                id="proposal-title-input"
                autoFocus
                value={titleInput}
                maxLength={120}
                onChange={(e) => setTitleInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingTitle(false);
                  }
                }}
                className="min-h-11 flex-1 rounded-xl border border-line-strong bg-paper px-3.5 text-lg font-semibold text-ink focus:border-accent/70 focus:outline-none"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={!titleInput.trim()}>
                <Check className="size-4" aria-hidden /> Done
              </Button>
              <Button type="button" size="sm" variant="quiet" onClick={() => setEditingTitle(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="mb-2 flex items-start justify-between gap-3">
              <h1 id="proposal-title" ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight text-ink focus:outline-none">
                {displayedTitle}
              </h1>
              <button
                type="button"
                aria-label="Edit course title"
                onClick={() => {
                  setTitleInput(displayedTitle);
                  setEditingTitle(true);
                }}
                className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap text-muted transition-colors hover:bg-elevated hover:text-ink"
              >
                <Pencil className="size-3.5" aria-hidden />
                <span>Rename</span>
              </button>
            </div>
          )}

          <p className="mb-5 leading-relaxed text-ink-soft">{draft.proposal.direction}</p>
          {draft.proposal.successCriteria.length > 0 && (
            <p className="mb-5 text-sm text-ink-soft">
              <span className="font-medium text-ink">You&apos;ll know it&apos;s working when: </span>
              {draft.proposal.successCriteria.join("; ")}
            </p>
          )}

          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium text-ink">Your starting path</h2>
            <span className="text-xs text-muted tabular-nums">
              {(draft.proposal.initialConcepts?.length ?? draft.proposal.initialConceptTitles.length)} concepts
            </span>
          </div>

          {draft.proposal.initialConcepts && draft.proposal.initialConcepts.length > 0 ? (
            <ol className="mb-5 divide-y divide-line border-y border-line">
              {draft.proposal.initialConcepts.map((c, idx) => (
                <li key={c.slug} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="w-5 shrink-0 font-mono text-xs text-muted tabular-nums">
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <span className="font-medium text-ink">{c.title}</span>
                    {c.isFirst && (
                      <span className="text-xs text-accent">
                        <span aria-hidden="true">· </span>Starts here
                      </span>
                    )}
                  </div>
                  {c.description && <p className="mt-1 pl-7 text-sm leading-relaxed text-ink-soft">{c.description}</p>}
                  {c.prerequisiteTitles.length > 0 && (
                    <p className="mt-1 pl-7 text-xs text-muted">Builds on {c.prerequisiteTitles.join(", ")}</p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <ol className="mb-5 list-decimal space-y-1.5 pl-5 text-ink-soft">
              {draft.proposal.initialConceptTitles.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ol>
          )}

          <p className="mb-1 text-sm text-muted">
            {draft.proposal.cadenceNote} The path adapts as you learn.
          </p>
          {draft.proposal.assumptions.length > 0 && <p className="mb-5 text-sm text-muted">Assumed: {draft.proposal.assumptions.join(" · ")}</p>}
          {draft.devModel && <p className="mb-5 text-xs text-warn">Generated by the development model (placeholder, not real AI).</p>}
          {adjusting ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!adjustment.trim()) return;
                run("adjust", () => api(`/course-drafts/${draft.id}/propose`, { body: { adjustment: adjustment.trim(), expectedVersion: draft.version } })).then((d) => {
                  if (d) {
                    setAdjusting(false);
                    setAdjustment("");
                  }
                });
              }}
              className="space-y-3"
            >
              <label htmlFor="adjust" className="text-sm font-medium text-ink">
                What should change?
              </label>
              <input
                id="adjust"
                autoFocus
                value={adjustment}
                maxLength={500}
                onChange={(e) => setAdjustment(e.target.value)}
                placeholder="e.g. more about the history, skip the basics"
                className="min-h-11 w-full rounded-xl border border-line-strong bg-paper px-3.5 text-ink placeholder:text-muted/75 focus:border-accent/70 focus:outline-none"
              />
              <div className="flex gap-2">
                <Button type="submit" variant="primary" disabled={!adjustment.trim()}>
                  Update plan
                </Button>
                <Button type="button" variant="quiet" onClick={() => setAdjusting(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="mt-5 flex flex-wrap gap-2.5">
              <Button variant="primary" onClick={startCourse} busy={pending === "convert"}>
                Start course
              </Button>
              <Button onClick={() => setAdjusting(true)} disabled={!!pending}>
                Adjust
              </Button>
              {draft.canGoBack && (
                <Button variant="quiet" onClick={() => run("back", () => api(`/course-drafts/${draft.id}/back`, { body: { expectedVersion: draft.version } }))} disabled={!!pending}>
                  <ArrowLeft className="size-4" aria-hidden /> Back
                </Button>
              )}
            </div>
          )}
        </section>
      )}

      {draft.state !== "converted" && !thinking && effectiveStage !== "understanding" && effectiveStage !== "compiling" && (
        <section className="mt-8 text-sm" aria-label="Your background">
          {bgOpen ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run("background", () => api(`/course-drafts/${draft.id}/background`, { body: { text: bgText, stepOnly: true, expectedVersion: draft.version } })).then((d) => d && setBgOpen(false));
              }}
              className="space-y-2"
            >
              <label htmlFor="background" className="block font-medium text-ink">
                Your background
              </label>
              <p className="text-muted">Paste a resume, bio or notes. Ada uses it to skip what you already know. Leave out anything sensitive.</p>
              <textarea
                id="background"
                rows={6}
                maxLength={8000}
                value={bgText}
                onChange={(e) => setBgText(e.target.value)}
                className="w-full rounded-xl border border-line-strong bg-surface px-4 py-3 leading-relaxed text-ink focus:border-accent/70 focus:outline-none"
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm" variant="primary" disabled={bgText.trim() === (draft.background ?? "")}>
                  {draft.background ? "Update background" : "Use this background"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="quiet"
                  onClick={() => {
                    setBgOpen(false);
                    setBgText(draft.background ?? "");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <button onClick={() => setBgOpen(true)} className="min-h-11 text-muted underline underline-offset-2 hover:text-ink">
              {draft.background ? "Background added — edit" : "Add your background (paste a resume or notes)"}
            </button>
          )}
        </section>
      )}

      {error && (
        <div className="mt-6">
          <InlineError message={error.message} onRetry={error.retry} retrying={!!pending} />
        </div>
      )}
    </div>
  );
}

function SetupProgressCard({
  step1Done,
  answeringQuestion,
  adjustingPlan,
  hasLink,
  interpretation,
}: {
  step1Done: boolean;
  answeringQuestion: boolean;
  adjustingPlan: boolean;
  hasLink: boolean;
  interpretation?: DraftInterpretationPreview;
}) {
  const phaseKey = step1Done ? "compile" : "understand";
  const [elapsedState, setElapsedState] = useState<{ key: string; sec: number }>({ key: phaseKey, sec: 0 });
  const elapsedSec = elapsedState.key === phaseKey ? elapsedState.sec : 0;

  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsedState((prev) => (prev.key === phaseKey ? { key: phaseKey, sec: prev.sec + 1 } : { key: phaseKey, sec: 1 }));
    }, 1000);
    return () => window.clearInterval(id);
  }, [phaseKey]);

  const statusHeadline = adjustingPlan
    ? "Updating your starting path…"
    : step1Done
      ? "Building your starting path…"
      : answeringQuestion
        ? "Thinking about your answer…"
        : hasLink
          ? "Reading your link and understanding your goal…"
          : "Understanding what you want to learn…";

  const step1Detail =
    elapsedSec < 5
      ? hasLink
        ? "Fetching the linked page and checking whether any context is needed…"
        : "Checking whether Ada needs a quick clarifying question…"
      : "Summarizing your goal and starting assumptions…";

  const step2Detail =
    elapsedSec < 5
      ? "Designing connected concepts tailored to your goal…"
      : elapsedSec < 12
        ? "Sequencing prerequisites and success criteria — usually takes 10–15 seconds…"
        : "Checking the concept graph so nothing depends on an untaught step…";

  return (
    <div className="rounded-2xl border border-line bg-surface p-6" role="status" aria-live="polite">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-sm font-medium text-ink">
          <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-accent" />
          <span>{statusHeadline}</span>
        </div>
        {elapsedSec >= 4 && (
          <span className="shrink-0 font-mono text-xs text-muted tabular-nums" aria-label={`${elapsedSec} seconds elapsed`}>
            {elapsedSec}s
          </span>
        )}
      </div>

      <ol className="divide-y divide-line border-t border-line text-sm">
        <li className="py-3.5">
          <div className="flex items-start gap-3">
            {step1Done ? (
              <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-good" />
            ) : (
              <span className="mt-0.5 w-4 shrink-0 text-center font-mono text-xs text-accent tabular-nums">01</span>
            )}
            <div className="min-w-0 flex-1">
              <p className={step1Done ? "font-medium text-ink" : "font-medium text-ink"}>
                <span className="sr-only">{step1Done ? "Completed: " : "In progress: "}</span>
                {hasLink ? "Read linked source and clarify goal" : "Understand your topic and goal"}
              </p>
              {step1Done && interpretation ? (
                <div className="mt-1.5 space-y-1">
                  <p className="leading-relaxed text-ink-soft">
                    <span className="font-medium text-ink">
                      {interpretation.intent === "goal" ? "Goal: " : "Direction: "}
                    </span>
                    {interpretation.goalText}
                  </p>
                  {interpretation.assumptions.length > 0 && (
                    <p className="text-xs text-muted">Assumed: {interpretation.assumptions.join(" · ")}</p>
                  )}
                </div>
              ) : (
                !step1Done && <p className="mt-1 text-xs text-muted">{step1Detail}</p>
              )}
            </div>
          </div>
        </li>

        <li className="py-3.5">
          <div className="flex items-start gap-3">
            <span className={`mt-0.5 w-4 shrink-0 text-center font-mono text-xs tabular-nums ${step1Done ? "text-accent" : "text-muted"}`}>
              02
            </span>
            <div className="min-w-0 flex-1">
              <p className={step1Done ? "font-medium text-ink" : "text-muted"}>
                <span className="sr-only">{step1Done ? "In progress: " : "Upcoming: "}</span>
                Map concepts and prerequisite order
              </p>
              {step1Done && <p className="mt-1 text-xs text-muted">{step2Detail}</p>}
            </div>
          </div>
        </li>

        <li className="py-3.5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 w-4 shrink-0 text-center font-mono text-xs text-muted tabular-nums">03</span>
            <div className="min-w-0 flex-1">
              <p className="text-muted">
                <span className="sr-only">Upcoming: </span>
                Validate starting path
              </p>
            </div>
          </div>
        </li>
      </ol>
    </div>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "link";
  }
}
