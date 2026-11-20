import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { CourseListItem, DraftListItem } from "@/lib/schemas/dto";
import { listCourses } from "@/lib/services/courses";
import { listOpenDrafts } from "@/lib/services/drafts";
import { getUserBySessionToken, SESSION_COOKIE, type AuthUser } from "./session";

/** For server components/layouts: the signed-in user or a redirect to /login. */
export async function requirePageUser(): Promise<AuthUser> {
  const user = await getPageUser();
  if (!user) redirect("/login");
  return user;
}

export const getPageUser = cache(async (): Promise<AuthUser | null> => {
  const jar = await cookies();
  return getUserBySessionToken(jar.get(SESSION_COOKIE)?.value);
});

/** Per-request memoized courses + open drafts so AppLayout and child pages don't double-query on the same render. */
export const getPageWorkspace = cache(async (userId: string): Promise<{ courses: CourseListItem[]; drafts: DraftListItem[] }> => {
  const [courses, drafts] = await Promise.all([listCourses(userId), listOpenDrafts(userId)]);
  return { courses, drafts };
});
