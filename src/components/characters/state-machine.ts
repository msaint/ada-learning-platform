import type { ActivityFeedback, LearnerActivity, SessionPhase, SessionSummary, SessionView } from "@/lib/schemas/dto";

export type CharacterId = "spark" | "link" | "prism" | "static";

export type CharacterMood = "idle" | "excited" | "thinking" | "guiding" | "soothing" | "celebrating" | "merging";

export type CharacterTrigger =
  | "cold_start"
  | "prediction"
  | "exploration"
  | "hesitation"
  | "consecutive_errors"
  | "difficulty_drop"
  | "struggle_recovery"
  | "hint_or_bridge"
  | "streak_mastery"
  | "checkpoint_passed"
  | "paused";

export interface CharacterMeta {
  id: CharacterId;
  name: string;
  role: string;
  tagline: string;
  accentHex: string;
}

export interface CharacterPresence {
  character: CharacterId;
  secondary?: CharacterId | null;
  mood: CharacterMood;
  line: string;
  trigger: CharacterTrigger;
  streak?: number;
}

export const CHARACTER_META: Record<CharacterId, CharacterMeta> = {
  spark: {
    id: "spark",
    name: "Spark",
    role: "Curiosity",
    tagline: "Turns wild guesses into data points.",
    accentHex: "#22d3ee",
  },
  link: {
    id: "link",
    name: "Link",
    role: "Connection",
    tagline: "Finds the hidden thread between ideas.",
    accentHex: "#f59e0b",
  },
  prism: {
    id: "prism",
    name: "Prism",
    role: "Synthesis",
    tagline: "Locks patterns into lasting architecture.",
    accentHex: "#c4b5fd",
  },
  static: {
    id: "static",
    name: "Static",
    role: "Friction",
    tagline: "Normalizes brain fog and slows the pace.",
    accentHex: "#fb7185",
  },
};

/**
 * Curated dialogue bank. Every line obeys the Synapse & Spark micro-copy rules:
 * strictly <= 120 characters, conversational, smart, and zero exclamation-point overload.
 */
export const CHARACTER_LINES: Record<CharacterTrigger, readonly string[]> = {
  cold_start: [
    "Ooh, messy. Let's poke at this idea and see what breaks.",
    "Blank canvas. Let's test your first instinct and see what sticks.",
    "New territory. Throw a hypothesis at the wall—mistakes are data.",
  ],
  prediction: [
    "Wild guess? Love it. Let's test it.",
    "No wrong moves here—a bold prediction gives us something to test.",
    "Trust your gut on this one. We'll check what actually happens.",
  ],
  exploration: [
    "Curious thread. Let's see where this leads.",
    "Every solid idea starts as a cluster of rough sketches.",
    "Good question to poke at. Keep pulling on the loose end.",
  ],
  hesitation: [
    "Brain fog detected. Totally normal—let's untangle this one piece at a time.",
    "Too many tabs open in your head? Let's zoom in.",
    "Stuck between thoughts? Grab a quick hint and lighten the load.",
  ],
  consecutive_errors: [
    "Friction means the concept is real. Let's break it into smaller pieces.",
    "Too much noise at once. Want a hint or a simpler stepping stone?",
    "Brain fog detected. Totally normal—let's untangle this one piece at a time.",
  ],
  difficulty_drop: [
    "Dialing back the noise. Let's build a clean foothold first.",
    "Smart call. Narrow the frame, lock the basics, then climb back up.",
  ],
  struggle_recovery: [
    "There's the snap. You untangled that and locked the thread in.",
    "From fog to signal. See how those two pieces just clicked together?",
    "Hold on—you pulled that right out of the noise. Solid recovery.",
  ],
  hint_or_bridge: [
    "Hold on—you already solved something like this earlier. See the thread?",
    "Pull those two ideas closer together.",
    "Look closely at the link between what you know and this case.",
  ],
  streak_mastery: [
    "Locked in. That concept is officially part of your architecture now.",
    "Clean execution. Ready to turn up the complexity?",
    "Sparks and threads aligned. You're moving in flow state now.",
  ],
  checkpoint_passed: [
    "Crystal clear. That idea is solidly wired in.",
    "Locked in. That concept is officially part of your architecture now.",
  ],
  paused: [
    "Holding your exact spot. Take a breather and jump back in anytime.",
  ],
};

export const HESITATION_THRESHOLD_MS = 15_000;
export const STREAK_PRISM_THRESHOLD = 3;
export const ERROR_STATIC_THRESHOLD = 2;

export interface SessionCharacterInput {
  status: SessionView["status"];
  kind: SessionView["kind"];
  phase: SessionPhase;
  position: number;
  difficultyOffset: number;
  activity: LearnerActivity | null;
  feedback: ActivityFeedback | null;
  summary: SessionSummary | null;
  hintsCount: number;
  altExplanationsCount: number;
  suggestBreakdown: boolean;
  /** Consecutive correct independent/assisted answers in this session. */
  streak: number;
  /** Consecutive incorrect or partial answers in this session. */
  consecutiveErrors: number;
  /** True when the user just answered correctly after hesitation or prior error(s). */
  recoveredFromStruggle: boolean;
  /** True when idle > 15s while awaiting a response. */
  hesitating: boolean;
}

