// Scheduled Baidu-Netdisk DB sync — same lifecycle pattern as
// src/sse/services/backgroundTokenRefresh.js: started flag against double-starts,
// re-entrancy guard in the tick, unref'd timers, fail-open everywhere.
// The engine module is imported lazily inside the tick so this file stays
// importable from custom-server.js (plain Node, no "@/..." alias resolution);
// there the first tick may fail to load the Next-aliased DB modules and simply
// retries on the next interval — instrumentation.js is the primary entry.
import { isConfigured } from "./panClient.js";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 15 * 1000;

let started = false;
let timerHandle = null;
let tickRunning = false;
let intervalOverrideMs = null;

function isSyncDisabledByEnv() {
  const v = String(process.env.BAIDU_SYNC ?? "").trim().toLowerCase();
  return v === "off" || v === "false" || v === "0" || v === "no";
}

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") return true;
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

function readIntervalMs() {
  if (Number.isFinite(intervalOverrideMs) && intervalOverrideMs > 0) return intervalOverrideMs;
  const minutes = Number(process.env.BAIDU_SYNC_INTERVAL_MINUTES);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : DEFAULT_INTERVAL_MS;
}

async function loadEngine() {
  return await import("./engine.js");
}

/**
 * One scheduler tick. Never throws; quota (errno 20012/9013) failures bump a
 * persisted backoff level that doubles the effective delay up to 6h.
 * @param {{ adapter?: object, client?: object }} [deps]
 */
export async function runBaiduSyncTick(deps = {}) {
  if (tickRunning) return { status: "busy" };
  tickRunning = true;
  try {
    const engine = await loadEngine();
    const intervalMs = readIntervalMs();
    try {
      const result = await engine.runCycle({ ...deps, intervalMs });
      if (result.status === "skipped") {
        console.log(`[BAIDU_SYNC] cycle skipped: ${result.reason}`);
      } else {
        console.log(
          `[BAIDU_SYNC] cycle done: pulled=${result.pulled} pushed=${result.pushed} apiCalls=${result.calls}` +
            (result.pushedBytes ? ` pushedBytes=${result.pushedBytes}` : "")
        );
      }
      return result;
    } catch (e) {
      if (e?.kind === "throttled") {
        const level = engine.noteThrottleFailure();
        console.warn(`[BAIDU_SYNC] throttled by Baidu quota — backoff level ${level} (swallowed)`);
      } else if (e?.kind === "auth") {
        console.warn(`[BAIDU_SYNC] ${e.message} (swallowed)`);
      } else {
        console.warn(`[BAIDU_SYNC] cycle failed: ${e?.message ?? e} (swallowed)`);
      }
      return { status: "error", error: e?.message ?? String(e) };
    }
  } catch (e) {
    // Engine itself failed to load (e.g. plain-Node context without Next aliases).
    console.warn(`[BAIDU_SYNC] tick skipped: ${e?.message ?? e}`);
    return { status: "error", error: e?.message ?? String(e) };
  } finally {
    tickRunning = false;
  }
}

function scheduleNext() {
  const delayMs = computeNextDelayMs();
  timerHandle = setTimeout(safeTick, delayMs);
  if (timerHandle.unref) timerHandle.unref();
}

function computeNextDelayMs() {
  if (cachedEngine) {
    try {
      const delay = cachedEngine.getNextDelayMs(cachedEngine.loadState(), readIntervalMs());
      if (delay) return delay;
    } catch {}
  }
  return readIntervalMs();
}

// The engine import may fail outside Next; caching the successful module keeps
// scheduling working with the default interval instead of re-importing forever.
let cachedEngine = null;

async function safeTick() {
  try {
    if (!cachedEngine) cachedEngine = await loadEngine();
    await runBaiduSyncTick();
  } catch (e) {
    console.warn(`[BAIDU_SYNC] unhandled tick rejection (swallowed): ${e?.message ?? e}`);
  }
  if (started) scheduleNext();
}

/**
 * Start the sync scheduler. Safe to call multiple times (no-op if started).
 * @param {{ intervalMs?: number }} [opts]
 * @returns {boolean} true if started by this call
 */
export function startBaiduSync(opts = {}) {
  if (started) return false;
  if (isSyncDisabledByEnv()) return false;
  if (isNonServerRuntime()) return false;
  if (!isConfigured()) {
    console.log("[BAIDU_SYNC] not configured (BAIDU_APP_KEY/BAIDU_SECRET_KEY/BAIDU_SYNC_KEY) — scheduler idle");
    return false;
  }

  if (Number.isFinite(opts.intervalMs) && opts.intervalMs > 0) intervalOverrideMs = opts.intervalMs;
  started = true;
  const initial = setTimeout(safeTick, INITIAL_DELAY_MS);
  if (initial.unref) initial.unref();
  console.log(`[BAIDU_SYNC] scheduler started (every ${Math.round(readIntervalMs() / 60000)} min)`);
  return true;
}

export function stopBaiduSync() {
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
  started = false;
}

export function isBaiduSyncStarted() {
  return started;
}
