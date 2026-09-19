// Per-provider cooldown override (settings.providerStrategies[id].cooldown).
//
// The load-bearing property is the FIRST block: with no override configured,
// every branch must return exactly what the global constants produce. The rest
// covers each override bucket plus the invalid-value fallbacks.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkFallbackError,
  getQuotaCooldown,
  applyErrorState,
} from "../../open-sse/services/accountFallback.js";
import {
  BACKOFF_CONFIG,
  TRANSIENT_COOLDOWN_MS,
  MAX_RATE_LIMIT_COOLDOWN_MS,
  COOLDOWN,
} from "../../open-sse/config/errorConfig.js";

// Baseline: the behaviour that must be preserved when nothing is configured.
const BASELINE = [
  { name: "429 (backoff)", status: 429, text: "rate limit exceeded", level: 0 },
  { name: "429 (backoff, level 3)", status: 429, text: "too many requests", level: 3 },
  { name: "402 (fixed long)", status: 402, text: "payment required", level: 0 },
  { name: "401 (fixed long)", status: 401, text: "unauthorized", level: 0 },
  { name: "403 (fixed long)", status: 403, text: "forbidden", level: 0 },
  { name: "404 (fixed long)", status: 404, text: "not found", level: 0 },
  { name: "request not allowed (fixed short)", status: 400, text: "request not allowed", level: 0 },
  { name: "no credentials (fixed long)", status: 500, text: "no credentials", level: 0 },
  { name: "unmatched (transient)", status: 500, text: "something unexpected", level: 0 },
];

// Freeze the clock: cooldown math is relative to Date.now(), so a live clock
// makes equal-by-construction comparisons drift by a millisecond.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-18T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("cooldown override — absent config reproduces baseline exactly", () => {
  it.each(BASELINE)("$name is unchanged with no cfg, {} or undefined", ({ status, text, level }) => {
    const none = checkFallbackError(status, text, level);
    const empty = checkFallbackError(status, text, level, {});
    const undef = checkFallbackError(status, text, level, undefined);
    expect(empty).toEqual(none);
    expect(undef).toEqual(none);
  });

  it("getQuotaCooldown matches the constants across levels", () => {
    for (let level = 0; level <= 16; level++) {
      const expected = Math.min(BACKOFF_CONFIG.base * Math.pow(2, Math.max(0, level - 1)), BACKOFF_CONFIG.max);
      expect(getQuotaCooldown(level)).toBe(expected);
      expect(getQuotaCooldown(level, {})).toBe(expected);
    }
  });

  it("still respects maxLevel when unconfigured", () => {
    // Level is clamped, so a huge backoffLevel does not run away.
    const out = checkFallbackError(429, "rate limit", 999);
    expect(out.newBackoffLevel).toBe(BACKOFF_CONFIG.maxLevel);
    expect(out.cooldownMs).toBe(BACKOFF_CONFIG.max);
  });

  it("applyErrorState is unchanged without cfg", () => {
    const account = { backoffLevel: 0 };
    expect(applyErrorState(account, 402, "payment required")).toEqual(
      applyErrorState(account, 402, "payment required", {}),
    );
  });
});

