// End-to-end wiring for the per-provider cooldown override: settings →
// resolveCooldownConfig → markAccountUnavailable → persisted model lock.
//
// The unit tests in provider-cooldown.test.js cover the pure math; this file
// covers the plumbing that the math can't see — that the value read from
// settings.providerStrategies[id].cooldown actually reaches the lock, that
// aliases resolve to the same entry, and that an unconfigured provider is
// unaffected.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(() => null),
}));

vi.mock("open-sse/services/accountFallback.js", async (importOriginal) => {
  // Keep the real math; only stub the pieces that touch the DB.
  const actual = await importOriginal();
  return { ...actual };
});

vi.mock("@/sse/utils/logger.js", () => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  request: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));

const { markAccountUnavailable } = await import("@/sse/services/auth.js");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// The lock expiry the call produced, in ms from now.
function lockMs() {
  const patch = mocks.updateProviderConnection.mock.calls.at(-1)?.[1] || {};
  const key = Object.keys(patch).find((k) => k.startsWith("modelLock_"));
  return new Date(patch[key]).getTime() - Date.now();
}

function withSettings(strategies) {
  mocks.getSettings.mockResolvedValue({ providerStrategies: strategies });
}

describe("provider cooldown override reaches the account lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-1", backoffLevel: 0, provider: "workbuddy" },
    ]);
    mocks.updateProviderConnection.mockResolvedValue(undefined);
    withSettings({});
  });

  it("unconfigured provider keeps the default 402 cooldown (2 min)", async () => {
    await markAccountUnavailable("conn-1", 402, "payment required", "workbuddy", "glm-5.2");
    expect(lockMs()).toBeGreaterThan(2 * 60 * 1000 - 5000);
    expect(lockMs()).toBeLessThanOrEqual(2 * 60 * 1000 + 1000);
  });

  it("cooldownLongMs overrides the 402 cooldown", async () => {
    withSettings({ workbuddy: { cooldown: { cooldownLongMs: DAY } } });
    await markAccountUnavailable("conn-1", 402, "payment required", "workbuddy", "glm-5.2");
    expect(lockMs()).toBeGreaterThan(DAY - 5000);
    expect(lockMs()).toBeLessThanOrEqual(DAY + 1000);
  });

  it("maxRateLimitCooldownMs caps an upstream-reported reset time", async () => {
    // Upstream reports a reset far beyond the cap; the cap must shorten it.
    const resetsAt = Date.now() + 3 * DAY;

    // Default cap is 30 minutes.
    await markAccountUnavailable("conn-1", 429, "rate limit", "workbuddy", "glm-5.2", resetsAt);
    expect(lockMs()).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);
    expect(lockMs()).toBeGreaterThan(30 * 60 * 1000 - 5000);

    // Raised to 24h → the reported reset (3 days) is clamped to 24h.
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([{ id: "conn-1", backoffLevel: 0 }]);
    mocks.updateProviderConnection.mockResolvedValue(undefined);
    withSettings({ workbuddy: { cooldown: { maxRateLimitCooldownMs: DAY } } });
    await markAccountUnavailable("conn-1", 429, "rate limit", "workbuddy", "glm-5.2", resetsAt);
    expect(lockMs()).toBeGreaterThan(DAY - 5000);
    expect(lockMs()).toBeLessThanOrEqual(DAY + 1000);
  });

  it("uses the upstream reset time as-is when it is shorter than the cap", async () => {
    // A cap only limits — it never extends a shorter upstream reset.
    const resetsAt = Date.now() + 5 * 60 * 1000;
    withSettings({ workbuddy: { cooldown: { maxRateLimitCooldownMs: DAY } } });
    await markAccountUnavailable("conn-1", 429, "rate limit", "workbuddy", "glm-5.2", resetsAt);
    expect(lockMs()).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    expect(lockMs()).toBeGreaterThan(5 * 60 * 1000 - 5000);
  });

  it("resolves the wb alias to the same configuration", async () => {
    withSettings({ workbuddy: { cooldown: { cooldownLongMs: DAY } } });
    await markAccountUnavailable("conn-1", 402, "payment required", "wb", "glm-5.2");
    expect(lockMs()).toBeGreaterThan(DAY - 5000);
  });

  it("does not leak one provider's override onto another", async () => {
    withSettings({ workbuddy: { cooldown: { cooldownLongMs: DAY } } });
    await markAccountUnavailable("conn-1", 402, "payment required", "claude", "claude-sonnet-4.5");
    // claude has no override → default 2 minutes.
    expect(lockMs()).toBeLessThanOrEqual(2 * 60 * 1000 + 1000);
  });

  it("survives a malformed settings row without breaking failover", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db unavailable"));
    const result = await markAccountUnavailable("conn-1", 402, "payment required", "workbuddy", "glm-5.2");
    expect(result.shouldFallback).toBe(true);
    expect(lockMs()).toBeGreaterThan(0);
  });

  it("tolerates a non-object cooldown value", async () => {
    withSettings({ workbuddy: { cooldown: "nonsense" } });
    const result = await markAccountUnavailable("conn-1", 402, "payment required", "workbuddy", "glm-5.2");
    expect(result.shouldFallback).toBe(true);
    expect(lockMs()).toBeLessThanOrEqual(2 * 60 * 1000 + 1000);
  });

  it.each([-1, NaN, "abc", null])("rejects %p on the reset-time cap and uses the default", async (bad) => {
    // The resetsAt branch is a separate code path from checkFallbackError, so its
    // validation is asserted independently.
    withSettings({ workbuddy: { cooldown: { maxRateLimitCooldownMs: bad } } });
    const resetsAt = Date.now() + 3 * DAY;
    await markAccountUnavailable("conn-1", 429, "rate limit", "workbuddy", "glm-5.2", resetsAt);
    expect(lockMs()).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);
  });
});
