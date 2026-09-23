import { afterEach, describe, expect, it } from "vitest";
import { setCustomCapsSource } from "../../open-sse/providers/capabilities.js";
import { applyThinking, extractThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { fmtThink, fmtThinkReport } from "../../src/sse/utils/logger.js";

// A user-added node whose model id matches no built-in pattern — the case where
// an operator supplies a thinking mapping because the upstream's field names
// match no format the gateway knows.
const NODE = "openai-compatible-chat-logreport";
const MODEL = "my-private-model";

function declare(caps) {
  setCustomCapsSource({ getCaps: (p, m) => (p === NODE && m === MODEL ? caps : null) });
}

afterEach(() => setCustomCapsSource(null));

describe("thinking apply report", () => {
  it("records the fields a declared mapping wrote", () => {
    declare({
      reasoning: true,
      thinkingFormat: "openai",
      thinkingLevels: ["low", "high"],
      thinkingMapping: {
        low: { reasoning: { effort: "low" }, reasoning_effort: "low" },
        high: { reasoning: { effort: "high" }, reasoning_effort: "high" },
      },
    });

    const body = {};
    const report = {};
    applyThinking("openai", MODEL, body, NODE, { mode: "level", level: "low" }, report);

    expect(report.level).toBe("low");
    expect(report.fields).toEqual([
      { name: "reasoning", value: { effort: "low" } },
      { name: "reasoning_effort", value: "low" },
    ]);
  });

  it("records the off switch as the disabled level", () => {
    declare({
      reasoning: true,
      thinkingFormat: "openai",
      thinkingMapping: { disabled: { enable_thinking: false } },
    });

    const report = {};
    applyThinking("openai", MODEL, {}, NODE, { mode: "none" }, report);

    expect(report.level).toBe("disabled");
    expect(report.fields).toEqual([{ name: "enable_thinking", value: false }]);
  });

  it("stays empty for built-in formats, where the body is readable", () => {
    // deepseek's built-in shape writes reasoning_effort, so extractThinking can
    // read the level back and no report is needed.
    const report = {};
    applyThinking("openai", "deepseek-reasoner", {}, "deepseek", { mode: "level", level: "low" }, report);
    expect(report).toEqual({});
  });

  it("stays empty when the mapping omits the requested level", () => {
    // Falling through to the format default means the body IS readable, so the
    // report must not claim a custom shape was applied.
    declare({
      reasoning: true,
      thinkingFormat: "openai",
      thinkingLevels: ["low", "high"],
      thinkingMapping: { low: { reasoning_effort: "custom-low" } },
    });

    const body = {};
    const report = {};
    applyThinking("openai", MODEL, body, NODE, { mode: "level", level: "high" }, report);

    expect(report).toEqual({});
    expect(body.reasoning_effort).toBe("high");
  });

  it("stays empty for a model that cannot reason", () => {
    declare({ reasoning: false });
    const report = {};
    applyThinking("openai", MODEL, {}, NODE, { mode: "level", level: "low" }, report);
    expect(report).toEqual({});
  });

  it("is optional — callers that pass no report still work", () => {
    declare({
      reasoning: true,
      thinkingFormat: "openai",
      thinkingMapping: { low: { reasoning_effort: "low" } },
    });
    const body = {};
    expect(() => applyThinking("openai", MODEL, body, NODE, { mode: "level", level: "low" })).not.toThrow();
    expect(body.reasoning_effort).toBe("low");
  });
});

describe("fmtThinkReport", () => {
  it("describes the level and the fields actually written", () => {
    const line = fmtThinkReport({
      level: "low",
      fields: [{ name: "reasoning_effort", value: "low" }, { name: "thinking", value: { type: "enabled" } }],
    });
    expect(line).toBe('low (custom: reasoning_effort="low", thinking={"type":"enabled"})');
  });

  it("renders the off switch as off, matching fmtThink's vocabulary", () => {
    expect(fmtThinkReport({ level: "disabled", fields: [{ name: "enable_thinking", value: false }] }))
      .toBe("off (custom: enable_thinking=false)");
  });

  it("returns null when there is nothing to report", () => {
    expect(fmtThinkReport(null)).toBeNull();
    expect(fmtThinkReport({})).toBeNull();
    expect(fmtThinkReport({ level: "low", fields: [] })).toBeNull();
  });

  it("caps the field list so a huge fragment cannot flood one log line", () => {
    const line = fmtThinkReport({
      level: "high",
      fields: [{ name: "blob", value: "x".repeat(500) }],
    });
    // The value is cut mid-JSON and the wrapper still closes — a log line only
    // needs to be identifiable, not parseable.
    expect(line.length).toBeLessThan(200);
    expect(line).toContain("…");
    expect(line.startsWith("high (custom: blob=")).toBe(true);
    expect(line.endsWith(")")).toBe(true);
  });

  it("does not throw on a value JSON cannot represent", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    const line = fmtThinkReport({ level: "low", fields: [{ name: "loop", value: cyclic }] });
    expect(line).toContain("loop=");
  });
});

describe("the two formatters together", () => {
  it("covers the gap: a custom shape is invisible to extractThinking but still logged", () => {
    declare({
      reasoning: true,
      thinkingFormat: "openai",
      thinkingLevels: ["low"],
      thinkingMapping: { low: { my_own_knob: "low" } },
    });

    const body = {};
    const report = {};
    applyThinking("openai", MODEL, body, NODE, { mode: "level", level: "low" }, report);

    // The mapping wrote a field name no extractor recognises...
    expect(body).toEqual({ my_own_knob: "low" });
    expect(extractThinking(body)).toBeNull();
    expect(fmtThink(extractThinking(body))).toBeNull();

    // ...so the log line falls back to the apply-site report instead of
    // silently dropping THINK, which would imply thinking was never set.
    expect(fmtThinkReport(report)).toBe('low (custom: my_own_knob="low")');
  });
});
