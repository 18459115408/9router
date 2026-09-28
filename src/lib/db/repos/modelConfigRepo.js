// Unified model-config store.
//
// This is the single place a model's config is persisted. It supersedes the
// per-field `customModels.caps` patch (which could only ever carry 9 of the
// config's fields) and is the row the request path reads from first.
//
// Pattern follows pricingRepo: one kv scope, an async merge-on-write, and a
// short-lived cache so the request path never waits on the DB. Reads that must
// stay synchronous (capabilities resolution happens mid-request) go through the
// in-memory snapshot refreshed by `refreshModelConfigs()` — same shape as
// customCapsOverride, and the two coexist: `customModels` is left untouched so
// rolling this back is a matter of dropping this scope.

import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { sanitizeModelConfig, inferSource } from "../modelConfigSchema.js";

const configKv = makeKv("modelConfigs");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

function configKey(providerAlias, id, type = "llm") {
  return `${providerAlias}|${id}|${type}`;
}

// `fresh: true` bypasses the short-lived cache and reads the DB. Used by the
// snapshot refresh after a write: going through the cache would hand back the
// pre-write rows and the refresh would silently restore stale data.
async function getAllConfigs({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache.value && cache.expiresAt > now) return cache.value;
  const value = await configKv.getAll();
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

// Merge a caps patch onto the stored caps. Shallow, with `null` meaning "delete
// this key" — the config carries several independent settings and a caller that
// only means to flip one must not have to resend the rest, nor be able to
// clobber the rest by accident. `undefined` leaves a key alone.
function mergeCaps(prev, patch) {
  if (!patch || typeof patch !== "object") return prev;
  const next = { ...(prev || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else if (v !== undefined) next[k] = v;
  }
  return Object.keys(next).length ? next : null;
}

// `fresh: true` bypasses the short-lived cache and reads the DB. Used by the
// snapshot refresh after a write: going through the cache would hand back the
// pre-write rows and the refresh would silently restore stale data. A caller
// that is about to write based on what it reads (the API route's lock check)
// needs it for the same reason.
export async function getModelConfigs({ fresh = false } = {}) {
  return await getAllConfigs({ fresh });
}

// Atomic upsert inside transaction to prevent duplicate races. Re-adding an
// existing id updates the row without resetting omitted fields — an edit that
// only touches the thinking config must not wipe the limits.
export async function upsertModelConfig(row) {
  const clean = sanitizeModelConfig(row);
  if (!clean) return false;
  const k = configKey(clean.providerAlias, clean.id, clean.type);
  const db = await getAdapter();
  db.transaction(() => {
    const existing = db.get(`SELECT value FROM kv WHERE scope = 'modelConfigs' AND key = ?`, [k]);
    if (existing) {
      const prev = parseJson(existing.value) || {};
      const merged = mergeCaps(prev.caps, clean.caps);
      const next = { ...prev, ...clean, ...(merged ? { caps: merged } : {}) };
      if (!merged) delete next.caps;
      db.run(`UPDATE kv SET value = ? WHERE scope = 'modelConfigs' AND key = ?`, [stringifyJson(next), k]);
      return;
    }
    const value = stringifyJson({
      providerAlias: clean.providerAlias,
      id: clean.id,
      type: clean.type,
      name: clean.name,
      source: clean.source,
      ...(clean.caps ? { caps: clean.caps } : {}),
    });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('modelConfigs', ?, ?)`, [k, value]);
  });
  // The request path reads capabilities synchronously off the in-memory
  // snapshot, so a write that only invalidated the DB cache would not take
  // effect until the next process restart. Refresh the snapshot here rather
  // than trusting every caller to remember.
  await refreshModelConfigs();
  return true;
}

// Lift a legacy `customModels` row into this store. Copy, never move: the
// original row is left readable and writable so this scope can be dropped to
// roll back. `skipExisting` keeps a re-run from overwriting a row an operator
// has already edited here.
export async function importLegacyCustomModel(row, { skipExisting = true } = {}) {
  const clean = sanitizeModelConfig(row);
  if (!clean) return "skipped-invalid";
  const k = configKey(clean.providerAlias, clean.id, clean.type);
  if (skipExisting) {
    const existing = await configKv.get(k);
    if (existing) return "skipped-existing";
  }
  await upsertModelConfig({ ...clean, source: inferSource(clean.caps) });
  return "imported";
}

export async function deleteModelConfig({ providerAlias, id, type = "llm" }) {
  await configKv.remove(configKey(providerAlias, id, type));
  await refreshModelConfigs();
}

export async function resetModelConfigs() {
  await configKv.clear();
  await refreshModelConfigs();
}

// Drop the in-memory snapshot so the next read hits the DB. Called after a
// cross-process write (e.g. the Baidu sync scheduler merging rows elsewhere).
export function invalidateModelConfigCache() {
  invalidate();
}

// Snapshot the whole store into the synchronous lookup capabilities.js needs.
// Shaped after customCapsOverride: a Map keyed `provider:model` plus an
// installer that hands it to capabilities.js through a globalThis slot, because
// capabilities is bundled into the browser too and cannot import this file.
const STATE_KEY = "__9rModelConfigState";

function state() {
  if (typeof globalThis === "undefined") return (state._local ||= { configs: new Map(), installed: false });
  return (globalThis[STATE_KEY] ||= { configs: new Map(), installed: false });
}

function baseId(model) {
  if (!model) return "";
  const withoutVendor = String(model).includes("/") ? String(model).split("/").pop() : String(model);
  return withoutVendor.toLowerCase().split(":")[0];
}

// Rows are written under the dashboard alias (`ds`, `cl`, `qd`, or a node id)
// while a request carries the provider id (`deepseek`, `cline`, …), so index
// every row under both spellings. `canonicalOf` maps a stored alias to the
// provider id requests use; without it only the exact spelling resolves.
// The alias resolver most recently supplied to refreshModelConfigs(). Writes go
// through the API, which refreshes with the real resolver; caching it here lets
// the repo's own post-write refresh index the row under the provider id
// requests carry, not just the alias it was stored under.
let lastCanonicalOf = null;

export async function refreshModelConfigs({ canonicalOf = null } = {}) {
  if (canonicalOf) lastCanonicalOf = canonicalOf;
  const s = state();
  const rows = await getAllConfigs({ fresh: true });
  const next = new Map();
  for (const row of Object.values(rows)) {
    if (!row?.id || !row?.providerAlias) continue;
    const id = baseId(row.id);
    const canonical = lastCanonicalOf ? (lastCanonicalOf(row.providerAlias) || row.providerAlias) : row.providerAlias;
    next.set(`${canonical}:${id}`, row);
    if (canonical !== row.providerAlias) next.set(`${row.providerAlias}:${id}`, row);
  }
  s.configs = next;
}

// Synchronous lookup — the shape capabilities.js consumes.
export function getStoredConfig(provider, model) {
  if (!provider || !model) return null;
  const s = state();
  if (s.configs.size === 0) return null;
  return s.configs.get(`${provider}:${baseId(model)}`) || null;
}

// Install the reader into capabilities.js. Safe to call twice; re-installing
// after a refresh is a no-op that keeps the same reader.
export function installModelConfigSource(setSource) {
  const s = state();
  if (!s.installed) {
    setSource({ getConfig: getStoredConfig });
    s.installed = true;
  }
}

export function __resetModelConfigForTest() {
  if (typeof globalThis !== "undefined") delete globalThis[STATE_KEY];
  state._local = undefined;
}
