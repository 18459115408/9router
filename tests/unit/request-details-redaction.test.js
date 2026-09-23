import { describe, it, expect } from "vitest";
import { redactRequestDetails, REDACTED_PAYLOAD_KEYS } from "@/lib/requestDetailsRedaction.js";

describe("request-details redaction", () => {
  it("removes conversation payloads but keeps metadata", () => {
    const details = [{
      id: "abc",
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      timestamp: "2026-08-05T00:00:00Z",
      status: "success",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      request: { messages: [{ role: "user", content: "secret prompt" }] },
      providerRequest: { messages: [{ role: "user", content: "secret prompt" }] },
      providerResponse: { choices: [{ message: { content: "secret answer" } }] },
      response: { content: "secret answer" },
    }];
    const out = redactRequestDetails(details)[0];
    expect(out.id).toBe("abc");
    expect(out.provider).toBe("opencode");
    expect(out.model).toBe("deepseek-v4-flash-free");
    expect(out.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(out.request).toEqual({ redacted: true });
    expect(out.providerRequest).toEqual({ redacted: true });
    expect(out.providerResponse).toEqual({ redacted: true });
    expect(out.response).toEqual({ redacted: true });
  });

  it("redacts every key in REDACTED_PAYLOAD_KEYS", () => {
    const details = [Object.fromEntries(REDACTED_PAYLOAD_KEYS.map((k) => [k, { secret: "x" }]))];
    const out = redactRequestDetails(details)[0];
    for (const key of REDACTED_PAYLOAD_KEYS) {
      expect(out[key]).toEqual({ redacted: true });
    }
  });

  it("handles empty details", () => {
    expect(redactRequestDetails([])).toEqual([]);
    expect(redactRequestDetails(null)).toEqual([]);
  });

  it("keeps non-sensitive fields untouched", () => {
    const details = [{ id: "x", status: "error", latency: { total: 100 } }];
    const out = redactRequestDetails(details)[0];
    expect(out.id).toBe("x");
    expect(out.status).toBe("error");
    expect(out.latency).toEqual({ total: 100 });
  });

  it("returns payloads intact when redaction is disabled", () => {
    const details = [{
      id: "abc",
      request: { messages: [{ role: "user", content: "secret prompt" }] },
      response: { content: "secret answer" },
    }];
    const out = redactRequestDetails(details, { redact: false })[0];
    expect(out.request).toEqual({ messages: [{ role: "user", content: "secret prompt" }] });
    expect(out.response).toEqual({ content: "secret answer" });
  });

  it("does not mutate the input rows", () => {
    const details = [{ id: "abc", request: { messages: ["secret"] } }];
    redactRequestDetails(details);
    expect(details[0].request).toEqual({ messages: ["secret"] });
  });
});
