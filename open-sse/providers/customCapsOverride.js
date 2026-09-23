// Read side of the operator's capability declarations for custom models.
//
// The dashboard stores them on the customModels rows (kv scope "customModels",
// `caps: {vision, reasoning, ...}`). This module turns those rows into a
// synchronous lookup for capabilities.js, which resolves capabilities per
// request and cannot await a DB read.
//
// Why the declarations matter at all: a model the hand-written tables have
// never heard of — anything behind a user-added OpenAI/Anthropic-compatible
// node — falls through to DEFAULT_CAPABILITIES (vision:false), and
// stripUnsupportedModalities() then swaps the operator's images for
// "[image omitted: model has no vision support]" before the request leaves the
// process. Without a declaration there is no way to say "this one reads
// images".
//
// Shape mirrors catalogOverride.js: a cached table plus an installer that hands
// it to capabilities.js through a globalThis slot (that module is bundled into
// the browser too, so it cannot import this file).

import { setCustomCapsSource, DECLARABLE_KEYS } from "./capabilities.js";

// Every id/alias a stored row might use -> the canonical provider id a request
// arrives with. Built from the registry so the two namespaces line up:
// customModels rows are written under the *dashboard* alias (`cl`, `qd`, `ds`,
// or a node id), while the request path carries the provider id (`cline`,
// `qoder`, `deepseek`). Neither direction is derivable from the other alone —
// `ds` lives in the registry's `aliases[]`, not in `alias` — so index all of
// them.
function buildAliasIndex(registry) {
  const index = new Map();
  const add = (name, id) => {
    if (name && !index.has(name)) index.set(name, id);
  };
  for (const entry of registry) {
    if (!entry?.id) continue;
    add(entry.id, entry.id);
    add(entry.alias, entry.id);
    add(entry.uiAlias, entry.id);
    for (const a of entry.aliases || []) add(a, entry.id);
  }
  return index;
}

let aliasIndex = null;
async function getAliasIndex() {
  if (aliasIndex) return aliasIndex;
  try {
    const { default: registry } = await import("./registry/index.js");
    aliasIndex = buildAliasIndex(registry);
  } catch {
    // Registry unavailable (tests, partial bundles): fall back to raw names so
    // a declaration stored under the exact provider id still resolves.
    aliasIndex = new Map();
  }
  return aliasIndex;
}

// "zai-org/GLM-4.6V:free" -> "glm-4.6v" — same normalization capabilities.js
// applies to the incoming model id.
function baseId(model) {
  if (!model) return "";
  const withoutVendor = String(model).includes("/") ? String(model).split("/").pop() : String(model);
  return withoutVendor.toLowerCase().split(":")[0];
}

// Shared state, on globalThis for the same reason capabilities.js keeps its
// source slot there: Next bundles this module into every route chunk that needs
// it, and each copy gets its own module scope. Without this, the copy the
// /api/models/custom route imports writes its declarations into a map the copy
// resolving requests never reads — the write succeeds and nothing changes.
const STATE_KEY = "__9rCustomCapsState";
function state() {
  if (typeof globalThis === "undefined") {
    // Non-browser, non-node (should not happen): fall back to module scope.
    return (state._local ||= { declared: new Map(), aliasIndex: null, installed: false });
  }
  return (globalThis[STATE_KEY] ||= { declared: new Map(), aliasIndex: null, installed: false });
}

function keyOf(provider, model) {
  return `${provider}:${baseId(model)}`;
}

// Wire formats a declaration may name. Mirrors the `thinkingFormat` enum in
// capabilities.js / the cases in thinkingUnified.applyFormat — an unknown value
// would silently fall through to a generic shape, so it is dropped instead.
export const THINKING_FORMATS = [
  "openai", "claude-adaptive", "claude-budget", "gemini-level", "gemini-budget",
  "zai", "qwen", "deepseek", "kimi", "minimax", "hunyuan", "step",
];

// Levels a declaration may list, low→high. "none" is the off switch and is
// offered separately by the UI; "auto" means "let the client decide".
export const THINKING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function sanitizeMapping(mapping) {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return null;
  const clean = {};
  for (const [level, fragment] of Object.entries(mapping)) {
    if (!fragment || typeof fragment !== "object" || Array.isArray(fragment)) continue;
    // Shallow copy only: the fragments are body fields, and deep-walking them
    // would invite prototype-pollution style keys for no benefit.
    const safe = {};
    for (const [k, v] of Object.entries(fragment)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      safe[k] = v;
    }
    if (Object.keys(safe).length) clean[level] = safe;
  }
  return Object.keys(clean).length ? clean : null;
}

