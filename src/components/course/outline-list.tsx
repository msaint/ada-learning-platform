"use client";

import clsx from "clsx";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { OutlineView } from "@/lib/schemas/dto";
import { api, ApiError } from "@/lib/client/api";
import { Button, InlineError } from "@/components/ui/primitives";
import { Markdown } from "@/components/ui/markdown";
import { StatusBadge } from "./status-badge";

const RESULT: Record<string, string> = {
  correct: "Correct",
  partial: "Partial",
  incorrect: "Missed",
  uncertain: "Ungraded",
  exposure: "Viewed/skipped",
};

const DEPTH_INDENT = ["pl-4", "pl-8", "pl-12", "pl-16"] as const;

type FilterMode = "all" | "needs_work" | "notes" | "demonstrated";

export function OutlineList({ outline }: { outline: OutlineView }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [query, setQuery] = useState("");
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

  const needsWork = (c: OutlineView["concepts"][number]) => c.status === "developing" || c.status === "review_due" || c.struggling;
  const needsWorkCount = outline.concepts.filter(needsWork).length;
  const notesCount = outline.concepts.filter((c) => c.notes.length > 0).length;
  const demonstratedCount = outline.concepts.filter((c) => c.status === "demonstrated").length;
  const showToolbar = outline.concepts.length >= 2 && (needsWorkCount > 0 || notesCount > 0 || demonstratedCount > 0 || outline.concepts.length >= 6);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredConcepts = outline.concepts.filter((c) => {
    if (filter === "needs_work" && !needsWork(c)) return false;
    if (filter === "notes" && c.notes.length === 0) return false;
    if (filter === "demonstrated" && c.status !== "demonstrated") return false;
    if (normalizedQuery) {
      const hay = `${c.title} ${c.description}`.toLowerCase();
      if (!hay.includes(normalizedQuery)) return false;
    }
    return true;
  });

  function actionForConcept(c: OutlineView["concepts"][number]): { label: string; href: string } {
    if (c.status === "review_due") {
      return { label: "Review this", href: `/app/courses/${outline.courseId}?kind=review&focus=${c.id}` };
    }
    if (c.status === "demonstrated") {
      return { label: "Practise again", href: `/app/courses/${outline.courseId}?focus=${c.id}` };
    }
    if (c.status === "developing") {
      return { label: "Continue practising", href: `/app/courses/${outline.courseId}?focus=${c.id}` };
    }
    return { label: "Study this", href: `/app/courses/${outline.courseId}?focus=${c.id}` };
  }

  return (
    <div>
      <p className="mb-5 text-sm text-muted">
        This outline is provisional — Ada adapts it as you learn{outline.curriculumVersion > 1 ? ` (revision ${outline.curriculumVersion})` : ""}.
        {outline.revisionNote ? ` ${outline.revisionNote}` : ""}
      </p>

      {showToolbar && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-line bg-surface p-1" role="group" aria-label="Filter concepts">
            <FilterTab active={filter === "all"} onClick={() => setFilter("all")}>
              All ({outline.concepts.length})
            </FilterTab>
            {needsWorkCount > 0 && (
              <FilterTab active={filter === "needs_work"} onClick={() => setFilter("needs_work")}>
                Needs work ({needsWorkCount})
              </FilterTab>
            )}
            {notesCount > 0 && (
              <FilterTab active={filter === "notes"} onClick={() => setFilter("notes")}>
                Saved notes ({notesCount})
              </FilterTab>
            )}
            {demonstratedCount > 0 && (
              <FilterTab active={filter === "demonstrated"} onClick={() => setFilter("demonstrated")}>
                Demonstrated ({demonstratedCount})
              </FilterTab>
            )}
          </div>

          {outline.concepts.length >= 6 && (
            <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <label htmlFor="outline-search" className="sr-only">
                Find a concept
              </label>
              <input
                id="outline-search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a concept…"
                className="min-h-10 w-full rounded-xl border border-line bg-surface pr-3 pl-9 text-sm text-ink placeholder:text-muted/75 focus:border-accent/70 focus:outline-none"
              />
            </div>
          )}
        </div>
      )}

      {filteredConcepts.length === 0 ? (
        <div className="rounded-2xl border border-line bg-surface/60 px-5 py-6 text-sm text-muted">
          <p className="mb-3 text-ink-soft">No concepts match that filter.</p>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setFilter("all");
              setQuery("");
            }}
          >
            Show all concepts
          </Button>
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface/60">
          {filteredConcepts.map((c) => {
            const expanded = open === c.id;
            const indentClass = DEPTH_INDENT[Math.min(3, Math.max(0, c.depth))];
            const metaParts: string[] = [];
            if (!c.inCurrentPlan) metaParts.push("From an earlier goal");
            else if (c.origin === "branch") metaParts.push("Curiosity branch");
            else if (c.origin === "revision") metaParts.push("Added as your plan adapted");

            if (c.notes.length > 0) {
              metaParts.push(`${c.notes.length} saved ${c.notes.length === 1 ? "note" : "notes"}`);
            }
            if (c.status === "not_assessed") {
              const unmet = c.unmetPrerequisiteTitles ?? [];
              if (unmet.length > 0) {
                metaParts.push(`After ${unmet[0]}${unmet.length > 1 ? ` +${unmet.length - 1}` : ""}`);
              } else if (c.inCurrentPlan) {
                metaParts.push("Ready to start");
              }
            }

            const primaryAction = actionForConcept(c);

            return (
              <li key={c.id} className={clsx(!c.inCurrentPlan && "opacity-70")}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`concept-${c.id}`}
                  onClick={() => setOpen(expanded ? null : c.id)}
                  className={clsx(
                    "flex min-h-12 w-full items-center gap-3 pr-4 py-3 text-left transition-colors hover:bg-elevated/60",
                    indentClass,
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-ink">{c.title}</span>
                    {metaParts.length > 0 && (
                      <span className="mt-0.5 block text-xs text-muted tabular-nums">{metaParts.join(" · ")}</span>
                    )}
                  </span>
                  <StatusBadge status={c.status} />
                </button>
                {expanded && (
                  <div id={`concept-${c.id}`} className="space-y-4 border-t border-line bg-surface/60 px-5 py-4 text-sm">
                    <div>
                      <h3 className="mb-1 font-medium text-ink">What you&apos;ll learn</h3>
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
                      <details className="border-t border-line pt-3">
                        <summary className="cursor-pointer font-medium text-ink tabular-nums">
                          Lesson notes &amp; explanations ({c.notes.length})
                        </summary>
                        <div className="mt-3 space-y-4">
                          {c.notes.map((n, idx) => {
                            const safeSources = n.sources.filter((src) => /^https?:\/\//i.test(src.url));
                            return (
                              <article key={n.id || idx} className={clsx(idx > 0 && "border-t border-line pt-4")}>
                                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                                  <h4 className="font-medium text-ink">{n.title || "Explanation"}</h4>
                                  <span className="text-xs text-muted tabular-nums">{new Date(n.at).toLocaleDateString()}</span>
                                </div>
                                <Markdown compact>{n.bodyMarkdown}</Markdown>
                                {n.altExplanations.length > 0 && (
                                  <div className="mt-3 space-y-3 border-t border-line pt-3">
                                    {n.altExplanations.map((alt, j) => (
                                      <div key={j}>
                                        <p className="mb-1 text-xs font-medium text-link">Another angle</p>
                                        <Markdown compact>{alt}</Markdown>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {safeSources.length > 0 && (
                                  <div className="mt-3 text-xs text-muted">
                                    <span className="font-medium">Sources: </span>
                                    {safeSources.map((src, j) => (
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
                            );
                          })}
                        </div>
                      </details>
                    )}
                    <div className="border-t border-line pt-3">
                      <h3 className="mb-1 font-medium text-ink">Evidence</h3>
                      {c.evidence.length === 0 ? (
                        <p className="text-muted">No evidence yet.</p>
                      ) : (
                        <ul className="space-y-0.5 text-ink-soft tabular-nums">
                          {c.evidence.map((e, i) => (
                            <li key={i}>
                              {RESULT[e.result] ?? e.result}
                              {e.independence === "assisted" && e.result !== "exposure" ? " (with help)" : ""} · {e.kind.replace("_", " ")} · {new Date(e.at).toLocaleDateString()}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <Button size="sm" variant="primary" onClick={() => router.push(primaryAction.href)}>
                        {primaryAction.label}
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
      )}

      <form
        className="mt-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (branch.trim().length >= 2) addBranch();
        }}
      >
        <label htmlFor="branch" className="mb-1.5 block text-sm font-medium text-ink">
          Curious about something related?
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="branch"
            value={branch}
            maxLength={300}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="e.g. wheel wear, what happens at the edge"
            className="min-h-11 flex-1 rounded-xl border border-line-strong bg-surface px-3.5 text-ink placeholder:text-muted/75 focus:border-accent/70 focus:outline-none"
          />
          <Button type="submit" busy={busy} disabled={branch.trim().length < 2}>
            Add to this course
          </Button>
        </div>
        {error && (
          <div className="mt-3">
            <InlineError message={error} onRetry={addBranch} />
          </div>
        )}
      </form>
    </div>
  );
}

function FilterTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "min-h-8 shrink-0 rounded-lg px-3 py-1 text-xs font-medium whitespace-nowrap tabular-nums transition-colors",
        active ? "bg-elevated text-ink shadow-sm" : "text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
