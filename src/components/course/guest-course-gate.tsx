"use client";

import { ArrowRight, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CourseListItem, DraftListItem } from "@/lib/schemas/dto";
import { api, ApiError } from "@/lib/client/api";
import { Button, Dialog, InlineError } from "@/components/ui/primitives";

/**
 * Shown on /app instead of the "What would you like to learn?" prompt whenever
 * a guest already has an active course or an unfinished course setup.
 */
export function GuestCourseGate({
  course,
  draft,
  openDraftIds = [],
}: {
  course: CourseListItem | null;
  draft: DraftListItem | null;
  openDraftIds?: string[];
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeName = course ? course.title : (draft?.title || draft?.topic || "your course");
  const primaryHref = course ? `/app/courses/${course.id}` : `/app/new?draft=${draft!.id}`;
  const primaryLabel = course ? `Continue “${course.title}”` : `Finish setting up “${activeName}”`;

  async function scrapExisting() {
    setBusy(true);
    setError(null);
    try {
      const draftIds = new Set<string>(openDraftIds);
      if (draft) draftIds.add(draft.id);
      if (course) {
        await api(`/courses/${course.id}`, { method: "DELETE" });
      }
      await Promise.all(
        [...draftIds].map((id) =>
          api(`/course-drafts/${id}`, { method: "DELETE" }).catch((err) => {
            if (err instanceof ApiError && err.code === "not_found") return;
            throw err;
          }),
        ),
      );
      setConfirmOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't scrap the existing course.");
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="guest-gate-heading" className="rounded-2xl border border-line-strong bg-surface p-6 shadow-lg shadow-black/20 sm:p-7">
      <h1 id="guest-gate-heading" className="text-2xl font-semibold tracking-tight text-ink">
        {course ? "Continue your course, or start fresh" : "Finish setting up your course, or start fresh"}
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-ink-soft">
        {course ? (
          <>
            Guest sessions hold one course at a time, and <span className="font-medium text-ink">{course.title}</span> is already in progress. Continue where you left off, or scrap it to start a new topic.
          </>
        ) : (
          <>
            You already started setting up <span className="font-medium text-ink">{activeName}</span>. Finish setting it up to begin learning, or scrap it to start a different topic.
          </>
        )}
      </p>

      <div className="mt-6 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
        <Link
          href={primaryHref}
          className="btn-tactile-primary inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-[0.95rem] font-semibold text-accent-ink hover:bg-accent-strong"
        >
          <span className="max-w-[20rem] truncate">{primaryLabel}</span>
          <ArrowRight className="size-4 shrink-0" aria-hidden />
        </Link>
        <Button
          variant="secondary"
          busy={busy && !confirmOpen}
          onClick={() => (course ? setConfirmOpen(true) : scrapExisting())}
        >
          <Trash2 className="size-4 text-muted" aria-hidden />
          Scrap it and create a new one
        </Button>
      </div>

      {error && !confirmOpen && (
        <div className="mt-4">
          <InlineError message={error} onRetry={scrapExisting} retrying={busy} />
        </div>
      )}

      <div className="mt-6 border-t border-line pt-4 text-sm text-muted">
        <span>Want to keep this course and create unlimited courses? </span>
        <Link href="/login?mode=signup&next=/app" className="font-medium text-accent underline underline-offset-2 hover:text-accent-strong">
          Create a free account
        </Link>
        <span> or </span>
        <Link href="/login?mode=signin&next=/app" className="font-medium text-ink-soft underline underline-offset-2 hover:text-ink">
          sign in
        </Link>
        <span>.</span>
      </div>

      {course && (
        <Dialog open={confirmOpen} onClose={() => !busy && setConfirmOpen(false)} title={`Scrap “${course.title}”?`}>
          <p className="mb-5 text-sm leading-relaxed text-ink-soft">
            This permanently deletes <span className="font-medium text-ink">{course.title}</span> along with its lessons and progress so you can start a new course as a guest. If you want to keep it, create a free account instead.
          </p>
          {error && (
            <div className="mb-4">
              <InlineError message={error} />
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="quiet" onClick={() => setConfirmOpen(false)} disabled={busy} autoFocus>
              Cancel
            </Button>
            <Button variant="danger" busy={busy} onClick={scrapExisting}>
              Scrap and start new
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
