// WorkBuddy executor behavior: stream forcing, role/message normalization, and
// the per-account device headers. The message rules mirror what the live gateway
// enforces (messages[0] must be system; `developer` is rejected outright).
import { describe, it, expect } from "vitest";
import { WorkBuddyExecutor, deriveWorkBuddyDeviceHeaders } from "../../open-sse/executors/workbuddy.js";

const exec = new WorkBuddyExecutor();

// Invoke transformRequest on the real instance (so super.* resolves normally)
// with a non-stream client body, which is the case that exercises the forcing.
const transform = (body) => exec.transformRequest("glm-5.2", body, false, {});

describe("WorkBuddyExecutor.transformRequest", () => {
  it("forces stream even when the client asked for a non-stream reply", () => {
    const out = transform({ messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], stream: false });
    expect(out.stream).toBe(true);
  });

  it("prepends a system message when the first message is not system", () => {
    const out = transform({ messages: [{ role: "user", content: "hello" }] });
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("prepends a system message when the message list is empty", () => {
    const out = transform({ messages: [] });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe("system");
  });

  it("leaves an existing leading system message untouched and keeps order", () => {
    const out = transform({ messages: [{ role: "system", content: "keep me" }, { role: "user", content: "u" }] });
    expect(out.messages[0]).toEqual({ role: "system", content: "keep me" });
    expect(out.messages).toHaveLength(2);
  });

  it("downgrades developer to system instead of dropping its content", () => {
    const out = transform({ messages: [{ role: "developer", content: "dev rules" }, { role: "user", content: "u" }] });
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content).toBe("dev rules");
  });

  it("neutralizes an agent-identity system prompt", () => {
    const out = transform({
      messages: [{ role: "system", content: "You are Claude Code, Anthropic's official CLI tool for Claude." }, { role: "user", content: "u" }],
    });
    expect(out.messages[0].content).not.toContain("Claude Code");
    expect(out.messages[0].content).toContain("helpful AI assistant");
  });

  it("neutralizes an oversized system prompt", () => {
    const out = transform({ messages: [{ role: "system", content: "x".repeat(2500) }, { role: "user", content: "u" }] });
    expect(out.messages[0].content).toContain("helpful AI assistant");
  });

  it("preserves typed-block shape when replacing content", () => {
    const out = transform({
      messages: [{ role: "system", content: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI tool." }] }, { role: "user", content: "u" }],
    });
    expect(Array.isArray(out.messages[0].content)).toBe(true);
    expect(out.messages[0].content[0].text).toContain("helpful AI assistant");
  });

  it("keeps a legitimate short system prompt as-is", () => {
    const out = transform({ messages: [{ role: "system", content: "Always answer in French." }, { role: "user", content: "u" }] });
    expect(out.messages[0].content).toBe("Always answer in French.");
  });

  it("drops reasoning_effort when thinking is explicitly off", () => {
    const out = transform({ messages: [{ role: "system", content: "s" }], reasoning_effort: "none" });
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("adds reasoning_summary when reasoning is requested", () => {
    const out = transform({ messages: [{ role: "system", content: "s" }], reasoning_effort: "high" });
    expect(out.reasoning_effort).toBe("high");
    expect(out.reasoning_summary).toBe("auto");
  });

  it("leaves reasoning params unset when the client asked for none", () => {
    const out = transform({ messages: [{ role: "system", content: "s" }] });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning_summary).toBeUndefined();
  });
});

describe("deriveWorkBuddyDeviceHeaders", () => {
  it("derives stable machine/session ids from the uid", () => {
    const h = deriveWorkBuddyDeviceHeaders({ uid: "user-1" }, "conn-1");
    expect(h["X-Machine-ID"]).toMatch(/^[0-9a-f]{36}$/);
    expect(h["X-Session-ID"]).toMatch(/^[0-9a-f]{36}$/);
    expect(h["X-Machine-ID"]).not.toBe(h["X-Session-ID"]);
    expect(h["X-User-Id"]).toBe("user-1");
  });

  it("is deterministic across calls", () => {
    const a = deriveWorkBuddyDeviceHeaders({ uid: "user-1" }, "conn-1");
    const b = deriveWorkBuddyDeviceHeaders({ uid: "user-1" }, "conn-1");
    expect(a).toEqual(b);
  });

  it("differs between accounts", () => {
    const a = deriveWorkBuddyDeviceHeaders({ uid: "user-1" }, "conn-1");
    const b = deriveWorkBuddyDeviceHeaders({ uid: "user-2" }, "conn-2");
    expect(a["X-Machine-ID"]).not.toBe(b["X-Machine-ID"]);
  });

  it("falls back to connectionId when no uid is stored", () => {
    const h = deriveWorkBuddyDeviceHeaders({}, "conn-9");
    expect(h["X-Machine-ID"]).toMatch(/^[0-9a-f]{36}$/);
    expect(h["X-User-Id"]).toBeUndefined();
  });

  it("omits device headers entirely when there is no seed", () => {
    expect(deriveWorkBuddyDeviceHeaders({}, null)).toEqual({});
  });

  it("sends the device token only when configured", () => {
    expect(deriveWorkBuddyDeviceHeaders({ uid: "u" }, "c")["X-Device-Token"]).toBeUndefined();
    expect(deriveWorkBuddyDeviceHeaders({ uid: "u", deviceToken: "tok" }, "c")["X-Device-Token"]).toBe("tok");
  });

  it("switches to X-Enterprise-Id (and drops the opt-out) when one is stored", () => {
    const h = deriveWorkBuddyDeviceHeaders({ uid: "u", enterpriseId: "ent-1" }, "c");
    expect(h["X-Enterprise-Id"]).toBe("ent-1");
    expect(h["X-No-Enterprise-Id"]).toBeNull();
  });
});