function pick(trigger: CharacterTrigger, seed: number): string {
  const lines = CHARACTER_LINES[trigger];
  return lines[Math.abs(seed) % lines.length];
}

/**
 * Pure adaptive UX state machine mapping Ada's learning events to Synapse & Spark.
 */
export function resolveCharacterPresence(input: SessionCharacterInput): CharacterPresence {
  const seed = input.position + input.hintsCount + input.altExplanationsCount + input.streak;

  if (input.status === "paused") {
    return {
      character: "prism",
      mood: "idle",
      line: pick("paused", seed),
      trigger: "paused",
    };
  }

  // Completed session or checkpoint
  if (input.status === "completed") {
    const passedAssessment = input.summary?.assessment?.passed === true;
    const strongLesson = (input.summary?.assessed ?? 0) >= 2 && (input.summary?.correct ?? 0) >= Math.ceil((input.summary?.assessed ?? 0) * 0.75);
    if (passedAssessment || strongLesson || input.streak >= STREAK_PRISM_THRESHOLD) {
      return {
        character: "prism",
        secondary: "spark",
        mood: "celebrating",
        line: pick("checkpoint_passed", seed),
        trigger: "checkpoint_passed",
        streak: input.streak,
      };
    }
    if (input.summary?.assessment && !input.summary.assessment.passed) {
      return {
        character: "link",
        mood: "guiding",
        line: pick("hint_or_bridge", seed),
        trigger: "hint_or_bridge",
      };
    }
    return {
      character: "spark",
      mood: "excited",
      line: pick("exploration", seed),
      trigger: "exploration",
    };
  }

  const fb = input.feedback;
  const isFeedback = input.phase === "feedback" && fb?.status === "graded";

  // Trigger 4: 3+ Streak / Mastery Threshold Reached -> Spark + Link merge into Prism
  if ((isFeedback && fb.result === "correct" && input.streak >= STREAK_PRISM_THRESHOLD) || (!isFeedback && input.streak >= STREAK_PRISM_THRESHOLD && !input.hesitating)) {
    return {
      character: "prism",
      secondary: isFeedback ? "link" : null,
      mood: isFeedback ? "merging" : "celebrating",
      line: pick("streak_mastery", seed),
      trigger: "streak_mastery",
      streak: input.streak,
    };
  }

  // Trigger 3: Correct Answer after Struggle -> Static dissolves, Link snaps nodes together
  if (isFeedback && fb.result === "correct" && input.recoveredFromStruggle) {
    return {
      character: "link",
      mood: "celebrating",
      line: pick("struggle_recovery", seed),
      trigger: "struggle_recovery",
      streak: input.streak,
    };
  }

  // Trigger 2: 2+ Consecutive Errors or struggle breakdown suggestion -> Static + Link micro-hint
  if (
    input.consecutiveErrors >= ERROR_STATIC_THRESHOLD ||
    (isFeedback && (fb.result === "incorrect" || fb.result === "partial") && input.suggestBreakdown)
  ) {
    return {
      character: "static",
      secondary: "link",
      mood: "soothing",
      line: pick("consecutive_errors", seed),
      trigger: "consecutive_errors",
    };
  }

  // Trigger 2b: User Hesitation (>15s idle) while awaiting response -> Static drifts in + Link offers micro-hint
  if (input.phase === "awaiting_response" && input.hesitating) {
    return {
      character: "static",
      secondary: "link",
      mood: "soothing",
      line: pick("hesitation", seed),
      trigger: "hesitation",
    };
  }

  // Difficulty drop triggered by learner
  if (input.difficultyOffset < 0 && input.phase === "awaiting_response" && input.position > 1) {
    return {
      character: "static",
      secondary: "link",
      mood: "soothing",
      line: pick("difficulty_drop", seed),
      trigger: "difficulty_drop",
    };
  }

  // Link bridges concepts when hinting, explaining differently, probing, remediating, or on a single miss
  const purpose = input.activity?.purpose ?? "";
  if (
    input.hintsCount > 0 ||
    input.altExplanationsCount > 0 ||
    purpose === "probe" ||
    purpose === "remediate" ||
    purpose === "defend" ||
    purpose === "recall" ||
    purpose === "review" ||
    (isFeedback && (fb.result === "incorrect" || fb.result === "partial"))
  ) {
    return {
      character: "link",
      mood: "guiding",
      line: pick("hint_or_bridge", seed),
      trigger: "hint_or_bridge",
      streak: input.streak,
    };
  }

  // Trigger 1: Cold start or prediction -> Spark spawns in an energetic cluster
  if (purpose === "prediction") {
    return {
      character: "spark",
      mood: "excited",
      line: pick("prediction", seed),
      trigger: "prediction",
    };
  }

  if (input.position <= 1) {
    return {
      character: "spark",
      mood: "excited",
      line: pick("cold_start", seed),
      trigger: "cold_start",
    };
  }

  // Correct answer building toward a streak -> Link connecting
  if (isFeedback && fb.result === "correct") {
    return {
      character: "link",
      mood: "excited",
      line: pick("hint_or_bridge", seed),
      trigger: "hint_or_bridge",
      streak: input.streak,
    };
  }

  return {
    character: "spark",
    mood: "idle",
    line: pick("exploration", seed),
    trigger: "exploration",
    streak: input.streak,
  };
}
