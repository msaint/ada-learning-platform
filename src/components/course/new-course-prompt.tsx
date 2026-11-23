"use client";

import { ArrowUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, ApiError, ensureSession, newKey } from "@/lib/client/api";
import { InlineError } from "@/components/ui/primitives";
import type { CourseDraftView } from "@/lib/schemas/dto";

const MAX = 500;

const STARTER_TOPICS: { label: string; prompt: string }[] = [
  {
    label: "Why train wheels are tapered",
    prompt: "Why train wheels are tapered and how trains steer around curves without a differential",
  },
  {
    label: "SQL window functions",
    prompt: "SQL window functions for analytics and technical interviews",
  },
  {
    label: "How mRNA vaccines work",
    prompt: "How mRNA vaccines train the immune system without altering DNA",
  },
  {
    label: "Negotiating a job offer",
    prompt: "How to evaluate and negotiate a software engineering job offer",
  },
];

export function NewCoursePrompt({ needsSession = false }: { needsSession?: boolean }) {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per intended submission so double-submits/retries create a single draft.
  const keyRef = useRef(newKey());
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function submit() {
    const t = topic.trim();
    if (!t || t.length > MAX || busy) return;
    setBusy(true);
    setError(null);
    try {
      // First-time visitors start as guests: no sign-up before the first course.
      if (needsSession) await ensureSession();
      const { draft } = await api<{ draft: CourseDraftView }>("/course-drafts", { body: { topic: t, idempotencyKey: keyRef.current } });
      router.push(`/app/new?draft=${draft.id}`);
      // Refresh the persistent shell so the new draft appears in the sidebar immediately.
      router.refresh();
    } catch (e) {
      // account_required opens the account dialog (via the API client); don't also show an error.
      if (!(e instanceof ApiError && e.code === "account_required")) setError(e instanceof ApiError ? e.message : "Something went wrong.");
      setBusy(false);
    }
  }

  function pickStarter(prompt: string) {
    if (busy) return;
    setTopic(prompt);
    setError(null);
    keyRef.current = newKey();
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(prompt.length, prompt.length);
    }
  }

  const over = topic.length > MAX;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="relative rounded-2xl border border-line-strong bg-surface shadow-lg shadow-black/20 transition-colors focus-within:border-accent/70">
        <label htmlFor="topic" className="sr-only">
          What would you like to learn?
        </label>
        <textarea
          ref={inputRef}
          id="topic"
          rows={2}
          autoFocus
          value={topic}
          onChange={(e) => {
            setTopic(e.target.value);
            keyRef.current = newKey();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Black holes, SQL window functions, or paste a syllabus or job link…"
          aria-invalid={over || undefined}
          aria-describedby="topic-help"
          className="block max-h-48 min-h-16 w-full resize-none rounded-2xl bg-transparent px-5 py-4 pr-16 text-[1.05rem] leading-relaxed text-ink placeholder:text-muted/75 focus:outline-none"
        />
        <button
          type="submit"
          aria-label="Start"
          disabled={!topic.trim() || over || busy}
          className="btn-tactile-primary absolute right-3 bottom-3 inline-flex size-11 items-center justify-center rounded-xl bg-accent font-semibold text-accent-ink hover:bg-accent-strong disabled:opacity-35"
        >
          <ArrowUp className="size-5 stroke-[2.25]" aria-hidden />
        </button>
      </div>
      <p id="topic-help" className={`mt-2.5 min-h-5 text-center text-xs ${over ? "text-bad" : "text-muted"}`} aria-live="polite">
        {busy
          ? "Ada is mapping your starting path…"
          : over
            ? `Keep it under ${MAX} characters (${topic.length}).`
            : "Any topic, or paste a link (job post, syllabus, article) — Ada builds an adaptive course around it."}
      </p>
      {!busy && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2" role="group" aria-label="Example topics">
          {STARTER_TOPICS.map((s) => {
            const selected = topic === s.prompt;
            return (
              <button
                key={s.label}
                type="button"
                onClick={() => pickStarter(s.prompt)}
                aria-pressed={selected}
                className={`min-h-10 shrink-0 rounded-xl border px-3.5 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                  selected
                    ? "border-accent/60 bg-accent-soft text-ink"
                    : "border-line bg-surface/75 text-ink-soft hover:border-line-strong hover:bg-elevated hover:text-ink"
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      )}
      {error && (
        <div className="mt-4">
          <InlineError message={error} onRetry={submit} />
        </div>
      )}
    </form>
  );
}
