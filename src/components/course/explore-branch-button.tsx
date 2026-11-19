"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/primitives";

export function ExploreBranchButton({
  courseId,
  question,
  label = "Explore as a branch",
}: {
  courseId: string;
  question: string;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function explore() {
    const trimmed = question.trim().slice(0, 300);
    if (trimmed.length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ firstConceptId: string }>(`/courses/${courseId}/branches`, { body: { question: trimmed } });
      router.push(`/app/courses/${courseId}?focus=${r.firstConceptId}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't open that branch.");
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button size="sm" variant="quiet" onClick={explore} busy={busy}>
        {label}
      </Button>
      {error && <span className="text-xs text-bad">{error}</span>}
    </span>
  );
}
