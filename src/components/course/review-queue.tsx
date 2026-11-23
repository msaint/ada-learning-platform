"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { DueReview } from "@/lib/schemas/dto";
import { api, ApiError } from "@/lib/client/api";
import { Button, InlineError } from "@/components/ui/primitives";

export function ReviewQueue({ due, upcoming }: { due: DueReview[]; upcoming: DueReview[] }) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [postponedIds, setPostponedIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<{ message: string; retry: () => void } | null>(null);

  const activeDue = due.filter((r) => !postponedIds.has(r.id));
  const byCourse = new Map<string, DueReview[]>();
  for (const r of activeDue) byCourse.set(r.courseId, [...(byCourse.get(r.courseId) ?? []), r]);

  async function postpone(id: string, days: 1 | 3) {
    const key = `${id}:${days}`;
    setBusyKey(key);
    setError(null);
    try {
      await api(`/reviews/${id}/postpone`, { body: { days } });
      setPostponedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      router.refresh();
    } catch (e) {
      setError({
        message: e instanceof ApiError ? e.message : "Couldn't postpone that review.",
        retry: () => postpone(id, days),
      });
    } finally {
      setBusyKey(null);
    }
  }

  const courseCount = byCourse.size;
  const overdueCount = activeDue.filter((r) => r.overdue).length;

  return (
    <div>
      {error && (
        <div className="mb-6">
          <InlineError message={error.message} onRetry={error.retry} retrying={busyKey !== null} />
        </div>
      )}

      {activeDue.length === 0 ? (
        <div className="mb-10 rounded-2xl border border-line bg-surface/60 px-5 py-6">
          <p className="font-medium text-ink">You&apos;re all caught up on reviews</p>
          <p className="mt-1 text-sm text-ink-soft">
            {postponedIds.size > 0
              ? "Postponed items have been moved ahead. Ada will surface them again when they come due."
              : "Nothing is due right now. Ada schedules spaced retrieval automatically as you demonstrate concepts."}
          </p>
          <div className="mt-4">
            <Link
              href="/app"
              className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line-strong bg-surface px-3.5 text-sm font-medium whitespace-nowrap text-ink transition-colors hover:bg-elevated"
            >
              <span>Back to courses</span>
              <ArrowRight className="size-4 text-spark" aria-hidden />
            </Link>
          </div>
        </div>
      ) : (
        <>
          <p className="mb-4 text-xs text-muted tabular-nums">
            {activeDue.length} {activeDue.length === 1 ? "concept" : "concepts"} due
            {courseCount > 1 ? ` across ${courseCount} courses` : ""}
            {overdueCount > 0 ? ` · ${overdueCount} overdue` : ""}
          </p>
          <ul className="mb-10 space-y-4">
            {[...byCourse.entries()].map(([courseId, items]) => (
              <li key={courseId} className="rounded-2xl border border-line bg-surface px-5 py-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="font-semibold break-words text-ink">{items[0].courseTitle}</h2>
                    <p className="text-xs text-muted tabular-nums">
                      {items.length} {items.length === 1 ? "concept" : "concepts"} ready for retrieval
                    </p>
                  </div>
                  <Link
                    href={`/app/courses/${courseId}?kind=review`}
                    className="btn-tactile-primary inline-flex min-h-11 shrink-0 items-center rounded-xl bg-accent px-4 text-[0.95rem] font-semibold whitespace-nowrap text-accent-ink hover:bg-accent-strong"
                  >
                    Start review
                  </Link>
                </div>
                <ul className="divide-y divide-line border-t border-line pt-1 text-sm">
                  {items.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/app/courses/${courseId}?kind=review&focus=${r.conceptId}`}
                          className="font-medium break-words text-ink-soft hover:text-ink hover:underline hover:underline-offset-2"
                        >
                          {r.conceptTitle}
                        </Link>
                        <span className={`ml-2 text-xs whitespace-nowrap tabular-nums ${r.overdue ? "text-warn" : "text-muted"}`}>
                          <span aria-hidden="true">· </span>
                          {r.dueLabel}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1" role="group" aria-label={`Postpone ${r.conceptTitle}`}>
                        <Button
                          size="sm"
                          variant="quiet"
                          busy={busyKey === `${r.id}:1`}
                          disabled={busyKey !== null}
                          onClick={() => postpone(r.id, 1)}
                        >
                          Tomorrow
                        </Button>
                        <Button
                          size="sm"
                          variant="quiet"
                          busy={busyKey === `${r.id}:3`}
                          disabled={busyKey !== null}
                          onClick={() => postpone(r.id, 3)}
                        >
                          3 days
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}

      {upcoming.length > 0 && (
        <section aria-labelledby="upcoming-reviews-heading">
          <h2 id="upcoming-reviews-heading" className="mb-2 text-sm font-medium text-muted">
            Coming up this week
          </h2>
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface/40 px-4 py-1 text-sm text-ink-soft">
            {upcoming.map((r) => (
              <li key={r.id} className="flex items-baseline justify-between gap-4 py-2.5">
                <span className="min-w-0 break-words">
                  <span className="text-ink">{r.conceptTitle}</span>{" "}
                  <span className="text-muted">· {r.courseTitle}</span>
                </span>
                <span className="shrink-0 text-xs text-muted tabular-nums">{r.dueLabel}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
