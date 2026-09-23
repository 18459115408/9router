import { afterEach, describe, expect, it } from "vitest";
import { getCapabilitiesForModel, setCustomCapsSource } from "../../open-sse/providers/capabilities.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";

// A user-added OpenAI-compatible node. Its id is a UUID-ish string the
// hand-written capability tables cannot know about, which is exactly the case
// the declaration exists for.
const NODE = "openai-compatible-chat-0dcce5df-5d45-4c99-ae90-52ecefab4955";
const MODEL = "step-5-preview";

const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function imageBody() {
  return {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "what colour is this?" },
        { type: "image_url", image_url: { url: IMAGE } },
      ],
    }],
  };
}

function imageSurvives(provider, model) {
  const body = imageBody();
  const caps = getCapabilitiesForModel(provider, model);
  stripUnsupportedModalities(body, "openai", caps);
  return body.messages[0].content.some((b) => b.type === "image_url");
}

afterEach(() => setCustomCapsSource(null));

describe("declared capabilities on custom models", () => {
  it("leaves an unknown model text-only until something declares otherwise", () => {
    expect(getCapabilitiesForModel(NODE, MODEL).vision).toBe(false);
    expect(imageSurvives(NODE, MODEL)).toBe(false);
  });

  it("keeps the image when the operator declares vision", () => {
    setCustomCapsSource({ getCaps: (p, m) => (p === NODE && m === MODEL ? { vision: true } : null) });
    expect(getCapabilitiesForModel(NODE, MODEL).vision).toBe(true);
    expect(imageSurvives(NODE, MODEL)).toBe(true);
  });

  it("scopes a declaration to its own provider+model", () => {
    setCustomCapsSource({ getCaps: (p, m) => (p === NODE && m === MODEL ? { vision: true } : null) });
    // same model id, different node
    expect(getCapabilitiesForModel("openai-compatible-chat-other", MODEL).vision).toBe(false);
    // same node, different model
    expect(getCapabilitiesForModel(NODE, "step-3.5-flash").vision).toBe(false);
  });

  it("is additive — a declaration can never turn a capability off", () => {
    // A model the tables already know is vision-capable must stay that way even
    // if a stale declaration says false; otherwise a mis-click in the dashboard
    // would silently start stripping images.
    setCustomCapsSource({ getCaps: () => ({ vision: false }) });
    expect(getCapabilitiesForModel("xiaomi-mimo", "mimo-v2.6-flash").vision).toBe(true);
    expect(imageSurvives("xiaomi-mimo", "mimo-v2.6-flash")).toBe(true);
  });

  it("applies on the provider-override and canonical-exact short-circuit paths too", () => {
    // PROVIDER_CAPABILITIES hit (step 1 of the chain)
    setCustomCapsSource({ getCaps: (p, m) => (p === "codex" && m === "gpt-5.6-sol" ? { vision: true } : null) });
    expect(getCapabilitiesForModel("codex", "gpt-5.6-sol").vision).toBe(true);
    // MODEL_CAPABILITIES hit (step 2)
    setCustomCapsSource({ getCaps: (p, m) => (p === "anything" && m === "claude-opus-5" ? { vision: true } : null) });
    expect(getCapabilitiesForModel("anything", "claude-opus-5").vision).toBe(true);
  });

  it("matches the model id the same way the rest of the resolver does", () => {
    // vendor-prefixed ids normalize to their base id
    setCustomCapsSource({ getCaps: (p, m) => (m === "step-5-preview" ? { vision: true } : null) });
    expect(getCapabilitiesForModel(NODE, "stepfun/step-5-preview").vision).toBe(true);
    // a null provider must not throw
    expect(() => getCapabilitiesForModel(null, MODEL)).not.toThrow();
  });

  it("also honours the media capabilities the stripper gates on", () => {
    setCustomCapsSource({ getCaps: () => ({ pdf: true, audioInput: true }) });
    const caps = getCapabilitiesForModel(NODE, MODEL);
    expect(caps.pdf).toBe(true);
    expect(caps.audioInput).toBe(true);
  });

  it("falls back to the plain tables once the source is uninstalled", () => {
    setCustomCapsSource({ getCaps: () => ({ vision: true }) });
    expect(getCapabilitiesForModel(NODE, MODEL).vision).toBe(true);
    setCustomCapsSource(null);
    expect(getCapabilitiesForModel(NODE, MODEL).vision).toBe(false);
  });
});
