import { afterEach, describe, expect, it } from "vitest";
import { getCapabilitiesForModel, setCustomCapsSource } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

// A user-added node whose model id matches no pattern in the built-in tables —
// the case the declarations exist for.
const NODE = "openai-compatible-chat-declared";
const MODEL = "my-private-model";

afterEach(() => setCustomCapsSource(null));

describe("declared thinking configuration", () => {
  it("leaves an unknown model with no levels until something declares them", () => {
    expect(getThinkingLevels(NODE, MODEL)).toBeNull();
    setCustomCapsSource({ getCaps: () => ({ reasoning: true }) });
    // reasoning alone still gets the generic default — no declaration of levels
    expect(getThinkingLevels(NODE, MODEL)).toEqual(["none", "low", "medium", "high"]);
  });

  it("replaces the built-in level set rather than merging with it", () => {
    setCustomCapsSource({
      getCaps: () => ({ reasoning: true, thinkingLevels: ["low", "high", "max"] }),
    });
    // The generic default would be none/low/medium/high; the declaration wins
    // outright, which is the whole point for a private upstream.
    expect(getThinkingLevels(NODE, MODEL)).toEqual(["low", "high", "max"]);
  });

  it("drops the off switch when the model cannot disable thinking", () => {
    setCustomCapsSource({
      getCaps: () => ({ reasoning: true, thinkingLevels: ["none", "low", "high"], thinkingCanDisable: false }),
    });
    expect(getThinkingLevels(NODE, MODEL)).toEqual(["low", "high"]);
  });

  it("overrides the format inferred from a model's name", () => {
    // "deepseek-v4.1-flash" matches the built-in deepseek entry...
    expect(getCapabilitiesForModel(NODE, "deepseek-v4.1-flash").thinkingFormat).toBe("deepseek");
    // ...but a declaration replaces that inference.
    setCustomCapsSource({ getCaps: () => ({ thinkingFormat: "zai" }) });
    expect(getCapabilitiesForModel(NODE, "deepseek-v4.1-flash").thinkingFormat).toBe("zai");
  });

  it("honours a declared reasoning:false, unlike the additive modality flags", () => {
    // reasoning is an explicit statement, so it can turn off...
    setCustomCapsSource({ getCaps: () => ({ reasoning: false }) });
    expect(getCapabilitiesForModel("xiaomi-mimo", "mimo-v2.6-flash").reasoning).toBe(false);
    expect(getThinkingLevels("xiaomi-mimo", "mimo-v2.6-flash")).toBeNull();
    // ...while a modality flag still cannot, so a mis-click cannot strip images.
    setCustomCapsSource({ getCaps: () => ({ vision: false }) });
    expect(getCapabilitiesForModel("xiaomi-mimo", "mimo-v2.6-flash").vision).toBe(true);
  });

  it("sends the declared levels through the chosen format", () => {
    setCustomCapsSource({
      getCaps: () => ({ reasoning: true, thinkingFormat: "openai", thinkingLevels: ["low", "high"] }),
    });
    const low = {};
    applyThinking("openai", MODEL, low, NODE, { mode: "level", level: "low" });
    expect(low.reasoning_effort).toBe("low");

    const high = {};
    applyThinking("openai", MODEL, high, NODE, { mode: "level", level: "high" });
    expect(high.reasoning_effort).toBe("high");
  });

  it("lets a custom mapping beat the format's built-in shape", () => {
    // The deepseek format collapses low/medium to "high" — a mapping is how an
    // upstream that actually honours "low" gets it.
    setCustomCapsSource({
      getCaps: () => ({
        reasoning: true,
        thinkingFormat: "deepseek",
        thinkingLevels: ["low", "high"],
        thinkingMapping: {
          low: { thinking: { type: "enabled" }, reasoning_effort: "low" },
          high: { thinking: { type: "enabled" }, reasoning_effort: "high" },
          disabled: { thinking: { type: "disabled" } },
        },
      }),
    });

    const low = {};
    applyThinking("openai", MODEL, low, NODE, { mode: "level", level: "low" });
    expect(low).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "low" });

    const off = {};
    applyThinking("openai", MODEL, off, NODE, { mode: "none" });
    expect(off).toEqual({ thinking: { type: "disabled" } });
  });

  it("falls back to the format default for levels the mapping omits", () => {
    setCustomCapsSource({
      getCaps: () => ({
        reasoning: true,
        thinkingFormat: "openai",
        thinkingLevels: ["low", "high"],
        thinkingMapping: { low: { reasoning_effort: "custom-low" } },
      }),
    });
    const low = {};
    applyThinking("openai", MODEL, low, NODE, { mode: "level", level: "low" });
    expect(low.reasoning_effort).toBe("custom-low");

    // "high" is not in the mapping, so the openai format still handles it
    // instead of the request going out with no thinking field at all.
    const high = {};
    applyThinking("openai", MODEL, high, NODE, { mode: "level", level: "high" });
    expect(high.reasoning_effort).toBe("high");
  });

  it("scopes a declaration to its own provider and model", () => {
    setCustomCapsSource({ getCaps: (p, m) => (p === NODE && m === MODEL ? { reasoning: true, thinkingLevels: ["low"] } : null) });
    expect(getThinkingLevels(NODE, MODEL)).toEqual(["low"]);
    expect(getThinkingLevels(NODE, "some-other-model")).not.toEqual(["low"]);
    expect(getThinkingLevels("openai-compatible-chat-other", MODEL)).not.toEqual(["low"]);
  });
});
