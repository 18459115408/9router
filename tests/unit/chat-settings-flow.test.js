import { describe, expect, it, vi, beforeEach } from "vitest";

// The request path in src/sse/handlers/chat.js reads settings once in
// handleChat and reuses that read inside handleSingleModelChat's account
// loop. Both functions must hold a binding for it: the refactor that moved the
// read out of the loop left handleSingleModelChat referencing `settings` and
// `chatSettings` with neither in scope, and every /v1/* request came back as a
// ReferenceError 500. Only a real call catches that — nothing else in the
// suite executes this function.

const SETTINGS = {
  requireApiKey: false,
  providerThinking: { testprov: { mode: "off" } },
  ccFilterNaming: true,
  rtkEnabled: true,
  headroomEnabled: true,
  headroomUrl: "http://headroom.test/",
  headroomCompressUserMessages: true,
  headroomTimeoutMs: 4242,
  cavemanEnabled: true,
  cavemanLevel: "partial",
  ponytailEnabled: true,
  ponytailLevel: "some",
  pxpipeEnabled: false,
  pxpipeMinChars: 77,
  pxpipeTimeoutMs: 88,
};

let coreArgs = null;

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => SETTINGS),
}));
vi.mock("@/lib/headroom/detect", () => ({
  DEFAULT_HEADROOM_URL: "http://localhost:8787/",
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async () => ({
    connectionId: "conn-1",
    connectionName: "acc-1",
    accessToken: "token-1",
    providerSpecificData: {},
  })),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(async () => null),
  clearAntigravityStrikes: vi.fn(),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "testprov", model: "m1" })),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(async (args) => {
    coreArgs = args;
    return { success: true, response: new Response("core-ok", { status: 200 }) };
  }),
}));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn(async () => null),
}));

const { handleChat } = await import("@/sse/handlers/chat.js");
const { getSettings } = await import("@/lib/localDb");

function makeRequest(path, body) {
  return new Request(`http://router.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "test-agent/1.0" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  coreArgs = null;
  getSettings.mockClear();
});

describe("handleChat settings flow", () => {
  it("carries the settings read in handleChat into the account loop", async () => {
    const response = await handleChat(
      makeRequest("/v1/chat/completions", { model: "testprov/m1", messages: [{ role: "user", content: "hi" }] })
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("core-ok");

    // Every settings-derived argument reaches chatCore. A missing binding in
    // handleSingleModelChat throws before this call ever happens.
    expect(coreArgs).not.toBeNull();
    expect(coreArgs.modelInfo).toEqual({ provider: "testprov", model: "m1" });
    expect(coreArgs.body.model).toBe("testprov/m1");
    expect(coreArgs.connectionId).toBe("conn-1");
    expect(coreArgs.userAgent).toBe("test-agent/1.0");
    expect(coreArgs.providerThinking).toEqual({ mode: "off" });
    expect(coreArgs.ccFilterNaming).toBe(true);
    expect(coreArgs.rtkEnabled).toBe(true);
    expect(coreArgs.headroomEnabled).toBe(true);
    expect(coreArgs.headroomUrl).toBe("http://headroom.test/");
    expect(coreArgs.headroomCompressUserMessages).toBe(true);
    expect(coreArgs.headroomTimeoutMs).toBe(4242);
    expect(coreArgs.cavemanEnabled).toBe(true);
    expect(coreArgs.cavemanLevel).toBe("partial");
    expect(coreArgs.ponytailEnabled).toBe(true);
    expect(coreArgs.ponytailLevel).toBe("some");
    expect(coreArgs.pxpipeEnabled).toBe(false);
    expect(coreArgs.pxpipeMinChars).toBe(77);
    expect(coreArgs.pxpipeTimeoutMs).toBe(88);
  });

  it("reads settings once per request, not once per account fallback", async () => {
    await handleChat(
      makeRequest("/v1/messages", { model: "testprov/m1", messages: [{ role: "user", content: "hi" }] })
    );

    expect(getSettings).toHaveBeenCalledTimes(1);
  });

  it("still uses the same read to enforce requireApiKey", async () => {
    getSettings.mockImplementationOnce(async () => ({ ...SETTINGS, requireApiKey: true }));

    const response = await handleChat(
      makeRequest("/v1/chat/completions", { model: "testprov/m1", messages: [{ role: "user", content: "hi" }] })
    );

    expect(response.status).toBe(401);
    expect(coreArgs).toBeNull();
    expect(getSettings).toHaveBeenCalledTimes(1);
  });

  it("resolves every endpoint that funnels through handleChat", async () => {
    for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses"]) {
      coreArgs = null;
      const response = await handleChat(
        makeRequest(path, { model: "testprov/m1", messages: [{ role: "user", content: "hi" }] })
      );
      expect(response.status).toBe(200);
      expect(coreArgs).not.toBeNull();
    }
  });
});
