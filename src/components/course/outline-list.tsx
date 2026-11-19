"use client";

import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { OutlineView } from "@/lib/schemas/dto";
import { api, ApiError } from "@/lib/client/api";
import { Button, InlineError } from "@/components/ui/primitives";
import { Markdown } from "@/components/ui/markdown";
import { StatusBadge } from "./status-badge";

const RESULT: Record<string, string> = { correct: "Correct", partial: "Partial", incorrect: "Missed", uncertain: "Ungraded", exposure: "Viewed/skipped" };

export function OutlineList({ outline }: { outline: OutlineView }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [breakingId, setBreakingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conceptError, setConceptError] = useState<{ conceptId: string; message: string } | null>(null);

  async function addBranch() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ firstConceptId: string }>(`/courses/${outline.courseId}/branches`, { body: { question: branch.trim() } });
      setBranch("");
      router.push(`/app/courses/${outline.courseId}?focus=${r.firstConceptId}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't add that branch.");
    } finally {
      setBusy(false);
    }
  }

  async function breakIntoSteps(conceptId: string) {
    setBreakingId(conceptId);
    setConceptError(null);
    try {
      const r = await api<{ firstConceptId: string }>(`/courses/${outline.courseId}/concepts/${conceptId}/breakdown`, { body: {} });
      router.push(`/app/courses/${outline.courseId}?focus=${r.firstConceptId}`);
      router.refresh();
    } catch (e) {
      setConceptError({ conceptId, message: e instanceof ApiError ? e.message : "Couldn't break this concept down." });
      setBreakingId(null);
    }
  }

  return (
    <div>
      <p className="mb-5 text-sm text-muted">
        This outline is provisional — Ada adapts it as you learn{outline.curriculumVersion > 1 ? ` (revision ${outline.curriculumVersion})` : ""}.
        {outline.revisionNote ? ` ${outline.revisionNote}` : ""}
      </p>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface/60">
        {outline.concepts.map((c) => {
          const expanded = open === c.id;
          return (
            <li key={c.id} className={clsx(!c.inCurrentPlan && "opacity-70")}>
              <button
                aria-expanded={expanded}
                aria-controls={`concept-${c.id}`}
                onClick={() => setOpen(expanded ? null : c.id)}
                className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-elevated/60"
                style={{ paddingLeft: `${1 + c.depth * 1.25}rem` }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-ink">{c.title}</span>
                  {(c.origin !== "initial" || !c.inCurrentPlan) && (
                    <span className="text-xs text-muted">{!c.inCurrentPlan ? "From an earlier goal" : c.origin === "branch" ? "Curiosity branch" : "Added as your plan adapted"}</span>
                  )}
                </span>
                <StatusBadge status={c.status} />
              </button>
              {expanded && (
                <div id={`concept-${c.id}`} className="space-y-3 border-t border-line bg-surface/60 px-5 py-4 text-sm">
                  <div>
                    <h3 className="mb-1 font-medium">What you&apos;ll learn</h3>
                    <p className="text-ink-soft">{c.description}</p>
                    {c.criteria.length > 0 && (
                      <ul className="mt-2 list-disc pl-5 text-ink-soft">
                        {c.criteria.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {(c.prerequisiteTitles.length > 0 || c.unlocksTitles.length > 0 || c.relatedTitles.length > 0) && (
                    <div className="space-y-1 text-muted">
                      {c.prerequisiteTitles.length > 0 && <p>Builds on: {c.prerequisiteTitles.join(", ")}</p>}
                      {c.unlocksTitles.length > 0 && <p>Unlocks: {c.unlocksTitles.join(", ")}</p>}
                      {c.relatedTitles.length > 0 && <p>Related to: {c.relatedTitles.join(", ")}</p>}
                    </div>
                  )}
                  {c.notes.length > 0 && (
                    <details className="rounded-lg border border-line bg-paper px-4 py-3">
                      <summary className="cursor-pointer font-medium text-ink">
                        Lesson notes &amp; explanations ({c.notes.length})
                      </summary>
                      <div className="mt-3 space-y-4">
                        {c.notes.map((n, idx) => (
                          <article key={idx} className={clsx(idx > 0 && "border-t border-line pt-4")}>
                            <div className="mb-1.5 flex items-baseline justify-between gap-2">
                              <h4 className="font-medium text-ink">{n.title}</h4>
                              <span className="text-xs text-muted">{new Date(n.at).toLocaleDateString()}</span>
                            </div>
                            <Markdown compact>{n.bodyMarkdown}</Markdown>
                            {n.altExplanations.length > 0 && (
                              <div className="mt-3 space-y-2 rounded-xl border border-line bg-surface/70 px-3.5 py-2.5">
                                {n.altExplanations.map((alt, j) => (
                                  <div key={j}>
                                    <p className="mb-1 text-xs font-medium text-link">Another angle</p>
                                    <Markdown compact>{alt}</Markdown>
                                  </div>
                                ))}
                              </div>
                            )}
                            {n.sources.length > 0 && (
                              <div className="mt-3 text-xs text-muted">
                                <span className="font-medium">Sources: </span>
                                {n.sources.map((src, j) => (
                                  <span key={src.url}>
                                    {j > 0 ? " · " : ""}
                                    <a href={src.url} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2 hover:text-ink">
                                      {src.title || src.url}
                                    </a>
                                  </span>
                                ))}
                              </div>
                            )}
                          </article>
                        ))}
                      </div>
                    </details>
                  )}
                  <div>
                    <h3 className="mb-1 font-medium">Evidence</h3>
                    {c.evidence.length === 0 ? (
                      <p className="text-muted">No evidence yet.</p>
                    ) : (
                      <ul className="space-y-0.5 text-ink-soft">
                        {c.evidence.map((e, i) => (
                          <li key={i}>
                            {RESULT[e.result] ?? e.result}
                            {e.independence === "assisted" && e.result !== "exposure" ? " (with help)" : ""} · {e.kind.replace("_", " ")} · {new Date(e.at).toLocaleDateString()}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="primary" onClick={() => router.push(`/app/courses/${outline.courseId}?focus=${c.id}`)}>
                      Study this
                    </Button>
                    {c.struggling && (
                      <Button size="sm" variant="quiet" busy={breakingId === c.id} disabled={breakingId !== null} onClick={() => breakIntoSteps(c.id)}>
                        Break into simpler steps
                      </Button>
                    )}
                  </div>
                  {conceptError?.conceptId === c.id && (
                    <InlineError message={conceptError.message} onRetry={() => breakIntoSteps(c.id)} retrying={breakingId === c.id} />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <form
        className="mt-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (branch.trim().length >= 2) addBranch();
        }}
      >
        <label htmlFor="branch" className="mb-1.5 block text-sm font-medium">
          Curious about something related?
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input id="branch" value={branch} maxLength={300} onChange={(e) => setBranch(e.target.value)} placeholder="e.g. wheel wear, what happens at the edge" className="min-h-11 flex-1 rounded-xl border border-line-strong bg-surface px-3.5 text-ink placeholder:text-muted/75 focus:border-accent/70 focus:outline-none" />
          <Button type="submit" busy={busy} disabled={branch.trim().length < 2}>
            Add to this course
          </Button>
        </div>
        {error && <div className="mt-3"><InlineError message={error} onRetry={addBranch} /></div>}
      </form>
    </div>
  );
}
