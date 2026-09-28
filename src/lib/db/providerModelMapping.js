// Map a provider's per-model config, as returned by its /models endpoint, into
// the unified model-config schema.
//
// Providers describe the same facts with different field names — zed says
// `contextLength`/`maxOutputTokens`/`supportedEffortLevels`, qoder says
// `contextLength`/`isVL`/`isReasoning`/`maxOutputTokens`, kiro says
// `contextLength`/`capabilities`, github says `capabilities`/`version` — and
// until now every import path kept the id and threw the rest away, so a model's
// real limits were lost the moment it was added and the gateway fell back to
// guessing from the model name.
//
// The mapping is deliberately conservative: anything not recognized is dropped
// rather than guessed, and an empty result means "this provider told us nothing
// about this model", which the caller can act on.

import { sanitizeCaps } from "./modelConfigSchema.js";

// Only the capability fields a provider plausibly reports and the schema can
// carry. A capability the provider did not mention stays absent, so the
// built-in tables still fill it — importing must never overwrite a model's
// real behaviour with a partial view. Transport (target format, upstream id,
// supported formats, strip list, quota family, provider quirks) is deliberately
// not mapped even when a provider names one of our own field names: routing is
// the registry's to carry, and a row that overrode it would make the executor
// choice depend on stored state.
const KNOWN = new Set([
  "vision", "pdf", "audioInput", "videoInput", "imageOutput", "audioOutput",
  "search", "tools", "reasoning",
  "contextWindow", "maxOutput",
  "thinkingFormat", "thinkingCanDisable", "thinkingRange",
  "thinkingEffortSupported", "thinkingLevels", "thinkingMapping",
]);

// Effort levels a provider reports, normalized to the schema's vocabulary.
// Different vendors name the same tier differently; the unified picker speaks
// one vocabulary, so map on the way in rather than teaching every consumer.
const EFFORT_ALIASES = {
  minimal: "minimal", low: "low", medium: "medium", high: "high",
  xhigh: "xhigh", max: "max", ultra: "ultra",
  off: "none", none: "none", disabled: "none",
};

function positiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function boolOrUndefined(v) {
  if (v === true || v === false) return v;
  return undefined;
}

function levelsFromEffort(v) {
  if (typeof v === "string") {
    const mapped = EFFORT_ALIASES[v.toLowerCase()];
    return mapped ? [mapped] : undefined;
  }
  if (Array.isArray(v)) {
    const mapped = v
      .map((x) => (typeof x === "string" ? EFFORT_ALIASES[x.toLowerCase()] : undefined))
      .filter(Boolean);
    return mapped.length ? [...new Set(mapped)] : undefined;
  }
  return undefined;
}

/**
 * Translate one provider model entry into a caps patch for the unified store.
 *
 * @param {object} model the entry as the provider's /models endpoint returned it
 * @returns {{caps: object, id: string}|null} null when the entry carries no id
 */
export function mapProviderModelConfig(model) {
  if (!model || typeof model !== "object") return null;
  const id = model.id || model.name || model.model || model.modelId;
  if (!id || typeof id !== "string") return null;

  const out = {};

  // ── Limits. Every provider that publishes a length calls it something. ──
  const contextWindow = positiveInt(model.contextLength ?? model.contextWindow ?? model.context_length ?? model.maxContextTokens);
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  const maxOutput = positiveInt(model.maxOutputTokens ?? model.maxOutput ?? model.max_output_tokens ?? model.maxCompletionTokens);
  if (maxOutput !== undefined) out.maxOutput = maxOutput;

  // ── Reasoning. Zed's `supportsDisablingThinking` is the only explicit
  //    "can be turned off" signal any provider publishes; `supportsThinking`
  //    only says the model thinks, which the tables already infer.
  const reasoning = boolOrUndefined(model.isReasoning ?? model.supportsThinking ?? model.reasoning);
  if (reasoning !== undefined) out.reasoning = reasoning;
  const canDisable = boolOrUndefined(model.supportsDisablingThinking);
  if (canDisable !== undefined) out.thinkingCanDisable = canDisable;
  const levels = levelsFromEffort(model.supportedEffortLevels ?? model.supportedEfforts ?? model.effortLevels);
  if (levels) out.thinkingLevels = levels;

  // ── Modalities. zed's `supportsImages` is the clearest; qoder's `isVL`;
  //    github/kiro publish a `capabilities` object instead.
  const vision = boolOrUndefined(model.supportsImages ?? model.isVL ?? model.vision);
  if (vision !== undefined) out.vision = vision;

  // Tool calling: zed says `supportsTools`. A provider that does not mention it
  // is not saying "no tools", so this stays absent unless stated.
  const tools = boolOrUndefined(model.supportsTools ?? model.tools);
  if (tools !== undefined) out.tools = tools;

  const caps = model.capabilities;
  if (caps && typeof caps === "object" && !Array.isArray(caps)) {
    const capMap = {
      image: "vision", images: "vision", vision: "vision",
      audio: "audioInput", audioInput: "audioInput",
      video: "videoInput", videoInput: "videoInput",
      pdf: "pdf", document: "pdf",
      tool: "tools", tools: "tools", functionCalling: "tools",
      search: "search", webSearch: "search",
    };
    for (const [rawKey, value] of Object.entries(caps)) {
      const key = capMap[rawKey] || capMap[rawKey.toLowerCase()];
      if (!key) continue;
      // Some providers publish the value as a nested object (`{supported:true}`);
      // unwrap the common shapes before reading the boolean.
      const v = typeof value === "object" && value !== null
        ? boolOrUndefined(value.supported ?? value.enabled)
        : boolOrUndefined(value);
      if (v !== undefined && out[key] === undefined) out[key] = v;
    }
  }

  // ── Anything the provider already names with our own field names ──
  for (const key of Object.keys(model)) {
    if (!KNOWN.has(key)) continue;
    if (out[key] !== undefined) continue;
    const value = model[key];
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      // Only copy a limit when it is a sane positive number; a provider that
      // reports 0 means "unknown", not "zero tokens".
      if (key === "contextWindow" || key === "maxOutput") {
        const n = positiveInt(value);
        if (n !== undefined) out[key] = n;
        continue;
      }
      out[key] = value;
    }
  }

  const capsPatch = sanitizeCaps(out);
  return { id, caps: capsPatch || {} };
}

/**
 * Merge several provider entries into the shape a config row needs.
 * @param {object[]} models
 * @returns {Array<{id: string, caps: object}>}
 */
export function mapProviderModels(models) {
  if (!Array.isArray(models)) return [];
  return models.map(mapProviderModelConfig).filter(Boolean);
}
