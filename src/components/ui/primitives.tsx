"use client";

import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "secondary" | "quiet" | "danger";

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; size?: "md" | "sm" }>(
  function Button({ variant = "secondary", busy, size = "md", className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        className={clsx(
          "inline-flex items-center justify-center gap-2 rounded-xl font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          size === "md" ? "min-h-11 px-4 text-[0.95rem]" : "min-h-9 px-3 text-sm",
          variant === "primary" && "btn-tactile-primary bg-accent font-semibold text-accent-ink",
          variant === "secondary" && "btn-tactile-secondary border border-line-strong bg-surface text-ink",
          variant === "quiet" && "text-muted hover:bg-surface hover:text-ink",
          variant === "danger" && "bg-bad font-semibold text-accent-ink hover:opacity-90",
          className,
        )}
        {...rest}
      >
        {busy && <Loader2 aria-hidden className="size-4 animate-spin" />}
        {children}
      </button>
    );
  },
);

export function InlineError({ message, onRetry, retrying }: { message: string; onRetry?: () => void; retrying?: boolean }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad">
      <span className="flex-1">{message}</span>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry} busy={retrying}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-muted">
      <Loader2 aria-hidden className="size-4 animate-spin text-accent" />
      <span>{label}</span>
    </div>
  );
}

/** Accessible modal dialog: focus moves in, Escape closes, focus returns to the opener. */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label={title}
      className="m-auto w-[min(92vw,460px)] rounded-2xl border border-line-strong bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/65"
    >
      {open && (
        <div className="p-6">
          <h2 className="mb-4 text-lg font-semibold text-ink">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function DevModelBanner() {
  return (
    <div role="note" className="border-b border-warn/25 bg-warn-soft px-4 py-1.5 text-center text-xs text-warn">
      Development model active — lessons are deterministic placeholders, <strong>not real AI</strong>. Set OPENAI_API_KEY or ANTHROPIC_API_KEY to use a real model.
    </div>
  );
}
