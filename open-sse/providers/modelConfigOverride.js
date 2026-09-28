// Server-only bootstrap for the unified model-config store.
//
// Mirrors customCapsOverride.js: the DB is read asynchronously once, the rows
// are reduced to a synchronous in-memory Map, and the reader is handed to
// capabilities.js through a globalThis slot (that module is bundled into the
// browser too, so it cannot import this file or the DB layer behind it).
//
// Refresh points, in order of how often they fire:
//   • startup, via instrumentation.js
//   • after every write through the model-config API (callers await this)
//   • after the Baidu sync scheduler merges rows from another instance

import { setModelConfigSource } from "./capabilities.js";
import {
  getStoredConfig, refreshModelConfigs,
  installModelConfigSource as installReader,
  __resetModelConfigForTest,
} from "@/lib/db/repos/modelConfigRepo.js";
import { buildAliasIndex } from "./customCapsOverride.js";
import { getModelConfigs } from "@/lib/db/repos/modelConfigRepo.js";
let aliasIndex = null;
let installed = false;

async function getAliasIndex() {
  if (aliasIndex) return aliasIndex;
  try {
    const { default: registry } = await import("./registry/index.js");
    aliasIndex = buildAliasIndex(registry);
  } catch {
    // Registry unavailable (tests, partial bundles): fall back to raw names so
    // a row stored under the exact provider id still resolves.
    aliasIndex = new Map();
  }
  return aliasIndex;
}

function canonicalOf(alias) {
  return aliasIndex?.get(alias) || alias;
}

/**
 * Install the unified-config reader into capabilities.js. Safe to call twice.
 */
export async function installModelConfigSource() {
  const index = await getAliasIndex();
  await refreshModelConfigs({ canonicalOf: index ? (a) => index.get(a) || a : null });
  installReader(setModelConfigSource);
  installed = true;
}

/**
 * Re-read the store into the in-memory snapshot. Call after any write that
 * must take effect without a restart, and after a cross-process merge.
 */
export async function refreshModelConfigSource() {
  const index = await getAliasIndex();
  await refreshModelConfigs({ canonicalOf: index ? (a) => index.get(a) || a : null });
  installReader(setModelConfigSource);
  installed = true;
}

export function __resetModelConfigOverrideForTest() {
  aliasIndex = null;
  installed = false;
  setModelConfigSource(null);
  __resetModelConfigForTest();
}

export { getModelConfigs, getStoredConfig };
