import { ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS, COOLDOWN } from "../config/errorConfig.js";

/**
 * Per-provider cooldown override.
 *
 * Every field is optional; an unset field falls back to the global constant, so
 * omitting the object entirely reproduces the historical behaviour exactly.
 * Callers pass whatever they resolved from settings; this module never reads
 * settings itself (it stays pure and usable from tests).
 *
 * @typedef {Object} CooldownConfig
 * @property {number} [maxBackoffMs]            cap for exponential 429 backoff
 * @property {number} [maxBackoffLevel]         how far the exponential may climb
 * @property {number} [maxRateLimitCooldownMs]  cap when upstream reports a reset time
 * @property {number} [cooldownLongMs]          fixed cooldown for 401/402/403/404-class rules
 * @property {number} [cooldownShortMs]         fixed cooldown for "request not allowed"
 * @property {number} [transientCooldownMs]     cooldown for unmatched errors
 * @property {number} [backoffBaseMs]           exponential backoff base
 */

// Tolerate null/undefined/non-object cfg so callers can pass through whatever
// they resolved without a guard.
function norm(cfg) {
  return cfg && typeof cfg === "object" ? cfg : {};
}

// Pick the first finite, non-negative override; otherwise the default.
function pick(override, fallback) {
  return Number.isFinite(override) && override >= 0 ? override : fallback;
}

/**
 * Resolve a single cooldown override against its global default.
 * Exported so call sites outside this module (auth.js's resetsAt branch) apply
 * the identical validation rule — negative/NaN/non-numeric → default.
 * @param {number|undefined} override
 * @param {number} fallback
 * @returns {number}
 */
export function resolveCooldownMs(override, fallback) {
  return pick(override, fallback);
}

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 *
 * NOTE: maxBackoffMs only bites if the exponential can actually reach it. With
 * the default base (2s) and maxBackoffLevel (15) the ceiling is base * 2^14 ≈
 * 9.1h, so a larger maxBackoffMs has no effect unless backoffBaseMs (or
 * maxBackoffLevel) is raised too. Set backoffBaseMs to the target duration when
 * a long first-strike cooldown is what you want.
 *
 * @param {number} backoffLevel - Current backoff level
 * @param {CooldownConfig} [cfg] - Per-provider override
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0, cfg = {}) {
  const c = norm(cfg);
  const base = pick(c.backoffBaseMs, BACKOFF_CONFIG.base);
  const max = pick(c.maxBackoffMs, BACKOFF_CONFIG.max);
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = base * Math.pow(2, level);
  return Math.min(cooldown, max);
}

// Clamp a backoff level, honouring a configured ceiling.
function nextBackoffLevel(backoffLevel, cfg) {
  const maxLevel = pick(norm(cfg).maxBackoffLevel, BACKOFF_CONFIG.maxLevel);
  return Math.min(backoffLevel + 1, maxLevel);
}

// Map a rule's fixed cooldown onto the override bucket it belongs to. Rules keep
// their declared value; the override only substitutes for the two semantic
// buckets (long/short), so an unrecognised value passes through untouched.
function resolveFixedCooldown(ruleCooldownMs, cfg) {
  const c = norm(cfg);
  if (ruleCooldownMs === COOLDOWN.long) return pick(c.cooldownLongMs, COOLDOWN.long);
  if (ruleCooldownMs === COOLDOWN.short) return pick(c.cooldownShortMs, COOLDOWN.short);
  return ruleCooldownMs;
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @param {CooldownConfig} [cfg] - Per-provider cooldown override
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0, cfg = {}) {
  const c = norm(cfg);
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  for (const rule of ERROR_RULES) {
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.backoff) {
        const newLevel = nextBackoffLevel(backoffLevel, c);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel, c), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: resolveFixedCooldown(rule.cooldownMs, c) };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.backoff) {
        const newLevel = nextBackoffLevel(backoffLevel, c);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel, c), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: resolveFixedCooldown(rule.cooldownMs, c) };
    }
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: pick(c.transientCooldownMs, TRANSIENT_COOLDOWN_MS) };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {CooldownConfig} [cfg] - Per-provider cooldown override
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText, cfg = {}) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, cfg);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}
