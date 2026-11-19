"use client";

import clsx from "clsx";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { CharacterGlyph } from "./glyphs";
import { CHARACTER_META, type CharacterId, type CharacterPresence } from "./state-machine";

interface CompanionAction {
  label: string;
  onClick: () => void;
  busy?: boolean;
}

/**
 * Tactile Synapse & Spark companion banner with cursor-reactive geometric form,
 * character voice micro-copy (<=120 chars), and optional contextual action.
 */
export function CharacterCompanion({
  presence,
  action,
  compact = false,
  className,
}: {
  presence: CharacterPresence;
  action?: CompanionAction | null;
  compact?: boolean;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [pulseKey, setPulseKey] = useState(0);
  const meta = CHARACTER_META[presence.character];

  const toneBorder: Record<CharacterId, string> = {
    spark: "border-spark/25 bg-surface/90",
    link: "border-link/25 bg-surface/90",
    prism: "border-prism/30 bg-surface/95",
    static: "border-static/25 bg-surface/90",
  };

  const nameColor: Record<CharacterId, string> = {
    spark: "text-spark",
    link: "text-link",
    prism: "text-prism",
    static: "text-static",
  };

  return (
    <div
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
        const y = ((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1;
        setPointer({ x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) });
      }}
      onPointerLeave={() => setPointer({ x: 0, y: 0 })}
      className={clsx(
        "flex items-center gap-3.5 rounded-2xl border transition-colors",
        compact ? "px-3.5 py-2.5" : "px-4 py-3",
        toneBorder[presence.character],
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setPulseKey((k) => k + 1)}
        aria-label={`${meta.name} — ${meta.role}. Tap to interact`}
        className="relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-xl p-0.5 transition-transform active:scale-95"
      >
        <AnimatePresence mode="wait">
          <motion.span
            key={presence.character}
            initial={reduced ? false : { opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduced ? undefined : { opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="block"
          >
            <CharacterGlyph character={presence.character} mood={presence.mood} size={compact ? 44 : 52} pointer={pointer} pulseKey={pulseKey} />
          </motion.span>
        </AnimatePresence>
        {presence.secondary && (
          <span className="absolute -right-1 -bottom-1 rounded-full bg-paper p-0.5 ring-1 ring-line">
            <CharacterGlyph character={presence.secondary} mood="guiding" size={20} />
          </span>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className={clsx("font-semibold", nameColor[presence.character])}>{meta.name}</span>
          <span aria-hidden className="text-muted">·</span>
          <span className="text-muted">{meta.role}</span>
          {presence.streak && presence.streak >= 2 && (
            <>
              <span aria-hidden className="text-muted">·</span>
              <span className="font-mono text-prism tabular-nums">{presence.streak} in a row</span>
            </>
          )}
        </div>
        <AnimatePresence mode="wait">
          <motion.p
            key={presence.line}
            initial={reduced ? false : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: -3 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="mt-0.5 text-sm leading-snug text-ink-soft"
          >
            {presence.line}
          </motion.p>
        </AnimatePresence>
      </div>

      {action && (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.busy}
          className="btn-tactile-secondary min-h-9 shrink-0 rounded-lg border border-line-strong bg-elevated px-3 text-xs font-medium whitespace-nowrap text-ink hover:border-link/60 hover:text-link disabled:opacity-50"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

const CAST_SAMPLES: Record<CharacterId, { line: string; mood: CharacterPresence["mood"] }> = {
  spark: { line: "Ooh, messy. Let's poke at this idea and see what breaks.", mood: "excited" },
  link: { line: "Hold on—you already solved something like this earlier. See the thread?", mood: "guiding" },
  prism: { line: "Locked in. That concept is officially part of your architecture now.", mood: "celebrating" },
  static: { line: "Brain fog detected. Totally normal—let's untangle this one piece at a time.", mood: "soothing" },
};

const CAST_ORDER: CharacterId[] = ["spark", "link", "prism", "static"];

/**
 * Interactive cast switcher for the home screen so learners can meet
 * Spark, Link, Prism, and Static before starting a course.
 */
export function CharacterCastShowcase() {
  const [active, setActive] = useState<CharacterId>("spark");
  const [pulseKey, setPulseKey] = useState(0);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const meta = CHARACTER_META[active];
  const sample = CAST_SAMPLES[active];

  return (
    <section aria-label="Learning companions" className="mt-10 border-t border-line/80 pt-7">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-medium text-muted">How Ada adapts with you</p>
        <div role="tablist" aria-label="Companion states" className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface p-1">
          {CAST_ORDER.map((id) => {
            const m = CHARACTER_META[id];
            const selected = id === active;
            return (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={selected}
                onClick={() => {
                  setActive(id);
                  setPulseKey((k) => k + 1);
                }}
                className={clsx(
                  "min-h-8 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition-colors",
                  selected ? "bg-elevated text-ink shadow-sm" : "text-muted hover:text-ink-soft",
                )}
              >
                {m.name}
              </button>
            );
          })}
        </div>
      </div>

      <div
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPointer({
            x: Math.max(-1, Math.min(1, ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1)),
            y: Math.max(-1, Math.min(1, ((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1)),
          });
        }}
        onPointerLeave={() => setPointer({ x: 0, y: 0 })}
        className="flex items-center gap-4 rounded-2xl border border-line bg-surface/80 px-4 py-3.5"
      >
        <button
          type="button"
          onClick={() => setPulseKey((k) => k + 1)}
          aria-label={`Interact with ${meta.name}`}
          className="shrink-0 cursor-pointer rounded-xl p-1 transition-transform active:scale-95"
        >
          <CharacterGlyph character={active} mood={sample.mood} size={56} pointer={pointer} pulseKey={pulseKey} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-ink">{meta.name}</span>
            <span aria-hidden className="text-muted">·</span>
            <span className="text-muted">{meta.role}</span>
            <span aria-hidden className="text-muted">·</span>
            <span className="text-muted">{meta.tagline}</span>
          </div>
          <p className="mt-1 text-sm text-ink-soft">&ldquo;{sample.line}&rdquo;</p>
        </div>
      </div>
    </section>
  );
}
