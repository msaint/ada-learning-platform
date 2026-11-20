import { describe, expect, it } from "vitest";
import { LLMLearningModel, parseJsonObject, type JsonTransport } from "@/lib/ai/openai-model";
import { MockLearningModel, subjectOf } from "@/lib/ai/mock-model";
import { ModelError } from "@/lib/errors";
import { redact } from "@/lib/log";
import { remapRationaleLabels, shuffleChoices, toLearnerActivity } from "@/lib/services/sessions";
import { activityPrompt } from "@/lib/ai/prompts";
import type { ActivitySpec } from "@/lib/schemas/model";

process.env.ADA_SILENT_LOGS = "true";

const models = { clarify: "m-clarify", compile: "m-compile", tutor: "m-tutor", evaluate: "m-eval" };

function scripted(outputs: (string | Error)[]) {
  const calls: { model: string; user: string; maxTokens: number }[] = [];
  const transport: JsonTransport = {
    async complete(req) {
      calls.push(req);
      const next = outputs.shift();
      if (next === undefined) throw new Error("no more scripted outputs");
      if (next instanceof Error) throw next;
      return { text: next, inputTokens: 10, outputTokens: 5 };
    },
  };
  return { transport, calls };
}

const goodCurriculum = JSON.stringify({
  title: "Ball bearings in bicycles",
  direction: "Explore how ball bearings changed cycling.",
  concepts: [
    { slug: "friction", title: "Rolling vs sliding friction", description: "Why rolling wins.", assessment_criteria: ["Compare rolling and sliding friction"], importance: 3, prerequisites: [] },
    { slug: "races", title: "Cups, cones and races", description: "Parts of a bearing.", assessment_criteria: ["Name the parts"], importance: 2, prerequisites: ["friction"] },
    { slug: "history", title: "The 1869 shift", description: "Adoption history.", assessment_criteria: ["Explain the adoption"], importance: 2, prerequisites: ["races"] },
  ],
  first_concept_slug: "friction",
  suggested_minutes_weekly: 30,
  cadence_note: "Short sessions.",
  success_criteria: [],
});

const ctx = { topic: "history of ball bearings in bicycles", intent: "curiosity" as const, goalText: "Explore", depth: "standard", baseline: "", timeBudgetMinutesWeekly: null, successCriteria: [], assumptions: [] };

describe("LLM adapter", () => {
  it("parses valid structured output and reports usage", async () => {
    const { transport, calls } = scripted([goodCurriculum]);
    const m = new LLMLearningModel(transport, models, { timeoutMs: 1000 });
    const r = await m.compileCurriculum(ctx);
    expect(r.value.concepts).toHaveLength(3);
    expect(r.info).toMatchObject({ provider: "openai", model: "m-compile", repaired: false, inputTokens: 10 });
    expect(calls[0].user).toContain("JSON Schema");
    expect(calls[0].user).toContain('<learner_data name="topic">');
    // Static schema instructions precede dynamic learner data to maximise prefix-cache hits.
    expect(calls[0].user.indexOf("JSON Schema")).toBeLessThan(calls[0].user.indexOf('<learner_data name="topic">'));
  });

  it("repairs once after malformed JSON", async () => {
    const { transport, calls } = scripted(["not json", goodCurriculum]);
    const r = await new LLMLearningModel(transport, models, { timeoutMs: 1000 }).compileCurriculum(ctx);
    expect(r.info.repaired).toBe(true);
    expect(calls[1].user).toContain("previous output was invalid");
  });

  it("repairs a cyclic graph once, then fails cleanly", async () => {
    const cyclic = JSON.parse(goodCurriculum);
    cyclic.concepts[0].prerequisites = ["history"];
    const { transport, calls } = scripted([JSON.stringify(cyclic), JSON.stringify(cyclic)]);
    await expect(new LLMLearningModel(transport, models, { timeoutMs: 1000 }).compileCurriculum(ctx)).rejects.toMatchObject({ code: "model_invalid_output", retryable: true });
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain("cycle");
  });

  it("retries transient failures with backoff and then succeeds", async () => {
    const e429 = Object.assign(new Error("rate"), { status: 429 });
    const { transport, calls } = scripted([e429, Object.assign(new Error("boom"), { status: 503 }), goodCurriculum]);
    const r = await new LLMLearningModel(transport, models, { timeoutMs: 1000, retryBaseMs: 1 }).compileCurriculum(ctx);
    expect(r.value.title).toBe("Ball bearings in bicycles");
    expect(calls).toHaveLength(3);
  });

  it("maps timeouts to a retryable model_timeout without looping forever", async () => {
    const timeout = Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });
    const { transport, calls } = scripted([timeout, timeout, timeout, timeout]);
    const err = await new LLMLearningModel(transport, models, { timeoutMs: 10, retryBaseMs: 1, maxTransientRetries: 2 }).compileCurriculum(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.code).toBe("model_timeout");
    expect(calls).toHaveLength(3);
  });

  it("does not retry non-transient errors", async () => {
    const { transport, calls } = scripted([Object.assign(new Error("bad key"), { status: 401 })]);
    await expect(new LLMLearningModel(transport, models, { timeoutMs: 10 }).compileCurriculum(ctx)).rejects.toMatchObject({ code: "model_unavailable" });
    expect(calls).toHaveLength(1);
  });

  it("enforces the requested activity kind", async () => {
    const mc = JSON.stringify({ kind: "multiple_choice", promptMarkdown: "Q?", choices: [{ id: "a", text: "1" }, { id: "b", text: "2" }, { id: "c", text: "3" }], correctChoiceId: "a", rationale: "R", difficulty: 1 });
    const { transport } = scripted([mc, mc]);
    const m = new LLMLearningModel(transport, models, { timeoutMs: 10 });
    const concept = { slug: "x", title: "X", description: "", assessmentCriteria: ["c"], prerequisites: [] };
    await expect(
      m.generateActivity({ topic: "t", intent: "goal", goalText: "g", baseline: "", timeBudgetMinutesWeekly: null, concept, kind: "explanation", purpose: "teach", difficulty: 1, recentEvidence: [], misconceptions: [], priorPrompts: [], assistanceUsed: 0 }),
    ).rejects.toMatchObject({ code: "model_invalid_output" });
  });

  it("parses fenced JSON and rejects arrays", () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject("[1,2]")).toBeUndefined();
  });
});

