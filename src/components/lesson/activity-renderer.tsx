"use client";

import clsx from "clsx";
import { Check, X } from "lucide-react";
import { useId } from "react";
import type { ActivityFeedback, LearnerActivity } from "@/lib/schemas/dto";
import { Markdown } from "@/components/ui/markdown";

/** Renders one activity through a fixed set of safe components (never model-generated HTML). */
export function ActivityView(props: {
  activity: LearnerActivity;
  choice?: string;
  onChoice: (id: string) => void;
  text: string;
  onText: (v: string) => void;
  onSubmitShortcut: () => void;
  disabled: boolean;
  feedback: ActivityFeedback | null;
  altExplanations: string[];
  hints: string[];
}) {
  const { activity: a } = props;
  const promptId = useId();
  const purposeLabel: Record<string, string> = {
    prediction: "Make a prediction — guessing is fine",
    teach: "Learn",
    remediate: "Another way to see it",
    check: "Check your understanding",
    apply: "Apply it",
    review: "Review",
    transfer: "Stretch",
    reflect: "Reflect",
    probe: "Look closer",
    defend: "Defend your answer",
    recall: "Quick recall",
    placement: "Placement — answer what you can",
    final: "Final check",
    integrative: "Final check — putting it together",
  };

  const kickerTone =
    a.purpose === "final" || a.purpose === "integrative"
      ? "text-prism"
      : a.purpose === "remediate" || a.purpose === "probe" || a.purpose === "review" || a.purpose === "recall" || a.purpose === "defend"
        ? "text-link"
        : "text-spark";

  return (
    <article>
      <p className={clsx("mb-2 text-xs font-medium", kickerTone)}>{purposeLabel[a.purpose] ?? "Activity"}</p>
      {a.kind === "explanation" ? (
        <>
          {a.title && <h2 className="mb-4 text-xl font-semibold tracking-tight text-ink">{a.title}</h2>}
          <Markdown>{a.bodyMarkdown}</Markdown>
          {a.sources && a.sources.length > 0 && (
            <p className="mt-4 text-sm text-muted">
              Sources Ada checked:{" "}
              {a.sources.map((src, i) => (
                <span key={src.url}>
                  {i > 0 && " · "}
                  <a href={src.url} target="_blank" rel="noopener noreferrer nofollow" className="text-ink-soft underline underline-offset-2 hover:text-ink">
                    {src.title?.trim() || hostOf(src.url)}
                  </a>
                </span>
              ))}
            </p>
          )}
        </>
      ) : (
        <div id={promptId}>
          <Markdown>{a.promptMarkdown}</Markdown>
        </div>
      )}

      {props.altExplanations.length > 0 && (
        <div className="mt-6 space-y-4">
          {props.altExplanations.map((x, i) => (
            <div key={i} className="rounded-2xl border border-line-strong bg-surface px-5 py-4">
              <p className="mb-1.5 text-xs font-medium text-link">Explained differently</p>
              <Markdown compact>{x}</Markdown>
            </div>
          ))}
        </div>
      )}

      {props.hints.length > 0 && (
        <div className="mt-5 rounded-2xl border border-link/30 bg-link-soft px-5 py-3.5" aria-live="polite">
          <p className="mb-1.5 text-xs font-semibold text-link">{props.hints.length === 1 ? "Link's hint" : "Link's hints"}</p>
          <ol className="space-y-1.5">
            {props.hints.map((h, i) => (
              <li key={i}>
                <Markdown compact>{h}</Markdown>
              </li>
            ))}
          </ol>
        </div>
      )}

      {a.kind === "multiple_choice" && (
        <fieldset className="mt-6" aria-labelledby={promptId} disabled={props.disabled}>
          <div role="radiogroup" aria-labelledby={promptId} className="space-y-2.5">
            {a.choices.map((c, idx) => {
              const fb = props.feedback;
              const isCorrect = fb?.correctChoiceId === c.id;
              const isChosenWrong = fb && fb.chosenChoiceId === c.id && !isCorrect;
              const selected = props.choice === c.id;
              return (
                <label
                  key={c.id}
                  className={clsx(
                    "choice-card-tactile flex min-h-14 cursor-pointer items-start gap-3.5 rounded-2xl border px-4 py-3.5",
                    fb
                      ? isCorrect
                        ? "border-good/50 bg-good-soft text-ink"
                        : isChosenWrong
                          ? "border-bad/45 bg-bad-soft text-ink"
                          : "border-line bg-surface/50 opacity-75"
                      : selected
                        ? "border-accent bg-accent-soft text-ink"
                        : "border-line-strong bg-surface hover:border-muted/60 hover:bg-elevated",
                    props.disabled && "cursor-default",
                  )}
                >
                  <input type="radio" name={`choice-${a.id}`} value={c.id} checked={selected} onChange={() => props.onChoice(c.id)} className="sr-only" />
                  <span
                    aria-hidden="true"
                    className={clsx(
                      "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-lg border font-mono text-xs font-semibold transition-colors",
                      fb
                        ? isCorrect
                          ? "border-good/60 bg-good/20 text-good"
                          : isChosenWrong
                            ? "border-bad/60 bg-bad/20 text-bad"
                            : "border-line bg-paper text-muted"
                        : selected
                          ? "border-accent bg-accent text-accent-ink"
                          : "border-line-strong bg-paper text-muted",
                    )}
                  >
                    {idx + 1}
                  </span>
                  <span className="flex-1 leading-relaxed text-ink">{c.text}</span>
                  {fb && isCorrect && <Check className="mt-0.5 size-5 shrink-0 text-good" aria-label="Correct answer" />}
                  {fb && isChosenWrong && <X className="mt-0.5 size-5 shrink-0 text-bad" aria-label="Your answer" />}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {(a.kind === "free_response" || a.kind === "reflection") && (
        <div className="mt-6">
          <label htmlFor={`answer-${a.id}`} className="mb-1.5 block text-sm font-medium text-ink-soft">
            {a.kind === "reflection" ? "Your reflection" : "Your answer"}
          </label>
          <textarea
            id={`answer-${a.id}`}
            rows={5}
            maxLength={10000}
            value={props.text}
            readOnly={props.disabled}
            onChange={(e) => props.onText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!props.disabled) props.onSubmitShortcut();
              }
            }}
            className="w-full rounded-2xl border border-line-strong bg-surface px-4 py-3 leading-relaxed text-ink placeholder:text-muted/75 focus:border-accent/70 focus:outline-none read-only:bg-surface/60"
          />
        </div>
      )}
    </article>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}
