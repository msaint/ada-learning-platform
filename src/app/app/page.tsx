import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getPageUser, getPageWorkspace } from "@/lib/auth/server";
import { GUEST_COURSE_LIMIT } from "@/lib/services/drafts";
import { NewCoursePrompt } from "@/components/course/new-course-prompt";
import { GuestCourseGate } from "@/components/course/guest-course-gate";
import { AmbientGlyphRow } from "@/components/characters/glyphs";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getPageUser();
  const { courses, drafts } = user ? await getPageWorkspace(user.id) : { courses: [], drafts: [] };
  const existingCourse = courses[0] ?? null;
  const existingDraft = drafts[0] ?? null;
  const guestBlocked = !!user?.isGuest && (courses.length >= GUEST_COURSE_LIMIT || existingDraft !== null);

  const resumeCourse = courses.find((c) => c.hasOpenSession) ?? null;
  // At most one quiet "pick up" row for signed-in users: whichever was touched most recently.
  let pickUp: { href: string; label: string } | null = null;
  if (!guestBlocked) {
    if (existingDraft && (!resumeCourse || existingDraft.updatedAt > resumeCourse.updatedAt)) {
      pickUp = { href: `/app/new?draft=${existingDraft.id}`, label: `Finish setting up: ${existingDraft.title || existingDraft.topic}` };
    } else if (resumeCourse) {
      pickUp = { href: `/app/courses/${resumeCourse.id}`, label: `Pick up where you left off: ${resumeCourse.title}` };
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col items-center justify-center px-4 py-12 md:min-h-dvh md:py-16">
      <div className="w-full max-w-2xl">
        <AmbientGlyphRow />
        {guestBlocked ? (
          <GuestCourseGate
            course={existingCourse}
            draft={existingDraft}
            openDraftIds={drafts.map((d) => d.id)}
          />
        ) : (
          <>
            <h1 className="mb-8 text-center text-3xl font-semibold tracking-tight text-ink md:text-[2.25rem]">
              What would you like to learn?
            </h1>
            <NewCoursePrompt needsSession={!user} />
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
          </>
        )}
      </div>
    </div>
  );
}
