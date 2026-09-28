import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getCapabilitiesForModel, setModelConfigSource, DEFAULT_CAPABILITIES } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { upsertModelConfig, deleteModelConfig, refreshModelConfigs, getStoredConfig } from "../../src/lib/db/repos/modelConfigRepo.js";
import { buildAliasIndex } from "../../open-sse/providers/customCapsOverride.js";

// The gateway's own StepFun node, carrying the config an operator already saved.
const SF = "openai-compatible-chat-0dcce5df-5d45-4c99-ae90-52ecefab4955";
const PROBE = "vitest-probe2";

// Install a reader backed by the real store, the way instrumentation does.
// Shared by every test in the file: installing per-describe meant one block's
// teardown could pull the reader out from under the next block.
beforeAll(async () => {
  const { default: registry } = await import("../../open-sse/providers/registry/index.js");
  const index = buildAliasIndex(registry);
  await refreshModelConfigs({ canonicalOf: (a) => index.get(a) || a });
  setModelConfigSource({ getConfig: getStoredConfig });
});

afterAll(async () => {
  const rows = [
    { providerAlias: PROBE, id: "t-override" },
    { providerAlias: PROBE, id: "t-turnoff" },
    { providerAlias: PROBE, id: "t-builtin" },
    { providerAlias: PROBE, id: "step-5-preview" },
    { providerAlias: "openai", id: "gpt-4o" },
    { providerAlias: "ds", id: "alias-probe-model" },
    { providerAlias: PROBE, id: "gpt-4o" },
  ];
  for (const r of rows) await deleteModelConfig(r).catch(() => {});
  setModelConfigSource(null);
});

describe("unified config overrides the built-in tables", () => {
  it("keeps an operator's saved caps working exactly as before", () => {
    // The row the migration lifted carries {vision, reasoning}; the pattern
    // table says vision:false, so this is where the overlay is load-bearing.
    const c = getCapabilitiesForModel(SF, "step-5-preview");
    expect(c.vision).toBe(true);
    expect(c.reasoning).toBe(true);
    expect(c.thinkingFormat).toBe("step");
  });

  it("now honours a saved `false`, which the old overlay could not express", async () => {
    expect(getCapabilitiesForModel("openai", "gpt-4o").vision).toBe(true);
    await upsertModelConfig({ providerAlias: "openai", id: "gpt-4o", caps: { vision: false } });
    // Under the declared-caps overlay this was a no-op (modalities were
    // additive); under the unified config it must stick.
    expect(getCapabilitiesForModel("openai", "gpt-4o").vision).toBe(false);
    await upsertModelConfig({ providerAlias: "openai", id: "gpt-4o", caps: { vision: null } });
    expect(getCapabilitiesForModel("openai", "gpt-4o").vision).toBe(true);
  });

  it("lets an operator correct a context window the tables got wrong", async () => {
    // The pattern table pins every step-* model at 128000; the real model is 1M.
    expect(getCapabilitiesForModel(PROBE, "step-5-preview").contextWindow).toBe(128000);
    await upsertModelConfig({ providerAlias: PROBE, id: "step-5-preview", caps: { contextWindow: 1000000, vision: true, reasoning: true } });
    const c = getCapabilitiesForModel(PROBE, "step-5-preview");
    expect(c.contextWindow).toBe(1000000);
    expect(c.vision).toBe(true);
    // maxOutput is not in the row, so the table value survives untouched.
    expect(c.maxOutput).toBe(64000);
    expect(getThinkingLevels(PROBE, "step-5-preview")).toEqual(["none", "low", "medium", "high"]);
    await deleteModelConfig({ providerAlias: PROBE, id: "step-5-preview" });
    expect(getCapabilitiesForModel(PROBE, "step-5-preview").contextWindow).toBe(128000);
  });

  it("carries thinking config and quirks through to the picker", async () => {
    await upsertModelConfig({
      providerAlias: PROBE, id: "t-override", caps: {
        reasoning: true, thinkingFormat: "step", thinkingCanDisable: false,
        thinkingLevels: ["low", "high"], contextWindow: 512000, maxOutput: 32000,
        targetFormat: "claude", upstreamModelId: "up-x", quirks: { forceStream: true },
      },
    });
    const c = getCapabilitiesForModel(PROBE, "t-override");
    expect(c.thinkingFormat).toBe("step");
    expect(c.thinkingCanDisable).toBe(false);
    expect(c.contextWindow).toBe(512000);
    expect(c.maxOutput).toBe(32000);
    expect(c.quirks).toEqual({ forceStream: true });
    // `none` is dropped because the row says thinking cannot be disabled.
    expect(getThinkingLevels(PROBE, "t-override")).toEqual(["low", "high"]);
  });

  it("leaves a model with no saved row on exactly the built-in tables", async () => {
    // A registration row that carries no caps must change nothing — this is
    // what keeps the 459 migrated rows behaviour-neutral.
    await upsertModelConfig({ providerAlias: PROBE, id: "t-builtin", caps: null });
    expect(getCapabilitiesForModel(PROBE, "t-builtin")).toEqual({
      ...DEFAULT_CAPABILITIES,
      contextWindow: 200000,
      maxOutput: 64000,
    });
  });

  it("resolves across the vendor prefix, case, and :suffix spellings", async () => {
    await upsertModelConfig({ providerAlias: PROBE, id: "t-override", caps: { contextWindow: 777000 } });
    for (const spelling of ["t-override", "vendor/t-override", "T-OVERRIDE", "t-override:free"]) {
      expect(getCapabilitiesForModel(PROBE, spelling).contextWindow).toBe(777000);
    }
    expect(getCapabilitiesForModel(PROBE, "unrelated").contextWindow).not.toBe(777000);
  });

  it("resolves a row stored under a dashboard alias when the request carries the provider id", async () => {
    // `ds` is the dashboard alias for the `deepseek` provider id.
    await upsertModelConfig({ providerAlias: "ds", id: "alias-probe-model", caps: { contextWindow: 424242 } });
    expect(getCapabilitiesForModel("deepseek", "alias-probe-model").contextWindow).toBe(424242);
    expect(getCapabilitiesForModel("ds", "alias-probe-model").contextWindow).toBe(424242);
  });

  it("overrides the commandcode branch too, which used to return early", async () => {
    await upsertModelConfig({ providerAlias: "commandcode", id: "cmd-probe-model", caps: { contextWindow: 999999 } });
    expect(getCapabilitiesForModel("commandcode", "cmd-probe-model").contextWindow).toBe(999999);
    await deleteModelConfig({ providerAlias: "commandcode", id: "cmd-probe-model" });
    // Without the row the branch behaves exactly as before.
    expect(getCapabilitiesForModel("commandcode", "cmd-probe-model").contextWindow).toBe(1000000);
  });
});
