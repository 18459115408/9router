import { describe, it, expect } from "vitest";
import { isSubscriptionCredentials } from "../../open-sse/utils/accountType.js";

// Tunnel-only behaviors (Claude Code identity injection in openai-to-claude,
// warmup/title fabricated replies in chatCore) gate on this helper:
// subscription accounts keep the disguise, metered API-key accounts must be
// forwarded untouched.
describe("isSubscriptionCredentials", () => {
  it("treats oauth and access_token connections as subscription tunnels", () => {
    expect(isSubscriptionCredentials({ authType: "oauth" })).toBe(true);
    expect(isSubscriptionCredentials({ authType: "access_token" })).toBe(true);
    expect(isSubscriptionCredentials({ authType: "oauth", accessToken: "tok" })).toBe(true);
  });

  it("treats apikey, none and missing credentials as metered accounts", () => {
    expect(isSubscriptionCredentials({ authType: "apikey", apiKey: "sk-x" })).toBe(false);
    expect(isSubscriptionCredentials({ authType: "none" })).toBe(false);
    expect(isSubscriptionCredentials(null)).toBe(false);
    expect(isSubscriptionCredentials(undefined)).toBe(false);
    expect(isSubscriptionCredentials({})).toBe(false);
  });

  it("legacy rows without authType: token-only is a tunnel, apiKey is metered", () => {
    expect(isSubscriptionCredentials({ accessToken: "tok" })).toBe(true);
    expect(isSubscriptionCredentials({ apiKey: "sk-x" })).toBe(false);
  });
});
