"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";
import type { CharacterId, CharacterMood } from "./state-machine";

interface GlyphProps {
  mood?: CharacterMood;
  size?: number;
  pointer?: { x: number; y: number };
  pulseKey?: number;
  className?: string;
}

/**
 * Spark: 4 energetic electric-cyan orbs orbiting and bouncing with
 * elastic squish-and-stretch. Reacts to cursor offset and pulse taps.
 */
export function SparkGlyph({ mood = "idle", size = 56, pointer = { x: 0, y: 0 }, pulseKey = 0, className }: GlyphProps) {
  const reduced = useReducedMotion();
  const gid = useId();
  const excited = mood === "excited" || mood === "celebrating" || mood === "merging";
  const spread = excited ? 1.18 : 1;
  const px = pointer.x * 4;
  const py = pointer.y * 4;

  const orbs = [
    { cx: 24, cy: 23, r: 7.5, dx: [-3, 4, -2], dy: [-4, 2, -3], dur: 2.3, color: "#67e8f9" },
    { cx: 41, cy: 21, r: 5.5, dx: [3, -4, 2], dy: [-3, 5, -2], dur: 1.9, color: "#22d3ee" },
    { cx: 36, cy: 39, r: 6.4, dx: [4, -3, 3], dy: [3, -4, 2], dur: 2.6, color: "#38bdf8" },
    { cx: 20, cy: 38, r: 4.2, dx: [-4, 3, -2], dy: [4, -3, 3], dur: 2.1, color: "#a5f3fc" },
  ];

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden className={className}>
      <defs>
        <radialGradient id={`${gid}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="28" fill={`url(#${gid}-glow)`} />
      {orbs.map((o, i) => (
        <motion.g
          key={`${i}-${pulseKey}`}
          animate={
            reduced
              ? { x: 0, y: 0 }
              : {
                  x: o.dx.map((v) => v * spread + px * (0.6 + i * 0.15)),
                  y: o.dy.map((v) => v * spread + py * (0.6 + i * 0.15)),
                  scaleX: excited ? [1, 1.16, 0.9, 1] : [1, 1.07, 0.96, 1],
                  scaleY: excited ? [1, 0.86, 1.14, 1] : [1, 0.94, 1.06, 1],
                }
          }
          transition={{
            duration: excited ? o.dur * 0.72 : o.dur,
            repeat: Infinity,
            repeatType: "mirror",
            ease: "easeInOut",
            delay: i * 0.16,
          }}
          style={{ transformOrigin: `${o.cx}px ${o.cy}px` }}
        >
          <circle cx={o.cx} cy={o.cy} r={o.r} fill={o.color} />
          <circle cx={o.cx - o.r * 0.28} cy={o.cy - o.r * 0.28} r={o.r * 0.28} fill="#ffffff" fillOpacity="0.7" />
        </motion.g>
      ))}
    </svg>
  );
}

/**
 * Link: Two luminous warm-amber nodes connected by a vibrating elastic filament
 * that plucks and snaps taut when ideas connect.
 */
export function LinkGlyph({ mood = "idle", size = 56, pointer = { x: 0, y: 0 }, pulseKey = 0, className }: GlyphProps) {
  const reduced = useReducedMotion();
  const gid = useId();
  const taut = mood === "celebrating" || mood === "merging";
  const px = pointer.x * 3.5;
  const py = pointer.y * 3.5;

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden className={className}>
      <defs>
        <radialGradient id={`${gid}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${gid}-thread`} x1="16" y1="38" x2="48" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="50%" stopColor="#fef3c7" />
          <stop offset="100%" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="28" fill={`url(#${gid}-glow)`} />
      {/* Vibrating elastic tether */}
      <motion.path
        key={`thread-${pulseKey}-${taut}`}
        d="M17 39 Q32 32 47 25"
        stroke={`url(#${gid}-thread)`}
        strokeWidth="2.8"
        strokeLinecap="round"
        animate={
          reduced
            ? { d: "M17 39 Q32 32 47 25" }
            : taut
              ? { d: ["M17 39 Q32 23 47 25", "M17 39 Q32 39 47 25", "M17 39 Q32 32 47 25"] }
              : {
                  d: [
                    `M17 39 Q${32 + px} ${26 + py} 47 25`,
                    `M17 39 Q${32 + px} ${37 + py} 47 25`,
                    `M17 39 Q${32 + px} ${29 + py} 47 25`,
                  ],
                }
        }
        transition={
          taut
            ? { duration: 0.55, ease: [0.16, 1, 0.3, 1] }
            : { duration: 2.4, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" }
        }
      />
      {/* Left anchor node */}
      <motion.g
        animate={reduced ? undefined : { x: [0, 1.5 + px * 0.4, 0], y: [0, -1 + py * 0.4, 0] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
      >
        <circle cx="17" cy="39" r="8.2" fill="#f59e0b" fillOpacity="0.22" />
        <circle cx="17" cy="39" r="5.5" fill="#fbbf24" />
        <circle cx="15.5" cy="37.5" r="1.8" fill="#ffffff" fillOpacity="0.8" />
      </motion.g>
      {/* Right anchor node */}
      <motion.g
        animate={reduced ? undefined : { x: [0, -1.5 + px * 0.5, 0], y: [0, 1.2 + py * 0.5, 0] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut", delay: 0.25 }}
      >
        <circle cx="47" cy="25" r="8.8" fill="#fbbf24" fillOpacity="0.22" />
        <circle cx="47" cy="25" r="6" fill="#f59e0b" />
        <circle cx="45.2" cy="23.2" r="2" fill="#fef3c7" fillOpacity="0.85" />
      </motion.g>
      {/* Snap ring on celebration/tap */}
      {!reduced && (taut || pulseKey > 0) && (
        <motion.circle
          key={`ring-${pulseKey}-${taut}`}
          cx="32"
          cy="32"
          r="6"
          stroke="#fde68a"
          strokeWidth="1.5"
          initial={{ scale: 0.5, opacity: 0.85 }}
          animate={{ scale: 2.8, opacity: 0 }}
          transition={{ duration: 0.75, ease: "easeOut" }}
          style={{ transformOrigin: "32px 32px" }}
        />
      )}
    </svg>
  );
}

/**
 * Prism: Multi-faceted 3D-style iridescent violet/white octahedron crystal
 * with smooth weighted levitation and subtle refracting light rings.
 */
export function PrismGlyph({ mood = "idle", size = 56, pointer = { x: 0, y: 0 }, pulseKey = 0, className }: GlyphProps) {
  const reduced = useReducedMotion();
  const gid = useId();
  const celebrating = mood === "celebrating" || mood === "merging";

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden className={className}>
      <defs>
        <radialGradient id={`${gid}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#c4b5fd" stopOpacity="0.38" />
          <stop offset="65%" stopColor="#22d3ee" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#818cf8" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${gid}-f1`} x1="32" y1="10" x2="14" y2="33" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#c4b5fd" />
        </linearGradient>
        <linearGradient id={`${gid}-f2`} x1="32" y1="10" x2="50" y2="33" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#e0e7ff" />
          <stop offset="100%" stopColor="#818cf8" />
        </linearGradient>
        <linearGradient id={`${gid}-f3`} x1="14" y1="33" x2="32" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>
        <linearGradient id={`${gid}-f4`} x1="50" y1="33" x2="32" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#67e8f9" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="29" fill={`url(#${gid}-glow)`} />
      {!reduced && (celebrating || pulseKey > 0) && (
        <motion.polygon
          key={`wave-${pulseKey}-${celebrating}`}
          points="32,8 52,32 32,56 12,32"
          stroke="#e9d5ff"
          strokeWidth="1.2"
          fill="none"
          initial={{ scale: 0.75, opacity: 0.75 }}
          animate={{ scale: 1.32, opacity: 0 }}
          transition={{ duration: 1.1, ease: "easeOut" }}
          style={{ transformOrigin: "32px 32px" }}
        />
      )}
      <motion.g
        animate={
          reduced
            ? undefined
            : {
                y: [-2.2, 2.2, -2.2],
                rotate: [pointer.x * 6 - 2, pointer.x * 6 + 2, pointer.x * 6 - 2],
                scale: celebrating ? [0.94, 1.05, 1] : 1,
              }
        }
        transition={{
          y: { duration: 3.6, repeat: Infinity, ease: "easeInOut" },
          rotate: { duration: 4.4, repeat: Infinity, ease: "easeInOut" },
          scale: { duration: 0.55, ease: [0.16, 1, 0.3, 1] },
        }}
        style={{ transformOrigin: "32px 32px" }}
      >
        {/* Top-left bright facet */}
        <polygon points="32,10 14,32 32,36" fill={`url(#${gid}-f1)`} />
        {/* Top-right iridescent facet */}
        <polygon points="32,10 50,32 32,36" fill={`url(#${gid}-f2)`} />
        {/* Bottom-left deep violet facet */}
        <polygon points="14,32 32,54 32,36" fill={`url(#${gid}-f3)`} />
        {/* Bottom-right cyan-violet refraction facet */}
        <polygon points="50,32 32,54 32,36" fill={`url(#${gid}-f4)`} />
        {/* Crisp geometric edge highlights */}
        <polygon points="32,10 50,32 32,54 14,32" stroke="#f8fafc" strokeOpacity="0.65" strokeWidth="1" fill="none" />
        <line x1="32" y1="10" x2="32" y2="54" stroke="#ffffff" strokeOpacity="0.45" strokeWidth="0.9" />
        <line x1="14" y1="32" x2="50" y2="32" stroke="#ffffff" strokeOpacity="0.3" strokeWidth="0.8" />
      </motion.g>
    </svg>
  );
}

/**
 * Static: Soft, low-opacity cloud of vibrating tangled geometric wave paths
 * and muted coral/slate micro-particles that smooth out when calmed.
 */
export function StaticGlyph({ mood = "soothing", size = 56, pointer = { x: 0, y: 0 }, pulseKey = 0, className }: GlyphProps) {
  const reduced = useReducedMotion();
  const gid = useId();
  const calmed = pulseKey > 0 && mood === "soothing";
  const jitter = calmed ? 0.6 : 1.8;

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden className={className}>
      <defs>
        <radialGradient id={`${gid}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fb7185" stopOpacity="0.24" />
          <stop offset="70%" stopColor="#94a3b8" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#94a3b8" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="27" fill={`url(#${gid}-glow)`} />
      <motion.g
        animate={
          reduced
            ? undefined
            : {
                x: [-jitter + pointer.x * 2, jitter + pointer.x * 2, -jitter * 0.5 + pointer.x * 2],
                y: [jitter * 0.6 + pointer.y * 2, -jitter * 0.6 + pointer.y * 2, jitter * 0.4 + pointer.y * 2],
              }
        }
        transition={{ duration: calmed ? 2.8 : 0.9, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" }}
      >
        <path
          d="M16 33 C20 22, 27 42, 32 30 C37 19, 43 41, 48 31"
          stroke="#fda4af"
          strokeOpacity="0.82"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
        <path
          d="M18 26 C24 36, 30 20, 36 35 C41 44, 46 25, 49 28"
          stroke="#94a3b8"
          strokeOpacity="0.65"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M20 40 C26 32, 33 45, 40 34 C43 29, 46 37, 48 36"
          stroke="#fb7185"
          strokeOpacity="0.45"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </motion.g>
      {[
        { cx: 19, cy: 22, r: 1.8 },
        { cx: 45, cy: 20, r: 1.6 },
        { cx: 48, cy: 41, r: 1.9 },
        { cx: 17, cy: 43, r: 1.5 },
        { cx: 33, cy: 17, r: 1.4 },
      ].map((dot, i) => (
        <motion.circle
          key={i}
          cx={dot.cx}
          cy={dot.cy}
          r={dot.r}
          fill={i % 2 === 0 ? "#fda4af" : "#94a3b8"}
          fillOpacity="0.7"
          animate={reduced ? undefined : { opacity: [0.3, 0.85, 0.3], y: [-1.5, 1.5, -1.5] }}
          transition={{ duration: 1.6 + i * 0.25, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </svg>
  );
}

export function CharacterGlyph({ character, ...rest }: GlyphProps & { character: CharacterId }) {
  switch (character) {
    case "spark":
      return <SparkGlyph {...rest} />;
    case "link":
      return <LinkGlyph {...rest} />;
    case "prism":
      return <PrismGlyph {...rest} />;
    case "static":
      return <StaticGlyph {...rest} />;
  }
}

/** Compact geometric brand emblem for Ada's sidebar and auth headers. */
export function AdaMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden className="shrink-0">
      <polygon points="14,3 24,14 14,25 4,14" fill="#102a3d" stroke="#22d3ee" strokeWidth="1.5" />
      <polygon points="14,3 24,14 14,15" fill="#22d3ee" fillOpacity="0.35" />
      <polygon points="14,3 4,14 14,15" fill="#c4b5fd" fillOpacity="0.45" />
      <circle cx="14" cy="14" r="2.4" fill="#f8fafc" />
    </svg>
  );
}
