// WorkBuddy provider wiring: registry entry, transport, OAuth handler, refresh
// handler, capabilities and thinking levels must all resolve from the shared
// tables. Guards against a registry entry being added without the accompanying
// executor/OAuth/refresh registration (the failure mode is a silent 404 or a
// "usage API not implemented" message rather than a crash).
import { describe, it, expect } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { PROVIDERS as OAUTH_PROVIDERS } from "../../src/lib/oauth/providers/index.js";
import { refreshWorkbuddyToken } from "../../open-sse/services/tokenRefresh.js";
import {
  OAUTH_PROVIDERS as UI_OAUTH_PROVIDERS,
  resolveProviderId,
  getProviderByAlias,
} from "../../src/shared/constants/providers.js";

describe("workbuddy wiring", () => {
  it("registers a transport reachable under both the id and the wb alias", () => {
    const entry = REGISTRY.find((r) => r.id === "workbuddy");
    expect(entry).toBeTruthy();
    expect(entry.alias).toBe("wb");
    expect(entry.hasOAuth).toBe(true);
    expect(PROVIDERS.workbuddy.baseUrl).toBe("https://www.workbuddy.ai/v2/chat/completions");
    expect(PROVIDERS.workbuddy.format).toBe("openai");
    expect(PROVIDERS.workbuddy.forceStream).toBe(true);
    expect(PROVIDER_MODELS.wb.length).toBeGreaterThan(15);
  });

  it("points OAuth at the workbuddy.ai plugin endpoints", () => {
    expect(PROVIDER_OAUTH.workbuddy.platform).toBe("CLI");
    expect(PROVIDER_OAUTH.workbuddy.stateUrl).toBe("https://www.workbuddy.ai/v2/plugin/auth/state");
    expect(PROVIDER_OAUTH.workbuddy.refreshUrl).toBe("https://www.workbuddy.ai/v2/plugin/auth/token/refresh");
  });

  it("registers a device-code OAuth handler", () => {
    expect(OAUTH_PROVIDERS.workbuddy).toBeTruthy();
    expect(OAUTH_PROVIDERS.workbuddy.flowType).toBe("device_code");
  });

  it("uses the specialized executor rather than the default", () => {
    expect(hasSpecializedExecutor("workbuddy")).toBe(true);
    expect(getExecutor("workbuddy").constructor.name).toBe("WorkBuddyExecutor");
  });

  it("exposes the refresh handler", async () => {
    expect(typeof refreshWorkbuddyToken).toBe("function");
    // No refresh token → short-circuits without touching the network.
    await expect(refreshWorkbuddyToken("", null)).resolves.toBeNull();
  });

  it("declares capabilities and per-model thinking levels from the live catalog", () => {
    const caps = getCapabilitiesForModel("workbuddy", "gpt-6-astra");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(128000);

    // supportedEfforts from /v3/config, not the openai format default.
    expect(getThinkingLevels("workbuddy", "gpt-6-astra")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getThinkingLevels("workbuddy", "glm-5.2")).toEqual(["high", "xhigh"]);
    // canDisableThinking:false → "none" filtered out.
    expect(getThinkingLevels("workbuddy", "hy4-preview")).toEqual(["high"]);
  });

  it("falls back to the openai level set for models publishing no supportedEfforts", () => {
    expect(getThinkingLevels("workbuddy", "kimi-k3")).toContain("medium");
  });

  it("surfaces in the dashboard provider list and resolves the wb alias", () => {
    // The dashboard list is derived from the same registry, so a registry entry
    // missing here would mean the provider is invisible in the UI.
    const entry = UI_OAUTH_PROVIDERS.workbuddy;
    expect(entry, "workbuddy should be listed as an OAuth provider").toBeTruthy();
    expect(entry.hidden).not.toBe(true);
    expect(resolveProviderId("wb")).toBe("workbuddy");
    expect(getProviderByAlias("wb")?.id).toBe("workbuddy");
  });
});
