import { describe, it, expect } from "vitest";
import { formatProviderError } from "../../open-sse/utils/error.js";

describe("formatProviderError", () => {
  it("names the provider and model the request was for", () => {
    // A single-account install whose upstream is down gets exactly this string
    // back from the client — it has to say whose upstream, not just that a
    // fetch failed.
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:443" } });

    expect(formatProviderError(err, "workbuddy", "primary-model", 502))
      .toBe("[502] workbuddy/primary-model: fetch failed (cause: ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:443)");
  });

  it("keeps the old shape when the caller has no location to report", () => {
    expect(formatProviderError(new Error("boom"), null, null, 500)).toBe("[500]: boom");
  });

  it("falls back to the error's own code when no status is given", () => {
    const err = Object.assign(new Error("socket closed"), { code: "STREAM_ERROR" });
    expect(formatProviderError(err, "codex", "gpt-6-astra")).toBe("[STREAM_ERROR] codex/gpt-6-astra: socket closed");
  });
});
