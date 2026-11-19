// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CHARACTER_LINES,
  ERROR_STATIC_THRESHOLD,
  HESITATION_THRESHOLD_MS,
  STREAK_PRISM_THRESHOLD,
  resolveCharacterPresence,
  type SessionCharacterInput,
} from "@/components/characters/state-machine";
import { CharacterCastShowcase, CharacterCompanion } from "@/components/characters/character-companion";

afterEach(cleanup);

function baseInput(overrides: Partial<SessionCharacterInput> = {}): SessionCharacterInput {
  return {
    status: "active",
    kind: "lesson",
    phase: "awaiting_response",
    position: 1,
    difficultyOffset: 0,
    activity: {
      id: "act-1",
      kind: "multiple_choice",
      purpose: "check",
      conceptTitle: "Eigenvalues",
      promptMarkdown: "Which statement holds?",
      choices: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      difficulty: 2,
    },
    feedback: null,
    summary: null,
    hintsCount: 0,
    altExplanationsCount: 0,
    suggestBreakdown: false,
    streak: 0,
    consecutiveErrors: 0,
    recoveredFromStruggle: false,
    hesitating: false,
    ...overrides,
  };
}

describe("Synapse & Spark state machine", () => {
  it("Trigger 1: spawns Spark on a new lesson / cold start or prediction", () => {
    const coldStart = resolveCharacterPresence(baseInput({ position: 1 }));
    expect(coldStart.character).toBe("spark");
    expect(coldStart.trigger).toBe("cold_start");

    const prediction = resolveCharacterPresence(
      baseInput({
        position: 2,
        activity: {
          id: "act-2",
          kind: "free_response",
          purpose: "prediction",
          conceptTitle: "Tapered wheels",
          promptMarkdown: "What happens on a curve?",
          difficulty: 1,
        },
      }),
    );
    expect(prediction.character).toBe("spark");
    expect(prediction.trigger).toBe("prediction");
  });

  it("Trigger 2: drifts Static in with Link on hesitation (>15s) or 2+ consecutive errors", () => {
    expect(HESITATION_THRESHOLD_MS).toBe(15_000);
    expect(ERROR_STATIC_THRESHOLD).toBe(2);

    const hesitant = resolveCharacterPresence(baseInput({ position: 3, hesitating: true }));
    expect(hesitant.character).toBe("static");
    expect(hesitant.secondary).toBe("link");
    expect(hesitant.trigger).toBe("hesitation");

    const errors = resolveCharacterPresence(baseInput({ position: 3, consecutiveErrors: 2 }));
    expect(errors.character).toBe("static");
    expect(errors.secondary).toBe("link");
    expect(errors.trigger).toBe("consecutive_errors");
  });

  it("Trigger 3: dissolves Static and snaps Link in on correct answer after struggle", () => {
    const recovery = resolveCharacterPresence(
      baseInput({
        position: 4,
        phase: "feedback",
        streak: 1,
        consecutiveErrors: 0,
        recoveredFromStruggle: true,
        feedback: {
          status: "graded",
          result: "correct",
          independence: "independent",
          feedbackMarkdown: "Nice.",
        },
      }),
    );
    expect(recovery.character).toBe("link");
    expect(recovery.trigger).toBe("struggle_recovery");
    expect(recovery.mood).toBe("celebrating");
  });

  it("Trigger 4: merges Spark and Link into Prism at 3+ streak or mastery checkpoint", () => {
    expect(STREAK_PRISM_THRESHOLD).toBe(3);

    const streakHit = resolveCharacterPresence(
      baseInput({
        position: 5,
        phase: "feedback",
        streak: 3,
        feedback: {
          status: "graded",
          result: "correct",
          independence: "independent",
          feedbackMarkdown: "Spot on.",
        },
      }),
    );
    expect(streakHit.character).toBe("prism");
    expect(streakHit.mood).toBe("merging");
    expect(streakHit.trigger).toBe("streak_mastery");

    const passedFinal = resolveCharacterPresence(
      baseInput({
        status: "completed",
        kind: "assessment",
        summary: {
          reason: "assessment_done",
          assessed: 4,
          correct: 4,
          conceptsTouched: ["A", "B"],
          assessment: { passed: true, missed: [] },
        },
      }),
    );
    expect(passedFinal.character).toBe("prism");
    expect(passedFinal.trigger).toBe("checkpoint_passed");
  });

  it("enforces micro-copy constraints (<= 120 chars and no exclamation-point overload)", () => {
    for (const [trigger, lines] of Object.entries(CHARACTER_LINES)) {
      expect(lines.length, `trigger ${trigger} has lines`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.length, `line too long (${line.length}): ${line}`).toBeLessThanOrEqual(120);
        const exclamations = (line.match(/!/g) ?? []).length;
        expect(exclamations, `exclamation overload: ${line}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("CharacterCompanion & CharacterCastShowcase", () => {
  it("renders companion speech bubble and triggers contextual quick action", async () => {
    const onAction = vi.fn();
    render(
      <CharacterCompanion
        presence={{
          character: "static",
          secondary: "link",
          mood: "soothing",
          trigger: "hesitation",
          line: "Too many tabs open in your head? Let's zoom in.",
        }}
        action={{ label: "Quick hint", onClick: onAction }}
      />,
    );
    expect(screen.getByText("Static")).toBeTruthy();
    expect(screen.getByText(/Too many tabs open/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Quick hint" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("lets learners switch between Spark, Link, Prism, and Static on the home showcase", async () => {
    render(<CharacterCastShowcase />);
    expect(screen.getByRole("tab", { name: "Spark", selected: true })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Prism" }));
    expect(screen.getByRole("tab", { name: "Prism", selected: true })).toBeTruthy();
    expect(screen.getByText(/officially part of your architecture/i)).toBeTruthy();
  });
});
