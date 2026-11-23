// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityView } from "@/components/lesson/activity-renderer";
import { FeedbackPanel } from "@/components/lesson/feedback";
import { LessonPlayer } from "@/components/lesson/lesson-player";
import { CourseHeaderBar } from "@/components/course/course-header";
import { NewCoursePrompt } from "@/components/course/new-course-prompt";
import { CourseSetup } from "@/components/course/course-setup";
import { OutlineList } from "@/components/course/outline-list";
import { ReviewQueue } from "@/components/course/review-queue";
import { Markdown } from "@/components/ui/markdown";

const mockPush = vi.fn();
const mockRefresh = vi.fn();
const stableRouter = { push: mockPush, refresh: mockRefresh };

vi.mock("next/navigation", () => ({
  useRouter: () => stableRouter,
  usePathname: () => "/app/courses/c1",
}));

afterEach(() => {
  cleanup();
  mockPush.mockReset();
  mockRefresh.mockReset();
  vi.restoreAllMocks();
});

const mc = { id: "a1", kind: "multiple_choice" as const, purpose: "check", conceptTitle: "C", promptMarkdown: "Which **one**?", choices: [{ id: "a", text: "Alpha" }, { id: "b", text: "Beta" }, { id: "c", text: "Gamma" }], difficulty: 1 };

