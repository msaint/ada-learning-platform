import { getPageUser, getPageWorkspace } from "@/lib/auth/server";
import { usingMockModel } from "@/lib/env";
import { AppShell } from "@/components/layout/app-shell";

export const dynamic = "force-dynamic";

/** The shell renders for visitors without any session too, so they can start a course right away. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getPageUser();
  const { courses, drafts } = user ? await getPageWorkspace(user.id) : { courses: [], drafts: [] };
  return (
    <AppShell
      courses={courses}
      drafts={drafts}
      user={user ? { email: user.email, displayName: user.displayName, isGuest: user.isGuest } : null}
      devModel={usingMockModel()}
    >
      {children}
    </AppShell>
  );
}