describe("dev model", () => {
  it("is generic (no topic templates) and deterministic", async () => {
    const m = new MockLearningModel();
    const a = await m.compileCurriculum({ ...ctx, topic: "history of ball bearings in bicycles" });
    const b = await m.compileCurriculum({ ...ctx, topic: "history of ball bearings in bicycles" });
    expect(a.value).toEqual(b.value);
    expect(a.info.provider).toBe("mock");
    expect(a.value.title.toLowerCase()).toContain("ball bearings");
    expect(subjectOf("I want to learn Python to automate spreadsheet tasks")).toBe("Python to automate spreadsheet tasks");
  });
});

describe("activity DTO and shuffling", () => {
  const spec: ActivitySpec = {
    version: 1,
    conceptId: "c",
    kind: "multiple_choice",
    promptMarkdown: "Q",
    choices: [
      { id: "x", text: "one" },
      { id: "y", text: "two" },
      { id: "z", text: "three" },
    ],
    correctChoiceId: "y",
    reasoning: "private verification reasoning",
    rationale: "secret rationale",
    difficulty: 2,
  };
  it("relabels choices and keeps the answer mapped correctly", () => {
    const s = shuffleChoices(spec as Extract<ActivitySpec, { kind: "multiple_choice" }>, () => 0);
    expect(s.choices.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(s.choices.find((c) => c.id === s.correctChoiceId)!.text).toBe("two");
  });

  it("remaps option labels in rationale to match post-shuffle 1-based UI badges", () => {
    // Reproduces the exact PM chat-assistant bug: [a, b, c, d] rotated left by 1 -> [b, c, d, a]
    const pmSpec: Extract<ActivitySpec, { kind: "multiple_choice" }> = {
      version: 1,
      conceptId: "pm",
      kind: "multiple_choice",
      promptMarkdown: "Which of the following best describes what a Product Manager (PM) is primarily responsible for in the development of an AI chat assistant product?",
      choices: [
        { id: "a", text: "Designing the user interface and visual style of the chat assistant." },
        { id: "b", text: "Writing the code that implements the chat assistant’s natural language processing." },
        { id: "c", text: "Deciding which user problem to solve with the chat assistant and defining success metrics." },
        { id: "d", text: "Testing the chat assistant and fixing all the bugs found before launch." },
      ],
      correctChoiceId: "c",
      rationale:
        "Option c is correct because it correctly states the PM's ownership of deciding the user problem and defining success metrics. Options a and b are incorrect because design and engineering tasks are not the primary responsibility of PMs. Option d is incorrect because testing and bug fixing are typically engineering responsibilities, not PM responsibilities.",
      difficulty: 1,
    };
    // rand(() => 0) rotates [a, b, c, d] -> [b, c, d, a] (badges 1=b, 2=c, 3=d, 4=a)
    const shuffled = shuffleChoices(pmSpec, () => 0);
    expect(shuffled.choices.map((c) => c.text)).toEqual([
      "Writing the code that implements the chat assistant’s natural language processing.",
      "Deciding which user problem to solve with the chat assistant and defining success metrics.",
      "Testing the chat assistant and fixing all the bugs found before launch.",
      "Designing the user interface and visual style of the chat assistant.",
    ]);
    expect(shuffled.correctChoiceId).toBe("b"); // 2nd item = UI badge 2
    expect(shuffled.rationale).toBe(
      "Option 2 is correct because it correctly states the PM's ownership of deciding the user problem and defining success metrics. Options 4 and 1 are incorrect because design and engineering tasks are not the primary responsibility of PMs. Option 3 is incorrect because testing and bug fixing are typically engineering responsibilities, not PM responsibilities.",
    );

    // Even when shuffle is an identity permutation, letter references become 1-based UI badge numbers (1–4)
    const unmoved = shuffleChoices(pmSpec, (n) => n - 1);
    expect(unmoved.correctChoiceId).toBe("c");
    expect(unmoved.rationale).toContain("Option 3 is correct");
    expect(unmoved.rationale).toContain("Options 1 and 2 are incorrect");
    expect(unmoved.rationale).toContain("Option 4 is incorrect");
  });

  it("handles list/markdown formats and strips accidental choice prefixes without mangling ordinary English prose", () => {
    const labelMap = new Map([
      ["a", "4"],
      ["b", "1"],
      ["c", "2"],
      ["d", "3"],
    ]);
    expect(remapRationaleLabels("Choice **c** wins; choices (a), 'b', and \"d\" fail.", labelMap)).toBe("Choice **2** wins; choices 4, 1, and 3 fail.");
    expect(remapRationaleLabels("(c) is correct because it defines metrics; while option a confuses roles, option c's scope fits.", labelMap)).toBe(
      "(2) is correct because it defines metrics; while option 4 confuses roles, option 2's scope fits.",
    );
    // Ordinary English articles, verbs, inline sub-points, function calls, and scenario options must never be rewritten
    const prose =
      "A Product Manager owns a chat assistant's direction. This makes the second option a better fit than calling this choice a mistake or giving each answer a bonus. Answer a user's core problem first, and does not answer a vague request, for two reasons: (a) f(a) latency and (b) cost. Choosing Option c and a clear metric works.";
    expect(remapRationaleLabels(prose, labelMap)).toBe(
      "A Product Manager owns a chat assistant's direction. This makes the second option a better fit than calling this choice a mistake or giving each answer a bonus. Answer a user's core problem first, and does not answer a vague request, for two reasons: (a) f(a) latency and (b) cost. Choosing Option 2 and a clear metric works.",
    );
    expect(
      remapRationaleLabels("Option A has higher variance than Option B.", labelMap, "A team compares Option A (in-house) and Option B (vendor). Which metric matters?"),
    ).toBe("Option A has higher variance than Option B.");

    const prefixed: Extract<ActivitySpec, { kind: "multiple_choice" }> = {
      version: 1,
      conceptId: "c",
      kind: "multiple_choice",
      promptMarkdown: "Pick one",
      choices: [
        { id: "a", text: "A. First text" },
        { id: "b", text: "B. Second text" },
        { id: "c", text: "C. Third text" },
      ],
      correctChoiceId: "b",
      rationale: "Plain content-based rationale.",
      difficulty: 1,
    };
    const cleaned = shuffleChoices(prefixed, () => 0);
    expect(cleaned.choices.map((c) => c.text)).toEqual(["Second text", "Third text", "First text"]);
  });

  it("instructs multiple_choice prompts never to reference option letters or positions", () => {
    const p = activityPrompt({
      topic: "PM",
      intent: "goal",
      goalText: "Learn PM",
      baseline: "",
      timeBudgetMinutesWeekly: null,
      concept: { slug: "c", title: "C", description: "D", assessmentCriteria: ["A"], prerequisites: [] },
      kind: "multiple_choice",
      purpose: "check",
      difficulty: 1,
      recentEvidence: [],
      misconceptions: [],
      priorPrompts: [],
      assistanceUsed: 0,
    });
    expect(p).toMatch(/NEVER refer to choices by letter, number, or position/);
  });

  it("learner DTO never contains teacher-only fields", () => {
    const dto = toLearnerActivity({ id: "1", purpose: "check", spec_json: spec }, "C");
    expect(JSON.stringify(dto)).not.toMatch(/correctChoiceId|secret rationale|private verification reasoning|reasoning/);
    const fr = toLearnerActivity({ id: "2", purpose: "apply", spec_json: { version: 1, conceptId: "c", kind: "free_response", promptMarkdown: "Explain", rubric: [{ criterion: "hidden crit", importance: 1 }], idealAnswerPrivate: "hidden ideal", difficulty: 2 } }, "C");
    expect(JSON.stringify(fr)).not.toMatch(/hidden/);
  });
});

describe("log redaction", () => {
  it("redacts emails, secrets and answer text", () => {
    const out = JSON.stringify(redact({ email: "a@b.co", note: "contact a@b.co with sk-abcdefghijklmnop", answerText: "my private answer" }));
    expect(out).not.toMatch(/a@b\.co|sk-abc|private answer/);
  });
});