function sanitize(caps) {
  if (!caps || typeof caps !== "object") return null;
  const clean = {};

  // Modalities + reasoning. Booleans are kept in BOTH directions here; whether a
  // `false` is honoured is decided in capabilities.applyDeclaredCaps (it is, for
  // `reasoning`; the modality flags stay additive).
  for (const k of DECLARABLE_KEYS) {
    if (typeof caps[k] === "boolean") clean[k] = caps[k];
  }

  // Thinking config — explicit overrides, so validated rather than merged.
  if (typeof caps.thinkingFormat === "string" && THINKING_FORMATS.includes(caps.thinkingFormat)) {
    clean.thinkingFormat = caps.thinkingFormat;
  }
  if (typeof caps.thinkingCanDisable === "boolean") {
    clean.thinkingCanDisable = caps.thinkingCanDisable;
  }
  if (Array.isArray(caps.thinkingLevels)) {
    const levels = caps.thinkingLevels.filter((l) => typeof l === "string" && THINKING_LEVELS.includes(l));
    // Dedupe, preserving the operator's low→high order.
    const ordered = [...new Set(levels)];
    if (ordered.length) clean.thinkingLevels = ordered;
  }
  const mapping = sanitizeMapping(caps.thinkingMapping);
  if (mapping) clean.thinkingMapping = mapping;

  return Object.keys(clean).length ? clean : null;
}

/**
 * Synchronous lookup used by getCapabilitiesForModel.
 * @param {string|null} provider provider id as the request carries it
 * @param {string} model model id
 * @returns {object|null} declared caps, or null when nothing is declared
 */
export function getDeclaredCaps(provider, model) {
  if (!model) return null;
  const { declared, aliasIndex: index } = state();
  if (declared.size === 0) return null;
  const canonical = provider ? (index?.get(provider) || provider) : null;
  if (!canonical) return null;
  return declared.get(keyOf(canonical, model)) || null;
}

/**
 * Install the reader into capabilities.js (server only). Safe to call twice.
 */
export async function installCustomCapsSource() {
  const s = state();
  if (!s.installed) {
    setCustomCapsSource({ getCaps: getDeclaredCaps });
    s.installed = true;
  }
  await refreshDeclaredCaps();
}

/**
 * Rebuild the cache from the database. Called at startup and by the
 * custom-models API after a write.
 */
export async function refreshDeclaredCaps() {
  const s = state();
  if (!s.aliasIndex) s.aliasIndex = await getAliasIndex();

  let rows = [];
  try {
    const { getCustomModels } = await import("@/lib/db/index.js");
    rows = await getCustomModels();
  } catch {
    // No DB reachable — leave the previous cache in place rather than dropping
    // every declaration (a transient read failure must not strip images).
    return;
  }

  const next = new Map();
  for (const row of rows || []) {
    const caps = sanitize(row?.caps);
    if (!caps || !row?.id || !row?.providerAlias) continue;
    const canonical = s.aliasIndex.get(row.providerAlias) || row.providerAlias;
    // Index under the canonical id (what requests carry) and, when it differs,
    // the stored alias — a request can arrive under either.
    next.set(keyOf(canonical, row.id), caps);
    if (row.providerAlias !== canonical) next.set(keyOf(row.providerAlias, row.id), caps);
  }
  s.declared = next;
}

/**
 * Update one declaration in place — called right after a successful write so
 * the change takes effect without waiting for the next refresh.
 * @param {string} providerAlias as stored on the customModels row
 * @param {string} modelId
 * @param {object|null} caps sanitized caps; null clears the declaration
 */
export function setDeclaredCaps(providerAlias, modelId, caps) {
  if (!providerAlias || !modelId) return;
  const s = state();
  const canonical = s.aliasIndex?.get(providerAlias) || providerAlias;
  const clean = sanitize(caps);
  for (const p of new Set([canonical, providerAlias])) {
    const k = keyOf(p, modelId);
    if (clean) s.declared.set(k, clean);
    else s.declared.delete(k);
  }
}

// Drop the cached alias index + declarations. Test hook.
export function __resetCustomCapsForTest() {
  if (typeof globalThis !== "undefined") delete globalThis[STATE_KEY];
  state._local = undefined;
  setCustomCapsSource(null);
}
