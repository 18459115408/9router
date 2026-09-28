import { describe, it, expect } from "vitest";
import { mapProviderModelConfig, mapProviderModels } from "../../src/lib/db/providerModelMapping.js";

describe("mapProviderModelConfig", () => {
  it("keeps zed's per-model config instead of discarding it", () => {
    const { id, caps } = mapProviderModelConfig({
      id: "zed-model-x",
      contextLength: 256000,
      contextLengthInMaxMode: 128000,
      maxOutputTokens: 32000,
      supportsTools: true,
      supportsImages: true,
      supportsThinking: true,
      supportsDisablingThinking: false,
      supportedEffortLevels: ["low", "medium", "high"],
    });
    expect(id).toBe("zed-model-x");
    expect(caps).toMatchObject({
      contextWindow: 256000,
      maxOutput: 32000,
      vision: true,
      reasoning: true,
      thinkingCanDisable: false,
      thinkingLevels: ["low", "medium", "high"],
      tools: true,
    });
  });

  it("keeps qoder's per-model config", () => {
    const { caps } = mapProviderModelConfig({
      id: "qoder/auto",
      contextLength: 128000,
      maxOutputTokens: 16000,
      isVL: true,
      isReasoning: true,
    });
    expect(caps).toEqual({ contextWindow: 128000, maxOutput: 16000, vision: true, reasoning: true });
  });

  it("reads a nested capabilities object (github/kiro shape)", () => {
    const { caps } = mapProviderModelConfig({
      id: "gh-model",
      capabilities: { image: true, tool: true, search: false },
      version: "2026-01-01",
    });
    expect(caps).toEqual({ vision: true, tools: true, search: false });
  });

  it("normalizes effort tiers to the schema's vocabulary", () => {
    const { caps } = mapProviderModelConfig({
      id: "m",
      supportedEffortLevels: ["off", "LOW", "medium", "xhigh", "bogus-tier"],
    });
    expect(caps.thinkingLevels).toEqual(["none", "low", "medium", "xhigh"]);
  });

  it("does not overwrite a more specific field with a generic one", () => {
    // supportsImages and capabilities.image describe the same fact; the
    // explicit supplier field must win rather than whichever came last.
    const { caps } = mapProviderModelConfig({
      id: "m",
      supportsImages: true,
      capabilities: { image: false },
    });
    expect(caps.vision).toBe(true);
  });

  it("treats a reported 0 as unknown rather than a zero-token limit", () => {
    const { caps } = mapProviderModelConfig({ id: "m", contextLength: 0, maxOutputTokens: 0 });
    expect(caps.contextWindow).toBeUndefined();
    expect(caps.maxOutput).toBeUndefined();
  });

  it("drops unknown fields rather than guessing", () => {
    const { caps } = mapProviderModelConfig({
      id: "m", someVendorField: "x", rateMultiplier: 1.5, description: "a model",
    });
    expect(caps).toEqual({});
  });

  it("accepts entries under an id or a name", () => {
    expect(mapProviderModelConfig({ name: "by-name" }).id).toBe("by-name");
    expect(mapProviderModelConfig({ model: "by-model" }).id).toBe("by-model");
    expect(mapProviderModelConfig({})).toBeNull();
    expect(mapProviderModelConfig(null)).toBeNull();
  });

  it("maps a whole list, skipping entries with no id", () => {
    const out = mapProviderModels([
      { id: "a", contextLength: 1000 },
      { noId: true },
      { name: "b" },
      null,
    ]);
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
    expect(out[0].caps.contextWindow).toBe(1000);
  });

  it("reports no config for an entry the provider described with nothing usable", () => {
    // The caller must be able to tell "provider said nothing" from "provider
    // said vision:false", so an unmappable entry yields an empty caps.
    expect(mapProviderModelConfig({ id: "m" }).caps).toEqual({});
    expect(mapProviderModels("not an array")).toEqual([]);
  });
});
