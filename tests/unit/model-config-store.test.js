import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getModelConfigs, getStoredConfig, refreshModelConfigs,
  upsertModelConfig, deleteModelConfig, importLegacyCustomModel,
} from "../../src/lib/db/repos/modelConfigRepo.js";
import { sanitizeModelConfig, isConfigLocked, inferSource } from "../../src/lib/db/modelConfigSchema.js";

// Provider aliases as they appear in this machine's DB.
const SF = "openai-compatible-chat-0dcce5df-5d45-4c99-ae90-52ecefab4955";
const PROBE = "vitest-probe";

// Rows these tests create and must clean up, so the suite is repeatable
// against the real DB without leaving residue.
const CLEANUP = [
  { providerAlias: PROBE, id: "t-caps" },
  { providerAlias: PROBE, id: "t-nulls" },
  { providerAlias: PROBE, id: "t-locked" },
  { providerAlias: PROBE, id: "t-legacy" },
  { providerAlias: PROBE, id: "t-lift" },
];

describe("unified model-config store", () => {
  beforeAll(async () => {
    // Build our own snapshot rather than inheriting whatever a sibling test
    // file left installed — the store is one real DB row set shared by every
    // file in the run, so each must read it fresh.
    await refreshModelConfigs();
  });

  afterAll(async () => {
    for (const row of CLEANUP) await deleteModelConfig(row).catch(() => {});
  });

  it("holds one row per legacy custom model, with the caps the operator set", async () => {
    const all = await getModelConfigs();
    expect(Object.keys(all).length).toBeGreaterThan(0);
    // The two rows that carried caps before the migration still do, now with
    // provenance attached.
    expect(getStoredConfig(SF, "step-5-preview")).toMatchObject({
      id: "step-5-preview", type: "llm", source: "operator",
      caps: { vision: true, reasoning: true },
    });
    expect(getStoredConfig("ds", "deepseek-flash").caps).toEqual({ vision: true, reasoning: true });
    // Rows with no caps became builtin-provenance registrations.
    expect(getStoredConfig("cl", "deepseek/deepseek-v4.1-flash").source).toBe("builtin");
  });

  it("resolves across vendor prefixes, case, and :suffixes", () => {
    expect(getStoredConfig("ds", "vendor/deepseek-flash").id).toBe("deepseek-flash");
    expect(getStoredConfig("ds", "DEEPSEEK-FLASH").id).toBe("deepseek-flash");
    expect(getStoredConfig("ds", "deepseek-flash:free").id).toBe("deepseek-flash");
    expect(getStoredConfig("ds", "no-such-model")).toBeNull();
    expect(getStoredConfig(null, "deepseek-flash")).toBeNull();
  });

  it("persists the full capability config, not just the modality subset", async () => {
    await upsertModelConfig({
      providerAlias: PROBE, id: "t-caps",
      caps: {
        vision: true, pdf: true, audioInput: true, videoInput: true,
        imageOutput: true, audioOutput: true, search: true, tools: false, reasoning: true,
        contextWindow: 1000000, maxOutput: 65536,
        thinkingFormat: "step", thinkingCanDisable: false, thinkingRange: { min: 1024, max: 65536 },
        thinkingEffortSupported: true, thinkingLevels: ["low", "medium", "high"],
        thinkingMapping: { low: { my_knob: "low" } },
      },
    });
    // Read straight back off the synchronous snapshot — this is what the
    // request path sees, so a write that does not land here is invisible.
    expect(getStoredConfig(PROBE, "t-caps").caps).toEqual({
      vision: true, pdf: true, audioInput: true, videoInput: true,
      imageOutput: true, audioOutput: true, search: true, tools: false, reasoning: true,
      contextWindow: 1000000, maxOutput: 65536,
      thinkingFormat: "step", thinkingCanDisable: false, thinkingRange: { min: 1024, max: 65536 },
      thinkingEffortSupported: true, thinkingLevels: ["low", "medium", "high"],
      thinkingMapping: { low: { my_knob: "low" } },
    });
  });

  it("drops transport fields — routing stays registry-owned", async () => {
    // The row is the capability answer. How a request reaches the upstream
    // (target format, upstream id, supported formats, strip list, quota family,
    // provider quirks) is the registry's to carry, and a row that carried it
    // would make the executor/translator choice depend on stored state — while
    // nothing at request time reads it, so it would be saved decoration.
    await upsertModelConfig({
      providerAlias: PROBE, id: "t-transport",
      caps: {
        vision: true,
        targetFormat: "claude", upstreamModelId: "u", supportedFormats: ["openai"],
        strip: ["reasoning_effort"], quotaFamily: "plan", quirks: { forceStream: true },
      },
    });
    expect(getStoredConfig(PROBE, "t-transport").caps).toEqual({ vision: true });
  });

  it("merges patches without clobbering unrelated fields", async () => {
    await upsertModelConfig({ providerAlias: PROBE, id: "t-legacy", caps: { vision: true, contextWindow: 500000 } });
    await upsertModelConfig({ providerAlias: PROBE, id: "t-legacy", caps: { contextWindow: 1000000, pdf: true } });
    expect(getStoredConfig(PROBE, "t-legacy").caps).toEqual({ vision: true, contextWindow: 1000000, pdf: true });
  });

  it("treats null as delete, so a field can be turned back off", async () => {
    await upsertModelConfig({ providerAlias: PROBE, id: "t-nulls", caps: { vision: true, contextWindow: 500000, pdf: true, thinkingFormat: "step" } });
    await upsertModelConfig({ providerAlias: PROBE, id: "t-nulls", caps: { contextWindow: null } });
    expect(getStoredConfig(PROBE, "t-nulls").caps).toEqual({ vision: true, pdf: true, thinkingFormat: "step" });
    // Deleting every field removes the caps block but keeps the row, so the
    // operator's registration and its provenance survive.
    await upsertModelConfig({ providerAlias: PROBE, id: "t-nulls", caps: { vision: null, pdf: null, thinkingFormat: null } });
    const row = getStoredConfig(PROBE, "t-nulls");
    expect(row).toMatchObject({ id: "t-nulls", source: "operator" });
    expect(row.caps).toBeUndefined();
  });

  it("marks provider-supplied rows as read-only until unlocked", async () => {
    await upsertModelConfig({ providerAlias: PROBE, id: "t-locked", source: "provider", caps: { contextLength: 256000 } });
    const locked = getStoredConfig(PROBE, "t-locked");
    expect(locked.source).toBe("provider");
    expect(isConfigLocked(locked)).toBe(true);
    // Unlocking is an explicit act that re-stamps provenance.
    await upsertModelConfig({ providerAlias: PROBE, id: "t-locked", source: "operator", caps: { contextWindow: 256000 } });
    const unlocked = getStoredConfig(PROBE, "t-locked");
    expect(isConfigLocked(unlocked)).toBe(false);
  });

  it("lifts a legacy row without touching the original", async () => {
    const legacy = { providerAlias: PROBE, id: "t-lift", type: "llm", name: "t-lift", caps: { vision: true } };
    expect(await importLegacyCustomModel(legacy)).toBe("imported");
    // The lifted row inherits operator provenance — a legacy caps patch only
    // ever existed because an operator set it by hand.
    expect(getStoredConfig(PROBE, "t-lift").source).toBe("operator");
    // A second import is refused rather than overwriting what is now stored.
    expect(await importLegacyCustomModel({ ...legacy, caps: { vision: false } })).toBe("skipped-existing");
    expect(getStoredConfig(PROBE, "t-lift").caps.vision).toBe(true);
    expect(await importLegacyCustomModel({ providerAlias: PROBE })).toBe("skipped-invalid");
  });

  it("drops unknown, ill-typed and out-of-range fields instead of storing them", () => {
    const c = sanitizeModelConfig({
      providerAlias: "p", id: "m",
      caps: {
        vision: true, contextWindow: -5, maxOutput: 0, thinkingFormat: "bogus",
        thinkingLevels: ["low", "nope"], search: "yes", targetFormat: 42,
        thinkingRange: { min: 1024, max: -1 }, unknownField: "x",
        upstreamModelId: "u", quirks: { forceStream: true },
      },
    });
    expect(c.caps).toEqual({ vision: true, thinkingLevels: ["low"], thinkingRange: { min: 1024 } });
  });

  it("requires identity and defaults provenance to operator", () => {
    expect(sanitizeModelConfig({ providerAlias: "p" })).toBeNull();
    expect(sanitizeModelConfig({ id: "m" })).toBeNull();
    expect(sanitizeModelConfig(null)).toBeNull();
    expect(sanitizeModelConfig({ providerAlias: "p", id: "m" }).source).toBe("operator");
    expect(sanitizeModelConfig({ providerAlias: "p", id: "m", source: "nonsense" }).source).toBe("operator");
    expect(inferSource(null)).toBe("builtin");
    expect(inferSource({})).toBe("builtin");
    expect(inferSource({ vision: true })).toBe("operator");
  });
});
