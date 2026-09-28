// Unified model-config schema: the single persisted representation of what the
// gateway knows about one (provider, model) pair.
//
// Before this module, model config lived in five places at once — the
// capabilities tables, the registry `models` arrays, the pricing tables, the
// synced models.dev catalog, and an operator's `customModels.caps` patch — and
// the request path re-resolved all five on every call. This schema is the one
// row that carries the whole answer, so `loadModelConfig()` can hand back a
// complete config from a single lookup.
//
// The row is the capability answer: what the model can do and how it thinks.
// How a request REACHES the upstream (target format, upstream id, supported
// formats, strip list, quota family, provider quirks) is not here — that is
// transport knowledge the registry already carries per model, and a
// model-config row overriding it would make the executor/translator choice
// depend on stored state. An operator who needs to correct routing edits the
// registry, where the value is read.
//
// Provenance is part of the row, not metadata beside it: `source` decides
// whether the dashboard lets the row be edited (a provider-supplied config is
// shown but locked) and `locked` is derived from it, never stored independently.

// ── Capability fields ────────────────────────────────────────────────────
// Input/output modalities and the model's feature surface. All optional; an
// absent field means "no opinion" and falls back to the built-in tables.
export const MODALITY_KEYS = ["vision", "pdf", "audioInput", "videoInput", "imageOutput", "audioOutput"];

// Feature flags beyond modality. `tools` is the only one that can be turned off
// meaningfully (`MODEL_CAPABILITIES` sets it false for embedding/image models).
export const FEATURE_KEYS = ["search", "tools"];

// ── Thinking fields ──────────────────────────────────────────────────────
// Wire shape plus the limits that constrain it. Mirrors the enum in
// capabilities.js and the cases in thinkingUnified.applyFormat — an unknown
// format would silently fall through to a generic shape, so it is dropped.
export const THINKING_FORMATS = [
  "openai", "claude-adaptive", "claude-budget", "gemini-level", "gemini-budget",
  "zai", "qwen", "deepseek", "kimi", "minimax", "hunyuan", "step", "commandcode",
];

// Levels a row may list, low→high. "none" is the off switch and is offered
// separately by the UI; "auto" means "let the client decide".
export const THINKING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

// ── Limit fields ─────────────────────────────────────────────────────────
export const LIMIT_KEYS = ["contextWindow", "maxOutput"];

// Every capability key a row may carry — the superset of
// capabilities.DECLARABLE_KEYS (which only covered the modality flags the
// strip path gates on) and the four thinking fields.
export const ALL_CAPABILITY_KEYS = [
  "reasoning",
  ...MODALITY_KEYS,
  ...FEATURE_KEYS,
  ...LIMIT_KEYS,
  "thinkingFormat", "thinkingCanDisable", "thinkingRange",
  "thinkingEffortSupported", "thinkingLevels", "thinkingMapping",
];

export const CONFIG_SOURCES = ["builtin", "provider", "operator"];

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// Keep only the keys this schema recognizes, with the right shape for each.
// Unknown keys are dropped rather than forwarded: a typo or a stale field from
// an older build must not silently become part of a row that now wins over the
// built-in tables outright.
//
// `null` is passed through untouched for every key it may name. It is not a
// value — it is the delete signal mergeCaps consumes, so dropping it here
// would make "turn this setting back off" impossible for any field the patch
// does not name with a real value. Only `null` survives; `undefined` is the
// "leave alone" signal and stays dropped.
// Exported so providerModelMapping can reuse the same field validation instead
// of growing a second, drifting copy.
export function sanitizeCaps(raw) {
  if (!isPlainObject(raw)) return null;
  const out = {};

  // Booleans: modality flags, feature flags, reasoning, thinkingCanDisable,
  // thinkingEffortSupported.
  for (const k of ["reasoning", ...MODALITY_KEYS, ...FEATURE_KEYS, "thinkingCanDisable", "thinkingEffortSupported"]) {
    if (raw[k] === null) out[k] = null;
    else if (typeof raw[k] === "boolean") out[k] = raw[k];
  }

  // Thinking wire shape.
  if (raw.thinkingFormat === null) out.thinkingFormat = null;
  else if (typeof raw.thinkingFormat === "string" && THINKING_FORMATS.includes(raw.thinkingFormat)) {
    out.thinkingFormat = raw.thinkingFormat;
  }
  if (raw.thinkingLevels === null) out.thinkingLevels = null;
  else if (Array.isArray(raw.thinkingLevels)) {
    const levels = raw.thinkingLevels.filter((l) => typeof l === "string" && THINKING_LEVELS.includes(l));
    if (levels.length) out.thinkingLevels = levels;
  }
  if (raw.thinkingRange === null) out.thinkingRange = null;
  else if (isPlainObject(raw.thinkingRange)) {
    const min = Number(raw.thinkingRange.min);
    const max = Number(raw.thinkingRange.max);
    const range = {};
    if (Number.isFinite(min) && min > 0) range.min = min;
    if (Number.isFinite(max) && max > 0) range.max = max;
    if (range.min !== undefined || range.max !== undefined) out.thinkingRange = range;
  }
  if (raw.thinkingMapping === null) out.thinkingMapping = null;
  else if (isPlainObject(raw.thinkingMapping)) {
    // Keep only string→object entries; the apply site iterates the fragment's
    // keys onto the wire body, so a non-object fragment is meaningless.
    const clean = {};
    for (const [level, fragment] of Object.entries(raw.thinkingMapping)) {
      if (isPlainObject(fragment)) clean[level] = fragment;
    }
    if (Object.keys(clean).length) out.thinkingMapping = clean;
  }

  // Limits: positive integers only. A 0 or negative would make every clamp
  // downstream reject the request, so it is treated as absent.
  for (const k of LIMIT_KEYS) {
    if (raw[k] === null) out[k] = null;
    const n = Number(raw[k]);
    if (raw[k] !== null && Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
  }

  // Routing and provider quirks are deliberately not read here: the row does
  // not carry transport (see the header note). A caller that still sends one —
  // an older build's payload, or a hand-written request — has it dropped rather
  // than stored, exactly like any other unknown key.
  return Object.keys(out).length ? out : null;
}

// Full-row sanitize. `source` decides editability in the dashboard, so it is
// validated against the enum rather than accepted verbatim.
export function sanitizeModelConfig(raw) {
  if (!isPlainObject(raw)) return null;
  if (!raw.providerAlias || !raw.id) return null;

  const caps = sanitizeCaps(raw.caps);
  const out = {
    providerAlias: String(raw.providerAlias),
    id: String(raw.id),
    type: typeof raw.type === "string" && raw.type ? raw.type : "llm",
    name: typeof raw.name === "string" && raw.name ? raw.name : String(raw.id),
    source: CONFIG_SOURCES.includes(raw.source) ? raw.source : "operator",
  };
  if (caps) out.caps = caps;
  return out;
}

// A row is editable unless it came from the provider and has not been unlocked.
// Derived, not stored: an unlock writes `source: "operator"` and everything
// downstream reads editability from the source alone.
export function isConfigLocked(row) {
  return !!row && row.source === "provider";
}

// Infer the source for a row lifted out of a pre-existing store. A custom-model
// row only ever existed because an operator added it by hand, so anything with
// a non-empty caps patch is operator-authored; the rest are registrations the
// gateway made on the operator's behalf and inherit as builtin.
export function inferSource(caps) {
  return caps && Object.keys(caps).length ? "operator" : "builtin";
}
