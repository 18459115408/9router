// Build the pre-fill suggestion for a model an operator is adding.
//
// This is the only thing the built-in tables are still allowed to do: propose a
// starting point at add time. They no longer silently override what an operator
// saved (that is modelConfigOverride's job), and they no longer decide anything
// by themselves at request time.
//
// The suggestion must be honest about whether the tables actually have an
// opinion. Returning DEFAULT_CAPABILITIES as if it were knowledge would
// pre-fill every toggle with the floor's value and imply the gateway knows
// something it does not — an operator who then saves would be saving the
// default back over a model that may behave differently.

import { getCapabilitiesForModel, DEFAULT_CAPABILITIES, setModelConfigSource } from "./capabilities.js";
import {
  getModelTargetFormat, getModelSupportedFormats, getModelUpstreamId,
  getModelType, getModelStrip, getModelQuotaFamily,
} from "../config/providerModels.js";
import { getCatalogModalities, getCatalogLimits } from "./catalogOverride.js";

// Fields worth proposing in the add-model form. Modalities and reasoning are
// what the UI exposes today; limits and routing are what make the row
// actionable downstream. `tools`/`search`/`imageOutput`/`audioOutput` are
// display-only capabilities with no editor, so proposing them would write a
// value nobody can see or change.
// Caps a suggestion may propose — the capability keys a row can actually carry.
// Routing keys are deliberately absent: they cannot be saved on a row (the
// registry owns transport), so proposing them would pre-fill values that
// silently fail to persist.
const PROPOSABLE_CAPS = [
  "vision", "pdf", "audioInput", "videoInput", "reasoning",
  "contextWindow", "maxOutput",
  "thinkingFormat", "thinkingCanDisable", "thinkingLevels", "thinkingEffortSupported",
];

// Which layer supplied each field, so the UI can say where the pre-fill came
// from. The catalog readers throw when the file is absent, so a suggest must
// never be able to break the add-model form — treat any failure as "no
// opinion" and fall back to the tables alone.
let catalogEnabled = false;
export function setSuggestCatalogSource(enabled) {
  catalogEnabled = !!enabled;
}
function readCatalog(provider, model) {
  if (!catalogEnabled || !model) return { modalities: null, limits: null };
  try {
    return {
      modalities: getCatalogModalities(provider, model),
      limits: getCatalogLimits(provider, model),
    };
  } catch {
    return { modalities: null, limits: null };
  }
}

/**
 * Resolve what the built-in sources know about one (provider, model) pair.
 *
 * @param {string|null} providerAlias the stored/dashboard spelling
 * @param {string} modelId
 * @param {object} [opts]
 * @param {string} [opts.providerId] the provider id requests carry, when it
 *   differs from the alias (registry providers: `ds` → `deepseek`)
 * @returns {{found: boolean, source: string, caps: object, routing: object, detail: object}}
 */
export function suggestModelConfig(providerAlias, modelId, opts = {}) {
  const provider = opts.providerId || providerAlias || null;
  const empty = {
    found: false,
    source: "none",
    caps: {},
    routing: {},
    detail: { fromTables: false, fromCatalog: false },
  };
  if (!modelId) return empty;

  const base = modelId.includes("/") ? modelId.split("/").pop() : modelId;

  // 1. The built-in chain (provider table → exact → pattern → floor), with the
  //    declared-caps overlay applied by resolveFromTables.
  const caps = getCapabilitiesForModel(provider, modelId);

  // Everything that is not simply the floor is knowledge the tables hold.
  const fromTables = {};
  for (const key of Object.keys(caps)) {
    if (caps[key] !== DEFAULT_CAPABILITIES[key]) fromTables[key] = caps[key];
  }

  // 2. The synced catalog, which covers models the tables never heard of.
  const { modalities, limits } = readCatalog(provider, modelId);
  const fromCatalog = {};
  if (modalities) {
    for (const [k, v] of Object.entries(modalities)) {
      if (v === true && fromTables[k] !== true) fromCatalog[k] = true;
    }
  }
  if (limits) {
    if (limits.contextWindow > 0 && fromTables.contextWindow !== limits.contextWindow) {
      fromCatalog.contextWindow = limits.contextWindow;
    }
    if (limits.maxOutput > 0 && fromTables.maxOutput !== limits.maxOutput) {
      fromCatalog.maxOutput = limits.maxOutput;
    }
  }

  // 3. Routing: how the request reaches the upstream, from the registry.
  //
  //    Two of these readers report a default rather than null when the registry
  //    holds nothing: `getModelUpstreamId` falls back to the id itself, and
  //    `modelQuotaFamily` falls back to MODEL_DEFAULTS.quotaFamily. Treating
  //    either as an opinion would make every unrecognized model look configured,
  //    so each is accepted only when it differs from that fallback.
  //
  //    Returned for information only — it describes how this request will be
  //    routed, not anything a saved row can change. Nothing persists it, so it
  //    never enters `proposedCaps`.
  const routing = {};
  const targetFormat = getModelTargetFormat(providerAlias, base);
  if (targetFormat) routing.targetFormat = targetFormat;
  const supportedFormats = getModelSupportedFormats(providerAlias, base);
  if (Array.isArray(supportedFormats) && supportedFormats.length) routing.supportedFormats = supportedFormats;
  const upstreamModelId = getModelUpstreamId(providerAlias, base);
  if (upstreamModelId && upstreamModelId !== base) routing.upstreamModelId = upstreamModelId;
  // "normal" is MODEL_DEFAULTS.quotaFamily — the absence of a declaration.
  const quotaFamily = getModelQuotaFamily(providerAlias, base);
  if (quotaFamily && quotaFamily !== "normal") routing.quotaFamily = quotaFamily;
  const strip = getModelStrip(providerAlias, base);
  if (Array.isArray(strip) && strip.length) routing.strip = strip;

  const proposedCaps = {};
  const provenance = {};
  // Tables win over catalog: the hand-written tables are the curated layer, the
  // catalog only fills gaps. `routing` is not consulted here — it describes
  // transport the registry owns and a row cannot carry, so it must never enter
  // the proposed caps (a pre-fill that silently fails to persist is worse than
  // no pre-fill).
  for (const key of PROPOSABLE_CAPS) {
    if (fromTables[key] !== undefined) {
      proposedCaps[key] = fromTables[key];
      provenance[key] = "table";
    } else if (fromCatalog[key] !== undefined) {
      proposedCaps[key] = fromCatalog[key];
      provenance[key] = "catalog";
    }
  }

  const found = Object.keys(proposedCaps).length > 0;
  return {
    found,
    source: found ? (Object.values(provenance).includes("table") ? "builtin" : "catalog") : "none",
    caps: proposedCaps,
    routing,
    provenance,
    detail: {
      fromTables: Object.keys(fromTables).length > 0,
      fromCatalog: Object.keys(fromCatalog).length > 0,
      // The model's declared kind (llm/stt/tts/embedding/image) when known.
      kind: getModelType(providerAlias, base) || null,
    },
  };
}

// Exported for the API route, which installs the catalog reader server-side.
export const SUGGEST_SETTERS = { setModelConfigSource, setSuggestCatalogSource };
