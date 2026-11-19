import Link from "next/link";
import type { ReactNode } from "react";
import { AdaMark } from "@/components/characters/glyphs";

/** Centered card used by the sign-in, password reset and email link pages. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-xl shadow-black/25">
        <Link href="/app" className="mb-7 inline-flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-ink">
          <AdaMark size={26} />
          <span>Ada</span>
        </Link>
        {children}
      </div>
    </main>
  );
}