describe("ActivityView", () => {
  it("renders multiple choice as an accessible radio group and reports the choice", async () => {
    const onChoice = vi.fn();
    render(<ActivityView activity={mc} onChoice={onChoice} text="" onText={() => {}} onSubmitShortcut={() => {}} disabled={false} feedback={null} altExplanations={[]} hints={[]} />);
    const group = screen.getByRole("radiogroup", { name: /Which one\?/ });
    expect(group).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "Beta" }));
    expect(onChoice).toHaveBeenCalledWith("b");
  });

  it("marks choice cards data-disabled when answered so tactile hover motion is suppressed", () => {
    const { container } = render(
      <ActivityView
        activity={mc}
        choice="b"
        onChoice={() => {}}
        text=""
        onText={() => {}}
        onSubmitShortcut={() => {}}
        disabled={true}
        feedback={{ status: "graded", result: "correct", independence: "independent", feedbackMarkdown: "That's right.", correctChoiceId: "b", chosenChoiceId: "b" }}
        altExplanations={[]}
        hints={[]}
      />,
    );
    const labels = [...container.querySelectorAll("label.choice-card-tactile")];
    expect(labels).toHaveLength(3);
    expect(labels.every((l) => l.getAttribute("data-disabled") === "true")).toBe(true);
  });

  it("Enter submits a free response, Shift+Enter does not", async () => {
    const submit = vi.fn();
    const fr = { id: "f1", kind: "free_response" as const, purpose: "apply", conceptTitle: "C", promptMarkdown: "Explain", difficulty: 2 };
    render(<ActivityView activity={fr} onChoice={() => {}} text="hi" onText={() => {}} onSubmitShortcut={submit} disabled={false} feedback={null} altExplanations={[]} hints={[]} />);
    const box = screen.getByLabelText("Your answer");
    box.focus();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(submit).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe("FeedbackPanel", () => {
  it("labels assisted answers and lists criteria", () => {
    render(
      <FeedbackPanel
        activityKind="free_response"
        feedback={{ status: "graded", result: "partial", independence: "assisted", feedbackMarkdown: "Close.", criteria: [{ criterion: "Names the cause", met: "partly", reason: "vague" }], exampleAnswer: "Because…" }}
      />,
    );
    expect(screen.getByText("Partly there")).toBeTruthy();
    expect(screen.getByText("(with help)")).toBeTruthy();
    expect(screen.getByText(/Names the cause/)).toBeTruthy();
  });

  it("offers a quiet grading flag on non-correct free responses and confirms once flagged", async () => {
    const onFlag = vi.fn();
    const { rerender } = render(
      <FeedbackPanel
        activityKind="free_response"
        onFlag={onFlag}
        feedback={{ status: "graded", result: "incorrect", independence: "independent", feedbackMarkdown: "Missing the second step." }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "That felt misgraded" }));
    expect(onFlag).toHaveBeenCalledTimes(1);
    rerender(
      <FeedbackPanel
        activityKind="free_response"
        onFlag={onFlag}
        feedback={{ status: "graded", result: "incorrect", independence: "independent", feedbackMarkdown: "Missing the second step.", flagged: true }}
      />,
    );
    expect(screen.getByText("Thanks — flagged for review.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "That felt misgraded" })).toBeNull();
  });
});

describe("Markdown", () => {
  it("drops raw HTML, scripts, images and javascript: links", () => {
    const { container } = render(<Markdown>{'Hi <script>alert(1)</script> <img src=x onerror=alert(1)> ![x](http://e.com/a.png) [bad](javascript:alert(1)) [ok](https://example.com)'}</Markdown>);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com"]);
    expect(links[0].getAttribute("rel")).toContain("noopener");
  });

  it("renders LaTeX math with KaTeX and highlights fenced code blocks safely", () => {
    const sample = "Formula: $E = mc^2$\n\n```ts\nconst answer = 42;\n```";
    const { container } = render(<Markdown>{sample}</Markdown>);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector("pre code.hljs")).not.toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("LessonPlayer & CourseHeaderBar", () => {
  it("supports keyboard-only MC flow (number key to pick + Enter to check) and honest step pacing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/draft")) {
        return new Response(JSON.stringify({ version: 1 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({
          session: {
            id: "s1",
            courseId: "c1",
            kind: "review",
            status: "active",
            difficultyOffset: 0,
            phase: "feedback",
            position: 1,
            targetSteps: 2,
            activity: mc,
            draft: null,
            hints: [],
            altExplanations: [],
            feedback: { status: "graded", result: "correct", independence: "independent", feedbackMarkdown: "That's right.", correctChoiceId: "b", chosenChoiceId: "b" },
            summary: null,
            devModel: true,
            aiGenerated: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    render(
      <LessonPlayer
        courseId="c1"
        intent="goal"
        autoStart={null}
        nextAction={{ kind: "review", label: "Start review" }}
        initialSession={{
          id: "s1",
          courseId: "c1",
          kind: "review",
          status: "active",
          difficultyOffset: 0,
          phase: "awaiting_response",
          position: 1,
          targetSteps: 2,
          activity: mc,
          draft: null,
          hints: ["Consider Beta"],
          altExplanations: [],
          feedback: null,
          summary: null,
          devModel: true,
          aiGenerated: true,
        }}
      />,
    );

    expect(screen.getByText(/Review · 1 of 2 · C/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hint (1/3)" })).toBeTruthy();

    await userEvent.keyboard("2");
    expect((screen.getByRole("radio", { name: "Beta" }) as HTMLInputElement).checked).toBe(true);
    await userEvent.keyboard("{Enter}");

    const attemptCall = fetchSpy.mock.calls.find(([u]) => String(u).includes("/attempts"));
    expect(attemptCall).toBeTruthy();
  });

  it("renders unboxed course mastery summary and due review link in CourseHeaderBar", () => {
    render(
      <CourseHeaderBar
        header={{
          id: "c1",
          title: "Bicycle Bearings",
          topic: "ball bearings",
          intent: "goal",
          status: "active",
          version: 1,
          goal: { version: 1, text: "Overhaul a hub", successCriteria: [], timeBudgetMinutesWeekly: 30, createdAt: "2026-01-01T00:00:00Z" },
          goalHistory: [],
          nextAction: { kind: "learn", label: "Continue" },
          openSession: null,
          reviewDueCount: 2,
          conceptSummary: { total: 5, demonstrated: 2, developing: 1 },
        }}
      />,
    );
    expect(screen.getByText("2 of 5 concepts demonstrated")).toBeTruthy();
    expect(screen.getByRole("link", { name: "2 reviews due" }).getAttribute("href")).toBe("/app/courses/c1?kind=review");
  });
});

describe("NewCoursePrompt & CourseSetup", () => {
  it("populates the topic textarea when clicking an example starter button without auto-submitting", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<NewCoursePrompt needsSession={false} />);

    expect(screen.getByText(/paste a link \(job post, syllabus, article\)/i)).toBeTruthy();
    const starterBtn = screen.getByRole("button", { name: "SQL window functions" });
    await userEvent.click(starterBtn);

    const textarea = screen.getByLabelText("What would you like to learn?") as HTMLTextAreaElement;
    expect(textarea.value).toContain("SQL window functions");
    expect(starterBtn.getAttribute("aria-pressed")).toBe("true");
    // Does not auto-submit so guests never burn their 1-course slot accidentally
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows clarifying step progress, pairs Q&A turns, and answers on number key press", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          draft: {
            id: "d1",
            topic: "Orbital mechanics",
            version: 3,
            turns: [],
            state: "collecting",
            canGoBack: true,
            sourcesRead: [],
            background: null,
            devModel: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    render(
      <CourseSetup
        initial={{
          id: "d1",
          topic: "Orbital mechanics",
          version: 2,
          turns: [
            { role: "learner", text: "Orbital mechanics" },
            { role: "ada", text: "What draws you to this?" },
            { role: "learner", text: "Planning Kerbal transfers" },
          ],
          state: "collecting",
          nextQuestion: {
            text: "How much calculus would you like?",
            options: ["Conceptual only", "Full derivations"],
            field: "depth",
            step: 2,
            maxSteps: 4,
          },
          canGoBack: true,
          sourcesRead: [
            { url: "https://example.com/orbit", title: "Orbit Guide" },
            { url: "javascript:alert(1)", title: "Unsafe" },
          ],
          background: null,
          devModel: true,
        }}
      />,
    );

    expect(screen.getByText("Question 2 of up to 4")).toBeTruthy();
    expect(screen.getByText("What draws you to this?")).toBeTruthy();
    expect(screen.getByText("Planning Kerbal transfers")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Orbit Guide" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();

    await userEvent.keyboard("2");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({ answer: "Full derivations", expectedVersion: 2 });
  });

  it("renders rich concept descriptions on the proposal card and forwards an inline renamed title on convert", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ courseId: "c-new", created: true }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    render(
      <CourseSetup
        initial={{
          id: "d2",
          topic: "SQL window functions",
          version: 4,
          turns: [{ role: "learner", text: "SQL window functions" }],
          state: "ready",
          canGoBack: true,
          sourcesRead: [],
          background: null,
          devModel: false,
          proposal: {
            title: "Generated Window Functions Course",
            direction: "Start with partitions, then build up to sliding frames.",
            intent: "goal",
            goalText: "Write analytics queries fluently",
            initialConceptTitles: ["OVER and PARTITION BY", "Sliding Frames"],
            initialConcepts: [
              {
                slug: "partitions",
                title: "OVER and PARTITION BY",
                description: "Aggregate across groups while keeping individual detail rows.",
                prerequisiteTitles: [],
                isFirst: true,
              },
              {
                slug: "frames",
                title: "Sliding Frames",
                description: "Bound moving windows with ROWS and RANGE.",
                prerequisiteTitles: ["OVER and PARTITION BY"],
                isFirst: false,
              },
            ],
            suggestedMinutesWeekly: 45,
            cadenceNote: "Two focused sessions per week.",
            assumptions: ["Basic SELECT and GROUP BY"],
            successCriteria: ["Solve rolling-metric queries without hints"],
          },
        }}
      />,
    );

    expect(screen.getByText("Aggregate across groups while keeping individual detail rows.")).toBeTruthy();
    expect(screen.getByText(/Starts here/)).toBeTruthy();
    expect(screen.getByText("Builds on OVER and PARTITION BY")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Edit course title" }));
    const titleInput = screen.getByLabelText("Course title");
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Analytics SQL Mastery");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.getByRole("heading", { name: "Analytics SQL Mastery" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Start course" }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/course-drafts/d2/convert");
    expect(JSON.parse(String(init?.body))).toEqual({ title: "Analytics SQL Mastery" });
  });
});

describe("OutlineList, ReviewQueue & Mid-Lesson Branching", () => {
  it("filters outline concepts, shows unlock/note metadata, drops unsafe note links, and routes review_due concepts to focused review", async () => {
    render(
      <OutlineList
        outline={{
          courseId: "c1",
          curriculumVersion: 2,
          revisionNote: "Added branch",
          concepts: [
            {
              id: "k1",
              slug: "wheel-conicity",
              title: "Wheel Conicity",
              description: "How conical treads self-center on straight track.",
              criteria: ["Explain radius differential"],
              status: "review_due",
              depth: 0,
              prerequisiteTitles: [],
              unmetPrerequisiteTitles: [],
              unlocksTitles: ["Hunting Oscillation"],
              relatedTitles: [],
              struggling: false,
              origin: "initial",
              inCurrentPlan: true,
              notes: [
                {
                  id: "n1",
                  title: "Core Geometry",
                  bodyMarkdown: "Coned wheels shift rolling radius.",
                  altExplanations: [],
                  sources: [
                    { url: "https://example.com/rail", title: "Rail Kinematics" },
                    { url: "javascript:alert(1)", title: "Bad Source" },
                  ],
                  at: "2026-03-01T00:00:00Z",
                },
              ],
              evidence: [],
            },
            {
              id: "k2",
              slug: "hunting-oscillation",
              title: "Hunting Oscillation",
              description: "Kinematic sinusoidal sway above critical speed.",
              criteria: [],
              status: "not_assessed",
              depth: 1,
              prerequisiteTitles: ["Wheel Conicity"],
              unmetPrerequisiteTitles: ["Wheel Conicity"],
              unlocksTitles: [],
              relatedTitles: [],
              struggling: false,
              origin: "branch",
              inCurrentPlan: true,
              notes: [],
              evidence: [],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText(/1 saved note/)).toBeTruthy();
    expect(screen.getByText(/Curiosity branch · After Wheel Conicity/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Needs work (1)" }));
    expect(screen.getByText("Wheel Conicity")).toBeTruthy();
    expect(screen.queryByText("Hunting Oscillation")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Wheel Conicity/ }));
    expect(screen.getByRole("link", { name: "Rail Kinematics" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Bad Source" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Review this" }));
    expect(mockPush).toHaveBeenCalledWith("/app/courses/c1?kind=review&focus=k1");
  });

  it("supports 3-day snoozing with optimistic removal and surfaces errors in ReviewQueue", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "internal", message: "Temporary outage", retryable: true } }), { status: 500, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "r1", dueAt: "2026-03-13T00:00:00Z" }), { status: 200, headers: { "content-type": "application/json" } }));

    render(
      <ReviewQueue
        due={[
          {
            id: "r1",
            courseId: "c1",
            courseTitle: "SQL Analytics",
            conceptId: "k1",
            conceptTitle: "PARTITION BY",
            dueAt: "2026-03-07T00:00:00Z",
            dueLabel: "Overdue · 3d",
            overdue: true,
          },
        ]}
        upcoming={[]}
      />,
    );

    expect(screen.getByText(/1 concept due · 1 overdue/)).toBeTruthy();
    expect(screen.getByText(/Overdue · 3d/)).toBeTruthy();

    // First attempt fails -> error is surfaced instead of swallowed
    await userEvent.click(screen.getByRole("button", { name: "3 days" }));
    expect(screen.getByRole("alert").textContent).toContain("Temporary outage");

    // Retry succeeds -> optimistically transitions to caught-up state
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchSpy.mock.calls[1];
    expect(JSON.parse(String(secondInit?.body))).toEqual({ days: 3 });
    expect(screen.getByText(/You're all caught up on reviews/)).toBeTruthy();
  });

  it("lets learners open a side-question detour right from an explanation in LessonPlayer", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/branches")) {
        return new Response(JSON.stringify({ firstConceptId: "branch-c1", conceptIds: ["branch-c1"], explanation: "Added detour" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          session: {
            id: "s2",
            courseId: "c1",
            kind: "lesson",
            status: "active",
            difficultyOffset: 0,
            phase: "awaiting_response",
            position: 1,
            targetSteps: 8,
            activity: {
              id: "act-b1",
              kind: "explanation",
              purpose: "teach",
              conceptTitle: "High-Speed Hunting Sway",
              bodyMarkdown: "At higher speeds, inertia overshoots the equilibrium line.",
            },
            draft: null,
            hints: [],
            altExplanations: [],
            feedback: null,
            summary: null,
            devModel: true,
            aiGenerated: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    render(
      <LessonPlayer
        courseId="c1"
        intent="goal"
        autoStart={null}
        nextAction={{ kind: "learn", label: "Continue" }}
        initialSession={{
          id: "s1",
          courseId: "c1",
          kind: "lesson",
          status: "active",
          difficultyOffset: 0,
          phase: "awaiting_response",
          position: 2,
          targetSteps: 8,
          activity: {
            id: "act-1",
            kind: "explanation",
            purpose: "teach",
            conceptTitle: "Tapered Treads",
            bodyMarkdown: "A tapered wheel shifts effective radius on curves.",
          },
          draft: null,
          hints: [],
          altExplanations: [],
          feedback: null,
          summary: null,
          devModel: true,
          aiGenerated: true,
        }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Ask a side question/ }));
    const detourInput = screen.getByLabelText("What side question should Ada add as a branch?");
    await userEvent.type(detourInput, "Why does hunting oscillation appear at high speed?");
    await userEvent.click(screen.getByRole("button", { name: "Branch into this" }));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/courses/c1/branches");
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toEqual({ kind: "lesson", focusConceptId: "branch-c1" });
    expect(screen.getByText(/High-Speed Hunting Sway/)).toBeTruthy();
  });
});

describe("Fast Multi-Stage Course Creation", () => {
  it("creates a deferred draft on submit and navigates immediately to /app/new", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ draft: { id: "d-fast" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    render(<NewCoursePrompt />);
    const textarea = screen.getByLabelText("What would you like to learn?");
    await userEvent.type(textarea, "Distributed caching with Redis");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/course-drafts");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      topic: "Distributed caching with Redis",
      deferAdvance: true,
    });
    expect(mockPush).toHaveBeenCalledWith("/app/new?draft=d-fast");
  });

  it("auto-progresses from understanding to compiling with personalized goal reveal before reaching ready", async () => {
    let resolveCompile!: (res: Response) => void;
    const compileGate = new Promise<Response>((resolve) => {
      resolveCompile = resolve;
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            draft: {
              id: "d-stage",
              topic: "Distributed caching with Redis",
              version: 2,
              turns: [{ role: "learner", text: "Distributed caching with Redis" }],
              state: "collecting",
              stage: "compiling",
              interpretation: {
                intent: "goal",
                goalText: "Design cache invalidation and stampede protection in production",
                assumptions: ["Comfortable with HTTP services", "Knows basic key-value lookups"],
              },
              canGoBack: false,
              sourcesRead: [],
              background: null,
              devModel: true,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockImplementationOnce(() => compileGate);

    render(
      <CourseSetup
        initial={{
          id: "d-stage",
          topic: "Distributed caching with Redis",
          version: 1,
          turns: [{ role: "learner", text: "Distributed caching with Redis" }],
          state: "collecting",
          stage: "understanding",
          canGoBack: false,
          sourcesRead: [],
          background: null,
          devModel: true,
        }}
      />,
    );

    // Stage 1 fires automatically with stepOnly: true, then Stage 2 begins while revealing the personalized interpretation
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      expectedVersion: 1,
      stepOnly: true,
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toEqual({
      expectedVersion: 2,
    });

    expect(screen.getByText("Building your starting path…")).toBeTruthy();
    expect(screen.getByText(/Design cache invalidation and stampede protection in production/)).toBeTruthy();
    expect(screen.getByText(/Comfortable with HTTP services · Knows basic key-value lookups/)).toBeTruthy();
    expect(screen.getByText("Map concepts and prerequisite order")).toBeTruthy();

    resolveCompile(
      new Response(
        JSON.stringify({
          draft: {
            id: "d-stage",
            topic: "Distributed caching with Redis",
            version: 3,
            turns: [{ role: "learner", text: "Distributed caching with Redis" }],
            state: "ready",
            stage: "ready",
            canGoBack: false,
            sourcesRead: [],
            background: null,
            devModel: true,
            proposal: {
              title: "Production Redis Caching",
              direction: "Move from TTL fundamentals to stampede-safe read-through patterns.",
              intent: "goal",
              goalText: "Design cache invalidation and stampede protection in production",
              initialConceptTitles: ["Cache-Aside & TTLs", "Stampede Locking"],
              initialConcepts: [
                {
                  slug: "cache-aside",
                  title: "Cache-Aside & TTLs",
                  description: "Coordinate application reads and explicit invalidations.",
                  prerequisiteTitles: [],
                  isFirst: true,
                },
              ],
              suggestedMinutesWeekly: 45,
              cadenceNote: "Two focused sessions a week.",
              assumptions: ["Comfortable with HTTP services"],
              successCriteria: ["Prevent thundering herds under cold-cache load"],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Production Redis Caching" })).toBeTruthy();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("halts automatic setup progression on a retryable failure instead of looping", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: "ai_unavailable", message: "Model timed out", retryable: true },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    );

    render(
      <CourseSetup
        initial={{
          id: "d-err",
          topic: "Compiler design",
          version: 1,
          turns: [{ role: "learner", text: "Compiler design" }],
          state: "collecting",
          stage: "understanding",
          canGoBack: false,
          sourcesRead: [],
          background: null,
          devModel: false,
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Model timed out");
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});



