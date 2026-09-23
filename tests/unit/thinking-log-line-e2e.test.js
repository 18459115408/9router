import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCustomCapsSource } from "../../open-sse/providers/capabilities.js";

// End-to-end proof for the request line, driven through the real handleChatCore:
// a custom provider declares a thinking mapping whose field names match no
// format the gateway knows. Before this, the request went upstream with the
// right thinking params while the log line showed no THINK at all — the operator
// would read that as "my setting did nothing".

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", green: "", yellow: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const log = await import("../../src/sse/utils/logger.js");

// An openai-compatible node id, as the dashboard creates them.
const NODE = "openai-compatible-chat-logreport-e2e";
const MODEL = "my-private-model";

// What the ThinkingConfigEditor writes for an upstream that wants its own knob.
const DECLARED = {
  reasoning: true,
  thinkingFormat: "openai",
  thinkingLevels: ["low", "high"],
  thinkingMapping: {
    low: { my_own_knob: "low" },
    high: { my_own_knob: "high" },
  },
};

function declaredFor(provider, model) {
  return provider === NODE && model === MODEL ? DECLARED : null;
}

function makeOptions(overrides = {}) {
  return {
    body: {
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "low",
      stream: false,
    },
    modelInfo: { provider: NODE, model: MODEL },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { ...log, line: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "test-conn",
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: {},
      headers: { accept: "application/json" },
    },
    rtkEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    ...overrides,
  };
}

function requestLine(options) {
  const call = options.log.line.mock.calls.find(([, symbol]) => symbol === "▶");
  return call?.[2] || "";
}

beforeEach(() => {
  executeMock.mockReset();
  executeMock.mockResolvedValue({
    response: new Response(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }),
    url: "https://upstream.example.com/v1/chat/completions",
    headers: {},
    transformedBody: null,
  });
});

afterEach(() => setCustomCapsSource(null));

describe("request line for a declared thinking mapping", () => {
  it("names the level and the fields that went upstream", async () => {
    setCustomCapsSource({ getCaps: declaredFor });
    const options = makeOptions();

    await handleChatCore(options);

    expect(requestLine(options)).toContain('THINK:low (custom: my_own_knob="low")');
  });

  it("sends those exact fields upstream — the log matches the wire", async () => {
    setCustomCapsSource({ getCaps: declaredFor });
    const options = makeOptions();

    await handleChatCore(options);

    const sent = executeMock.mock.calls[0][0].body;
    expect(sent.my_own_knob).toBe("low");
    // The generic openai shape must NOT also run: the mapping replaces it.
    expect(sent.reasoning_effort).toBeUndefined();
  });

  it("reports the off switch as off, not as a raw mapping key", async () => {
    setCustomCapsSource({
      getCaps: () => ({ ...DECLARED, thinkingMapping: { disabled: { my_own_knob: "off" } } }),
    });
    const options = makeOptions();
    options.body.reasoning_effort = "none";

    await handleChatCore(options);

    expect(requestLine(options)).toContain('THINK:off (custom: my_own_knob="off")');
  });

  it("keeps reporting the built-in level when no mapping applies", async () => {
    // No declaration at all → the deepseek table drives it and the level is
    // readable off the body, so the line stays in its original short form.
    setCustomCapsSource({ getCaps: () => null });
    const options = makeOptions({
      body: { model: "deepseek-reasoner", messages: [{ role: "user", content: "hi" }], reasoning_effort: "low", stream: false },
      modelInfo: { provider: "deepseek", model: "deepseek-reasoner" },
    });

    await handleChatCore(options);

    // deepseek collapses low→high; the line reports what the upstream will see.
    expect(requestLine(options)).toContain("THINK:high");
    expect(requestLine(options)).not.toContain("custom:");
  });

  it("shows no THINK when the client never asked for thinking", async () => {
    setCustomCapsSource({ getCaps: declaredFor });
    const options = makeOptions();
    delete options.body.reasoning_effort;

    await handleChatCore(options);

    expect(requestLine(options)).not.toContain("THINK:");
  });
});