describe("cooldown override — configured buckets take effect", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("maxBackoffMs caps the backoff once the exponential can reach it", () => {
    // checkFallbackError bumps the level by one before pricing it, so with base
    // = 1h the cooldown at backoffLevel 5 is 2^5 = 32h — past the 24h cap.
    const HOUR = 60 * 60 * 1000;
    const out = checkFallbackError(429, "rate limit", 5, { backoffBaseMs: HOUR, maxBackoffMs: DAY });
    expect(out.cooldownMs).toBe(DAY);
    expect(out.cooldownMs).toBeGreaterThan(MAX_RATE_LIMIT_COOLDOWN_MS);
  });

  it("maxBackoffLevel lets the exponential climb past the default ceiling", () => {
    // base 2s with maxLevel 30 can reach 2^29s ≈ 17 years, so the 24h cap bites.
    const out = checkFallbackError(429, "rate limit", 25, { maxBackoffLevel: 30, maxBackoffMs: DAY });
    expect(out.cooldownMs).toBe(DAY);
    expect(out.newBackoffLevel).toBe(26); // 25 + 1, still under maxLevel
  });

  it("backoffBaseMs changes the base of the exponential", () => {
    // backoffLevel 1 → newLevel 2 → level 1 → base * 2^1
    const out = checkFallbackError(429, "rate limit", 1, { backoffBaseMs: 10_000 });
    expect(out.cooldownMs).toBe(20_000);
  });

  it("cooldownLongMs applies to 401/402/403/404", () => {
    for (const status of [401, 402, 403, 404]) {
      const out = checkFallbackError(status, "whatever", 0, { cooldownLongMs: DAY });
      expect(out.cooldownMs, `status ${status}`).toBe(DAY);
    }
  });

  it("cooldownLongMs applies to text rules sharing the long bucket", () => {
    const out = checkFallbackError(500, "no credentials", 0, { cooldownLongMs: DAY });
    expect(out.cooldownMs).toBe(DAY);
  });

  it("cooldownShortMs applies to 'request not allowed'", () => {
    const out = checkFallbackError(400, "request not allowed", 0, { cooldownShortMs: 60_000 });
    expect(out.cooldownMs).toBe(60_000);
    expect(out.cooldownMs).not.toBe(COOLDOWN.short);
  });

  it("transientCooldownMs applies to unmatched errors", () => {
    const out = checkFallbackError(500, "unexpected thing", 0, { transientCooldownMs: 90_000 });
    expect(out.cooldownMs).toBe(90_000);
    expect(out.cooldownMs).not.toBe(TRANSIENT_COOLDOWN_MS);
  });

  it("overriding one bucket leaves the others at their defaults", () => {
    const cfg = { cooldownLongMs: DAY };
    expect(checkFallbackError(402, "x", 0, cfg).cooldownMs).toBe(DAY);
    expect(checkFallbackError(400, "request not allowed", 0, cfg).cooldownMs).toBe(COOLDOWN.short);
    expect(checkFallbackError(500, "unmatched", 0, cfg).cooldownMs).toBe(TRANSIENT_COOLDOWN_MS);
    // backoffLevel 3 → newLevel 4 → level 3 → base * 2^3 = 16000, under the 5-minute cap.
    expect(checkFallbackError(429, "rate limit", 3, cfg).cooldownMs).toBe(BACKOFF_CONFIG.base * 8);
  });

  it("applyErrorState honours the override", () => {
    const out = applyErrorState({ backoffLevel: 0 }, 402, "payment required", { cooldownLongMs: DAY });
    const until = new Date(out.rateLimitedUntil).getTime() - Date.now();
    expect(until).toBeGreaterThan(DAY - 5_000);
    expect(until).toBeLessThanOrEqual(DAY + 1_000);
  });
});

describe("cooldown override — invalid values fall back safely", () => {
  const BAD = [undefined, null, -1, -1000, NaN, Infinity, "abc", {}, []];

  it.each(BAD)("maxBackoffMs=%p falls back to the default cap", (bad) => {
    // Level 20 with the default base exceeds the default cap, so the cap shows.
    const out = checkFallbackError(429, "rate limit", 20, { maxBackoffMs: bad });
    expect(out.cooldownMs).toBe(BACKOFF_CONFIG.max);
  });

  it.each(BAD)("cooldownLongMs=%p falls back to COOLDOWN.long", (bad) => {
    const out = checkFallbackError(402, "payment required", 0, { cooldownLongMs: bad });
    expect(out.cooldownMs).toBe(COOLDOWN.long);
  });

  it.each(BAD)("transientCooldownMs=%p falls back to the transient default", (bad) => {
    const out = checkFallbackError(500, "unmatched", 0, { transientCooldownMs: bad });
    expect(out.cooldownMs).toBe(TRANSIENT_COOLDOWN_MS);
  });

  it("accepts zero as a deliberate override (no cooldown)", () => {
    const out = checkFallbackError(402, "payment required", 0, { cooldownLongMs: 0 });
    expect(out.cooldownMs).toBe(0);
  });

  it("never throws on a malformed cfg", () => {
    for (const cfg of [null, undefined, "nope", 42, []]) {
      expect(() => checkFallbackError(429, "rate limit", 0, cfg)).not.toThrow();
      expect(() => checkFallbackError(402, "payment required", 0, cfg)).not.toThrow();
    }
  });

  it("a cfg with unrelated keys is inert", () => {
    const out = checkFallbackError(402, "payment required", 0, { somethingElse: 12345 });
    expect(out.cooldownMs).toBe(COOLDOWN.long);
  });
});
