"use client";

import clsx from "clsx";
import { AlertCircle, CheckCircle2, Sparkles } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { ActivityFeedback, LearnerActivity } from "@/lib/schemas/dto";
import { Markdown } from "@/components/ui/markdown";
import { Button } from "@/components/ui/primitives";

const TITLE: Record<string, string> = {
  correct: "Correct",
  partial: "Partly there",
  incorrect: "Not quite",
  uncertain: "Hard to judge",
  exposure: "Noted",
};

export function FeedbackPanel({
  feedback: f,
  activityKind,
  onFlag,
  flagging = false,
}: {
  feedback: ActivityFeedback;
  activityKind: LearnerActivity["kind"];
  onFlag?: () => void;
  flagging?: boolean;
}) {
  const reduced = useReducedMotion();
  const tone =
    f.status === "pending_evaluation" ? "neutral" : f.result === "correct" ? "good" : f.result === "incorrect" ? "bad" : f.result === "partial" || f.result === "uncertain" ? "warn" : "neutral";
  const canFlag = activityKind === "free_response" && f.status === "graded" && !f.skipped && f.result !== "correct" && f.result !== "exposure";

  return (
    <motion.section
      aria-live="polite"
      aria-label="Feedback"
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={clsx(
        "rounded-2xl border px-5 py-4",
        tone === "good" && "border-good/35 bg-good-soft",
        tone === "bad" && "border-bad/35 bg-bad-soft",
        tone === "warn" && "border-warn/35 bg-warn-soft",
        tone === "neutral" && "border-line-strong bg-surface",
      )}
    >
      <h3
        className={clsx(
          "mb-1.5 flex items-center gap-2 font-semibold",
          tone === "good" && "text-good",
          tone === "bad" && "text-bad",
          tone === "warn" && "text-warn",
          tone === "neutral" && "text-ink",
        )}
      >
        {tone === "good" && <CheckCircle2 className="size-4 shrink-0" aria-hidden />}
        {(tone === "bad" || tone === "warn") && <AlertCircle className="size-4 shrink-0" aria-hidden />}
        {tone === "neutral" && <Sparkles className="size-4 shrink-0 text-spark" aria-hidden />}
        <span>{f.status === "pending_evaluation" ? "Answer saved" : f.skipped ? "Skipped" : TITLE[f.result ?? "exposure"]}</span>
        {f.status === "graded" && f.independence === "assisted" && !f.skipped && f.result !== "exposure" && <span className="text-xs font-normal text-muted">(with help)</span>}
      </h3>
      <Markdown compact>{f.feedbackMarkdown}</Markdown>
      {f.rationale && (
        <div className="mt-3">
          <Markdown compact>{f.rationale}</Markdown>
        </div>
      )}
      {f.criteria && f.criteria.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {f.criteria.map((c, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className={clsx("font-semibold", c.met === "yes" ? "text-good" : c.met === "partly" ? "text-warn" : "text-bad")}>
                {c.met === "yes" ? "✓" : c.met === "partly" ? "~" : "✗"}
              </span>
              <span>
                <span className="sr-only">{c.met === "yes" ? "Met" : c.met === "partly" ? "Partly met" : "Not met"}: </span>
                {c.criterion}
                {c.reason && <span className="text-muted"> — {c.reason}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {f.exampleAnswer && activityKind === "free_response" && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-ink-soft hover:text-ink">See an example answer</summary>
          <div className="mt-2">
            <Markdown compact>{f.exampleAnswer}</Markdown>
          </div>
        </details>
      )}
      {canFlag && (f.flagged || onFlag) && (
        <div className="mt-3">
          {f.flagged ? (
            <p className="text-xs text-muted">Thanks — flagged for review.</p>
          ) : (
            <Button size="sm" variant="quiet" onClick={onFlag} busy={flagging} className="-ml-2 text-xs text-muted hover:text-ink">
              That felt misgraded
            </Button>
          )}
        </div>
      )}
    </motion.section>
  );
}
