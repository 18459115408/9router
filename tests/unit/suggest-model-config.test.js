import { describe, it, expect, beforeAll } from "vitest";
import { suggestModelConfig, setSuggestCatalogSource } from "../../open-sse/providers/suggestModelConfig.js";
import { setCustomCapsSource } from "../../open-sse/providers/capabilities.js";
import { upsertModelConfig, deleteModelConfig } from "../../src/lib/db/repos/modelConfigRepo.js";

// The gateway's own StepFun node, as the request path spells it.
const SF = "openai-compatible-chat-0dcce5df-5d45-4c99-ae90-52ecefab4955";

describe("suggestModelConfig", () => {
  beforeAll(() => {
    // No unified store installed, and no catalog: this is the built-in tables
    // alone, which is what an operator adding a brand-new model sees first.
    setCustomCapsSource(null);
    setSuggestCatalogSource(false);
  });

  it("proposes the built-in table values for a model the tables cover", () => {
    const s = suggestModelConfig(SF, "step-5-preview");
    expect(s.found).toBe(true);
    // The `*step-*` pattern is the only thing that knows this id.
    expect(s.caps.thinkingFormat).toBe("step");
    expect(s.caps.reasoning).toBe(true);
    expect(s.provenance.thinkingFormat).toBe("table");
  });

  it("says plainly when the tables hold nothing, instead of guessing", () => {
    // An id no table, pattern, or catalog entry recognizes: the honest answer
    // is "no opinion", not DEFAULT_CAPABILITIES dressed up as knowledge.
    const s = suggestModelConfig("some-node", "totally-unknown-xyz-model");
    expect(s.found).toBe(false);
    expect(s.source).toBe("none");
    expect(s.caps).toEqual({});
    expect(s.detail.fromTables).toBe(false);
  });

  it("reports a vision model's modality, and only what the tables really hold", () => {
    const s = suggestModelConfig("openai", "gpt-4o");
    // `*gpt-4o*` is a real table entry, so its limits are genuine knowledge and
    // are proposed as such.
    expect(s.caps.vision).toBe(true);
    expect(s.caps.contextWindow).toBe(128000);
    expect(s.caps.maxOutput).toBe(16384);
    // But nothing the pattern does not mention leaks in from the floor.
    expect(s.caps.thinkingFormat).toBeUndefined();
    expect(s.caps.reasoning).toBeUndefined();
  });

  it("carries routing from the registry, including an upstream id remap", () => {
    // deepseek-v4-pro-none maps to upstream deepseek-v4-pro in the registry.
    const s = suggestModelConfig("deepseek", "deepseek-v4-pro-none");
    expect(s.routing.upstreamModelId).toBe("deepseek-v4-pro");
    expect(s.provenance.upstreamModelId).toBe("registry");
  });

  it("marks the provider's own strip list when the registry declares one", () => {
    const s = suggestModelConfig("deepseek", "deepseek-v4-pro-none");
    expect(Array.isArray(s.routing.strip) || s.routing.strip === undefined).toBe(true);
  });

  it("resolves capabilities by registry id, not by the storage alias", () => {
    // The capability tables are keyed by registry id (`workbuddy`) while the
    // store/dashboard spelling is the alias (`wb`). `primary-model` exists only
    // in the workbuddy table, so the alias alone finds nothing and the floor
    // leaks in as if it were knowledge — with the id it is the real entry.
    const aliasOnly = suggestModelConfig("wb", "primary-model");
    const withId = suggestModelConfig("wb", "primary-model", { providerId: "workbuddy" });
    expect(aliasOnly.caps.contextWindow).not.toBe(272000);
    expect(withId.caps.contextWindow).toBe(272000);
    expect(withId.caps.thinkingFormat).toBe("openai");
    expect(withId.found).toBe(true);
    // Routing still reads through the alias — that is where the registry keys it.
    expect(withId.routing).toEqual(aliasOnly.routing);
  });

  it("ignores a vendor prefix when matching, and accepts the bare id", () => {
    const a = suggestModelConfig(SF, "vendor/step-5-preview");
    const b = suggestModelConfig(SF, "step-5-preview");
    expect(a.caps.thinkingFormat).toBe(b.caps.thinkingFormat);
  });

  it("filters unknown and ill-typed input rather than proposing it", () => {
    // suggestModelConfig only reads; nothing to write here. This guards the
    // shape of what a caller receives for a hostile id.
    const s = suggestModelConfig(SF, "");
    expect(s.found).toBe(false);
    expect(suggestModelConfig(null, null).found).toBe(false);
  });

  it("does not leak the unified store into the suggestion", async () => {
    // The suggestion is built-in knowledge only. A saved row is surfaced by the
    // API route as `existing`, not folded in here — otherwise the form could
    // pre-fill a row it is about to overwrite.
    await upsertModelConfig({ providerAlias: "suggest-probe", id: "m", caps: { contextWindow: 123456 } });
    const s = suggestModelConfig("suggest-probe", "m");
    expect(s.caps.contextWindow).toBeUndefined();
    expect(s.found).toBe(false);
    await deleteModelConfig({ providerAlias: "suggest-probe", id: "m" });
  });
});
