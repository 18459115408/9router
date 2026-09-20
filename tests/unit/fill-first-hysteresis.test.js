import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateProviderConnection: vi.fn(),
}));

// Two connections, A ahead of B in priority — mirrors the log's ACC order.
const store = [
  { id: "a", name: "accA", priority: 1, isActive: true, authType: "apikey", apiKey: "ka" },
  { id: "b", name: "accB", priority: 2, isActive: true, authType: "apikey", apiKey: "kb" },
];

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () =>
    [...store].sort((x, y) => (x.priority || 999) - (y.priority || 999)).map(c => ({ ...c }))
  ),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection.mockImplementation(async (id, patch) => {
    Object.assign(store.find(c => c.id === id), patch);
  }),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (p) => p,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
}));

const { getProviderCredentials, markAccountUnavailable } = await import("@/sse/services/auth.js");

const MODEL = "step-5-preview";
const LOCK_KEY = `modelLock_${MODEL}`;
const pick = (exclude = null) => getProviderCredentials("sf", exclude, MODEL);

beforeEach(() => {
  vi.clearAllMocks();
  store.forEach(c => {
    delete c.lastUsedAt;
    delete c.consecutiveUseCount;
    delete c[LOCK_KEY];
    delete c.modelLock___all;
    delete c.testStatus;
    delete c.lastError;
    delete c.backoffLevel;
  });
});

describe("fill-first failover hysteresis", () => {
  it("first use follows priority order", async () => {
    expect((await pick()).connectionId).toBe("a");
  });

  it("stays on the failover account after the failed one recovers", async () => {
    // req1: A (priority head)
    expect((await pick()).connectionId).toBe("a");

    // A hits 429 → model-locked, exactly like the log at 16:50:14
    await markAccountUnavailable("a", 429, "Rate limit reached, please try again later.", "sf", MODEL);
    expect(store[0][LOCK_KEY]).toBeTruthy();

    // req2: A is locked, so B takes over (same request would also reach B via fallback)
    expect((await pick(new Set(["a"]))).connectionId).toBe("b");

    // A's lock expires — the "switch back" moment from the log at 16:50:16
    store[0][LOCK_KEY] = new Date(Date.now() - 1000).toISOString();

    // Old fill-first flipped back to A here, discarding the prefix cache B had
    // built for this session. Now the recovered account must not jump the queue.
    expect((await pick()).connectionId).toBe("b");
    expect((await pick()).connectionId).toBe("b");
  });

  it("switches back to the recovered account only after the failover account also fails", async () => {
    expect((await pick()).connectionId).toBe("a");
    await markAccountUnavailable("a", 429, "Rate limit reached", "sf", MODEL);
    expect((await pick(new Set(["a"]))).connectionId).toBe("b");
    store[0][LOCK_KEY] = new Date(Date.now() - 1000).toISOString(); // A recovers mid-session

    // B now fails too → the selection must move back to A
    await markAccountUnavailable("b", 429, "Rate limit reached", "sf", MODEL);
    expect((await pick()).connectionId).toBe("a");

    // B recovers → A stays current; no flip-flop in either direction
    store[1][LOCK_KEY] = new Date(Date.now() - 1000).toISOString();
    expect((await pick()).connectionId).toBe("a");
  });
});
