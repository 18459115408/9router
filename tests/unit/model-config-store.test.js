import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getModelConfigs, getStoredConfig, refreshModelConfigs,
  upsertModelConfig, importLegacyCustomModel, liftLegacyRows, __resetModelConfigForTest,
} from "../../src/lib/db/repos/modelConfigRepo.js";
import { sanitizeModelConfig, isConfigLocked, inferSource } from "../../src/lib/db/modelConfigSchema.js";
import { __resetFakeDb } from "../helpers/fakeDb.js";

// The store runs against an in-memory DB. Rows each test needs are seeded here
// rather than read off this machine's ~/.9router, so the file passes on a fresh
// install, in CI, and when vitest runs it in parallel with its siblings — the
// shared live file used to make this suite both machine-dependent and flaky
// (SQLITE_BUSY), and an interrupted run left permanent rows behind.
vi.mock("@/lib/db/driver.js", () => import("../helpers/fakeDb.js"));

const SF = "openai-compatible-chat-0dcce5df-5d45-4c99-ae90-52ecefab4955";
const PROBE = "vitest-probe";

describe("unified model-config store", () => {
  beforeEach(async () => {
    __resetFakeDb();
    __resetModelConfigForTest();
    await refreshModelConfigs();
  });

  it("holds one row per model, with the caps the operator set and their provenance", async () => {
    // Seeded the way the migration lifts legacy rows: a caps patch becomes
    // operator-owned, a registration with no caps becomes builtin.
    await importLegacyCustomModel({ providerAlias: SF, id: "step-5-preview", type: "llm", caps: { vision: true, reasoning: true } });
    await importLegacyCustomModel({ providerAlias: "ds", id: "deepseek-flash", type: "llm", caps: { vision: true, reasoning: true } });
    await importLegacyCustomModel({ providerAlias: "cl", id: "deepseek/deepseek-v4.1-flash", type: "llm" });

    const all = await getModelConfigs();
    expect(Object.keys(all).length).toBe(3);
    expect(getStoredConfig(SF, "step-5-preview")).toMatchObject({
      id: "step-5-preview", type: "llm", source: "operator",
      caps: { vision: true, reasoning: true },
    });
    expect(getStoredConfig("ds", "deepseek-flash").caps).toEqual({ vision: true, reasoning: true });
    // Rows with no caps became builtin-provenance registrations.
    expect(getStoredConfig("cl", "deepseek/deepseek-v4.1-flash").source).toBe("builtin");
  });

  it("resolves across vendor prefixes, case, and :suffixes", async () => {
    await upsertModelConfig({ providerAlias: "ds", id: "deepseek-flash", caps: { vision: true } });
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

  it("lifts every legacy row on the first boot, then stops", async () => {
    const legacy = [
      { providerAlias: PROBE, id: "t-lift-a", type: "llm", caps: { vision: true } },
      { providerAlias: PROBE, id: "t-lift-b", type: "llm", caps: { reasoning: true } },
    ];
    expect(await liftLegacyRows(legacy)).toMatchObject({ imported: 2, skippedMarker: false });
    expect(getStoredConfig(PROBE, "t-lift-a").caps).toEqual({ vision: true });

    // The marker is set, so a later boot with more rows copies nothing: an
    // operator who deletes a lifted row is not resurrected by the next boot.
    expect(await liftLegacyRows([{ providerAlias: PROBE, id: "t-lift-c", type: "llm", caps: { vision: true } }]))
      .toMatchObject({ imported: 0, skippedMarker: true });
    expect(getStoredConfig(PROBE, "t-lift-c")).toBeNull();

    // A fresh database where the row was already edited here: the lift must not
    // drag the stale legacy copy back over the operator's correction.
    __resetFakeDb();
    __resetModelConfigForTest();
    await refreshModelConfigs();
    await upsertModelConfig({ providerAlias: PROBE, id: "t-lift-a", caps: { contextWindow: 999999 } });
    await liftLegacyRows([{ providerAlias: PROBE, id: "t-lift-a", type: "llm", caps: { vision: true, contextWindow: 1 } }]);
    expect(getStoredConfig(PROBE, "t-lift-a").caps).toEqual({ contextWindow: 999999 });
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
