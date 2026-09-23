import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { extractRequestConfig } = await import("../../open-sse/handlers/chatCore/requestDetail.js");

// The stored `request` is what the details drawer renders. It must keep every
// thinking field a client can send, or the drawer shows a request that looks
// like it never asked for reasoning at all.
describe("request detail keeps the client's thinking fields", () => {
  it("keeps OpenAI's reasoning_effort", () => {
    const config = extractRequestConfig({ model: "m", messages: [], reasoning_effort: "low" }, true);
    expect(config.reasoning_effort).toBe("low");
  });

  it("keeps Claude's output_config effort", () => {
    const config = extractRequestConfig({ model: "m", messages: [], output_config: { effort: "high" } }, true);
    expect(config.output_config).toEqual({ effort: "high" });
  });

  it("keeps Gemini's generationConfig.thinkingConfig", () => {
    const generationConfig = { thinkingConfig: { thinkingLevel: "medium" } };
    const config = extractRequestConfig({ model: "m", contents: [], generationConfig }, true);
    expect(config.generationConfig).toEqual(generationConfig);
  });

  it("keeps the shapes it already kept", () => {
    const body = {
      model: "m",
      messages: [],
      thinking: { type: "enabled", budget_tokens: 4096 },
      reasoning: { effort: "high" },
      enable_thinking: true,
      thinking_budget: 2048,
    };
    const config = extractRequestConfig(body, false);
    expect(config.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(config.reasoning).toEqual({ effort: "high" });
    expect(config.enable_thinking).toBe(true);
    expect(config.thinking_budget).toBe(2048);
  });

  it("still omits absent params instead of storing undefined", () => {
    const config = extractRequestConfig({ model: "m", messages: [] }, true);
    expect(Object.keys(config)).toEqual(["messages", "model", "stream"]);
  });
});

// The save sites read the request config at the END of the request, but
// translateRequest rewrites the body in place first (stripAll() deletes the
// thinking fields). A snapshot taken before translation is therefore the only
// way the drawer can show what the client asked for.
describe("client request config survives translation", () => {
  it("keeps top-level thinking params that translation strips from the body", async () => {
    const { translateRequest } = await import("../../open-sse/translator/index.js");
    const { extractRequestConfig: extract } = await import("../../open-sse/handlers/chatCore/requestDetail.js");

    const body = {
      model: "deepseek-reasoner",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "low",
      thinking: { type: "enabled", budget_tokens: 4096 },
    };

    const snapshot = extract(body, false);        // taken before translation
    translateRequest("openai", "openai", "deepseek-reasoner", body, false, null, "deepseek");

    // The live body has been rewritten...
    expect(body.reasoning_effort).toBe("high");
    // ...but the snapshot still reports what the client sent.
    expect(snapshot.reasoning_effort).toBe("low");
    expect(snapshot.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });
});
