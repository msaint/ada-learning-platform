import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getPageUser } from "@/lib/auth/server";
import { listCourses } from "@/lib/services/courses";
import { GUEST_COURSE_LIMIT, latestOpenDraft } from "@/lib/services/drafts";
import { NewCoursePrompt } from "@/components/course/new-course-prompt";
import { AmbientGlyphRow } from "@/components/characters/glyphs";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getPageUser();
  const [courses, draft] = user ? await Promise.all([listCourses(user.id), latestOpenDraft(user.id)]) : [[], null];
  const guestAtLimit = !!user?.isGuest && courses.length >= GUEST_COURSE_LIMIT;
  const resumeCourse = courses.find((c) => c.hasOpenSession) ?? null;
  // At most one quiet "pick up" row: whichever was touched most recently.
  let pickUp: { href: string; label: string } | null = null;
  if (draft && (!resumeCourse || draft.updated_at.toISOString() > resumeCourse.updatedAt)) {
    pickUp = { href: `/app/new?draft=${draft.id}`, label: `Finish setting up: ${draft.topic}` };
  } else if (resumeCourse) {
    pickUp = { href: `/app/courses/${resumeCourse.id}`, label: `Pick up where you left off: ${resumeCourse.title}` };
  }

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col items-center justify-center px-4 py-12 md:min-h-dvh md:py-16">
      <div className="w-full max-w-2xl">
        <AmbientGlyphRow />
        <h1 className="mb-3 text-center text-3xl font-semibold tracking-tight text-ink md:text-[2.25rem]">
          What would you like to learn?
        </h1>
        <p className="mb-8 text-center text-sm text-muted">
          Turn scattered curiosity into connected, lasting understanding.
        </p>
        <NewCoursePrompt needsSession={!user} guestAtLimit={guestAtLimit} />
        {pickUp && (
          <div className="mt-7 text-center">
            <Link
              href={pickUp.href}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm text-ink-soft transition-colors hover:border-line-strong hover:bg-elevated hover:text-ink"
            >
              <span className="max-w-[70vw] truncate">{pickUp.label}</span> <ArrowRight className="size-4 shrink-0 text-spark" aria-hidden />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
