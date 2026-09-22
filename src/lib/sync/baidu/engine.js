// Sync cycle engine: snapshot → encrypt → upload, download → decrypt → apply.
//
// Conflict semantics: config tables are last-writer-wins per apply; the usage
// tables merge instead (usageHistory row union, usageDaily per-machine shards,
// _meta per-key max), so concurrent increments from several machines add up
// rather than overwrite each other — see applySnapshot below. Every cycle
// costs exactly one filemetas call; pushes (locateupload + upload) happen only
// when the local logical content hash changed. Before a remote file is applied
// over the local DB, a full local snapshot is archived under
// db/backups/sync-apply-* so a conflicting overwrite never loses data silently.
//
// requestDetails (or whatever BAIDU_SYNC_EXCLUDE_TABLES lists) never enters the
// snapshot and is never replaced by a pull — each instance keeps its own log.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../../dataDir.js";
import { BACKUPS_DIR } from "../../db/paths.js";
import { mergeUsageDailyDocs } from "../../db/helpers/usageMerge.js";
import { encryptBuffer, decryptBuffer } from "./crypto.js";
import * as panClient from "./panClient.js";

const SYNC_DIR = path.join(DATA_DIR, "baidu-sync");
const STATE_FILE = path.join(SYNC_DIR, "state.json");
const SELF_SKEW_MS = 60 * 1000; // remote mtime tolerance so we never re-pull our own push
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const KEEP_APPLY_BACKUPS = 3;

function logInfo(msg, extra) { console.log(`[BAIDU_SYNC] ${msg}`, extra ?? ""); }
function logWarn(msg, extra) { console.warn(`[BAIDU_SYNC] ${msg}`, extra ?? ""); }
function logError(msg, extra) { console.error(`[BAIDU_SYNC] ${msg}`, extra ?? ""); }

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// State — also lives outside the DB (see panClient token note).
// ---------------------------------------------------------------------------

export function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

export function saveState(state) {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

export function getStateSummary() {
  const state = loadState();
  return {
    lastSyncAt: state.lastSyncAt || null,
    lastPushedAt: state.lastPushedAt || null,
    lastAppliedRemoteMtime: state.lastAppliedRemoteMtime || null,
    lastError: state.lastError || null,
    throttleLevel: state.throttleLevel || 0,
  };
}

// ---------------------------------------------------------------------------
// Snapshot / apply (ATTACH based, same technique as db/backup.js backupDbLite)
// ---------------------------------------------------------------------------

function listMainTables(adapter) {
  return adapter
    .all(`SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .map((r) => r.name);
}

// Consistent copy of the live DB into a standalone sqlite file. excludeTables
// are skipped entirely (they stay machine-local).
export function snapshotDbToFile(adapter, destPath, excludeTables = []) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  try { fs.rmSync(destPath, { force: true }); } catch {}
  const escaped = destPath.replace(/'/g, "''");
  adapter.exec(`ATTACH DATABASE '${escaped}' AS syncbak`);
  try {
    const excluded = new Set(excludeTables);
    const tables = listMainTables(adapter).filter((t) => !excluded.has(t));
    adapter.transaction(() => {
      for (const t of tables) {
        const createSql = adapter
          .get(`SELECT sql FROM main.sqlite_master WHERE type='table' AND name=${escapeSqlString(t)}`)?.sql;
        if (!createSql) continue;
        adapter.exec(createSql.replace(/CREATE TABLE\s+/i, "CREATE TABLE syncbak."));
        adapter.exec(`INSERT INTO syncbak.${quoteIdent(t)} SELECT * FROM main.${quoteIdent(t)}`);
      }
      copySequenceRows(adapter, "main", "syncbak", new Set(tables));
    });
  } finally {
    try { adapter.exec("DETACH DATABASE syncbak"); } catch {}
  }
  return destPath;
}

function escapeSqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Copy AUTOINCREMENT counters (sqlite_sequence) between attached DBs so ids
// resume correctly after a pull-replace. Both DBs may lack the helper table.
function copySequenceRows(adapter, fromAlias, toAlias, tableFilter) {
  try {
    const rows = adapter.all(`SELECT name, seq FROM ${fromAlias}.sqlite_sequence`)
      .filter((r) => !tableFilter || tableFilter.has(r.name));
    adapter.exec(`DELETE FROM ${toAlias}.sqlite_sequence`);
    for (const r of rows) {
      adapter.run(`INSERT INTO ${toAlias}.sqlite_sequence(name, seq) VALUES(?, ?)`, [r.name, r.seq]);
    }
  } catch {
    /* sqlite_sequence missing on either side — nothing to carry over */
  }
}

// Apply an imported snapshot in ONE transaction: config tables are replaced
// wholesale (last-writer-wins), the usage tables below are merged so rows and
// counters this instance already has survive a pull. Tables present locally
// but absent from the snapshot (e.g. the machine-local requestDetails) are
// left untouched. A full pre-apply backup is archived first.
//
// Returns localExtras — how many merged items the local side has that the
// remote snapshot lacks. The pull step uses it to decide whether to re-push
// the union immediately (see pullAndApply).
export function applySnapshot(adapter, srcPath, { excludeTables = [] } = {}) {
  const escaped = srcPath.replace(/'/g, "''");
  adapter.exec(`ATTACH DATABASE '${escaped}' AS syncsrc`);
  try {
    const localVer = adapter.get(`SELECT value FROM main._meta WHERE key='schemaVersion'`)?.value;
    const remoteVer = adapter.get(`SELECT value FROM syncsrc._meta WHERE key='schemaVersion'`)?.value;
    if (localVer != null && remoteVer != null && String(localVer) !== String(remoteVer)) {
      throw new Error(`Schema version mismatch: local=${localVer} remote=${remoteVer} — upgrade both instances to the same version before syncing`);
    }

    const excluded = new Set(excludeTables);
    const mainTables = new Set(listMainTables(adapter));
    const srcTables = adapter
      .all(`SELECT name FROM syncsrc.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .map((r) => r.name);
    const shared = srcTables.filter((t) => mainTables.has(t) && !excluded.has(t));

    backupBeforeApply(adapter);

    let localExtras = 0;
    adapter.transaction(() => {
      const replaced = new Set();
      for (const t of shared) {
        if (t === "usageHistory") { localExtras += mergeUsageHistoryRows(adapter); continue; }
        if (t === "usageDaily") { localExtras += mergeUsageDailyRows(adapter); continue; }
        if (t === "_meta") { localExtras += mergeMetaRows(adapter); continue; }
        adapter.exec(`DELETE FROM main.${quoteIdent(t)}`);
        adapter.exec(`INSERT INTO main.${quoteIdent(t)} SELECT * FROM syncsrc.${quoteIdent(t)}`);
        replaced.add(t);
      }
      // Merged tables keep their local ids: both AUTOINCREMENT sequences
      // resume from the same baseline, so travelling ids would collide.
      copySequenceRows(adapter, "syncsrc", "main", replaced);
    });
    return { appliedTables: shared, localExtras };
  } finally {
    try { adapter.exec("DETACH DATABASE syncsrc"); } catch {}
  }
}

// --- Merge-on-apply for the usage tables -----------------------------------
// The cloud file is last-writer-wins, so a snapshot can lack rows this
// instance already has; replacing would destroy them. Each helper returns the
// count of local-only items (0 when the snapshot already contains everything
// locally relevant), which also gates the re-push decision after a pull.

// Row union on saveRequestUsage's own content-dedup predicate: identical
// logical rows collapse, re-applying the same snapshot is a no-op, and `id`
// is omitted from the INSERT so the LOCAL sequence assigns it.
function mergeUsageHistoryRows(adapter) {
  // Shared content predicate (mirrors saveRequestUsage's insert dedup). Both
  // call sites embed it after "SELECT 1 FROM <table> m/s", hence WHERE-only.
  const matchSql = `
    WHERE m.timestamp = s.timestamp
      AND COALESCE(m.provider, '') = COALESCE(s.provider, '')
      AND COALESCE(m.model, '') = COALESCE(s.model, '')
      AND COALESCE(m.connectionId, '') = COALESCE(s.connectionId, '')
      AND COALESCE(m.apiKey, '') = COALESCE(s.apiKey, '')
      AND COALESCE(m.promptTokens, 0) = COALESCE(s.promptTokens, 0)
      AND COALESCE(m.completionTokens, 0) = COALESCE(s.completionTokens, 0)`;
  const extras = adapter.get(
    `SELECT COUNT(*) c FROM main.usageHistory m WHERE NOT EXISTS (SELECT 1 FROM syncsrc.usageHistory s ${matchSql})`
  ).c;
  adapter.exec(`
    INSERT INTO main.usageHistory (timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
    SELECT s.timestamp, s.provider, s.model, s.connectionId, s.apiKey, s.endpoint, s.promptTokens, s.completionTokens, s.cost, s.status, s.tokens, s.meta
    FROM syncsrc.usageHistory s
    WHERE NOT EXISTS (SELECT 1 FROM main.usageHistory m ${matchSql})
  `);
  return extras;
}

function mergeUsageDailyRows(adapter) {
  let extras = 0;
  const remoteRows = adapter.all(`SELECT dateKey, data FROM syncsrc.usageDaily`);
  for (const r of remoteRows) {
    const local = adapter.get(`SELECT data FROM main.usageDaily WHERE dateKey = ?`, [r.dateKey]);
    const localNewer = [];
    const merged = mergeUsageDailyDocs(local?.data ?? null, r.data, localNewer);
    extras += localNewer.length;
    adapter.run(
      `INSERT INTO main.usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
      [r.dateKey, merged]
    );
  }
  // Whole dateKeys the snapshot lacks stay untouched by the loop (union) and
  // are exactly the local content the cloud is missing.
  extras += adapter.get(
    `SELECT COUNT(*) c FROM main.usageDaily l
     WHERE NOT EXISTS (SELECT 1 FROM syncsrc.usageDaily s WHERE s.dateKey = l.dateKey)`
  ).c;
  return extras;
}

function mergeMetaRows(adapter) {
  const remoteRows = adapter.all(`SELECT key, value FROM syncsrc._meta`);
  const remoteKeys = new Set(remoteRows.map((r) => r.key));
  let extras = 0;
  for (const r of adapter.all(`SELECT key, value FROM main._meta`)) {
    if (!remoteKeys.has(r.key)) extras++; // local-only key the snapshot predates
  }
  for (const r of remoteRows) {
    let value = r.value;
    if (r.key.startsWith("totalRequestsLifetime:")) {
      // Per-machine counter: grow-only, so max() both adopts the other side's
      // higher count and keeps ours when their copy is the stale one.
      const local = adapter.get(`SELECT value FROM main._meta WHERE key = ?`, [r.key]);
      const lv = parseInt(local?.value, 10) || 0;
      const rv = parseInt(r.value, 10) || 0;
      value = String(Math.max(lv, rv));
      if (lv > rv) extras++;
    }
    adapter.run(`INSERT INTO main._meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [r.key, value]);
  }
  return extras;
}

function backupBeforeApply(adapter) {
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(BACKUPS_DIR, `sync-apply-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    snapshotDbToFile(adapter, path.join(dir, "data.sqlite"), []);
    // Keep only the newest KEEP_APPLY_BACKUPS sync-apply backups.
    const entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("sync-apply-"))
      .map((e) => ({ name: e.name, full: path.join(BACKUPS_DIR, e.name), mtime: fs.statSync(path.join(BACKUPS_DIR, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of entries.slice(KEEP_APPLY_BACKUPS)) {
      try { fs.rmSync(old.full, { recursive: true, force: true }); } catch {}
    }
  } catch (e) {
    logWarn(`Pre-apply backup failed (continuing): ${e?.message ?? e}`);
  }
}

// Content hash over the syncable tables. Deterministic on logical rows, not on
// file bytes (a pulled snapshot re-paged by SQLite would otherwise never match).
export function computeLogicalHash(adapter, excludeTables = []) {
  const excluded = new Set(excludeTables);
  const tables = listMainTables(adapter).filter((t) => !excluded.has(t)).sort();
  const h = crypto.createHash("sha256");
  for (const t of tables) {
    const rows = adapter.all(`SELECT * FROM main.${quoteIdent(t)}`);
    h.update(`${t}\u0000${rows.length}`);
    for (const r of rows) h.update("\u0001").update(JSON.stringify(r));
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Cycle decisions
// ---------------------------------------------------------------------------

export function shouldPull(state, remote, nowMs = Date.now()) {
  if (remote.md5 && remote.md5 === state.lastPushedBlobMd5) return false; // our own upload
  if (remote.md5 && remote.md5 === state.lastPulledBlobMd5) return false; // already applied
  const remoteMtimeMs = (remote.serverMtime || 0) * 1000;
  const ref = Math.max(state.lastAppliedRemoteMtime || 0, state.lastPushedAt || 0);
  if (!ref) return true; // fresh instance adopts whatever the cloud has
  return remoteMtimeMs > ref + SELF_SKEW_MS;
}

export function getNextDelayMs(state, intervalMs) {
  const level = Number(state?.throttleLevel) || 0;
  if (level <= 0) return null;
  return Math.min(intervalMs * 2 ** level, MAX_BACKOFF_MS);
}

export function noteThrottleFailure() {
  const state = loadState();
  state.throttleLevel = (Number(state.throttleLevel) || 0) + 1;
  state.lastError = "throttled by Baidu quota — backing off";
  saveState(state);
  return state.throttleLevel;
}

// ---------------------------------------------------------------------------
// One sync cycle
// ---------------------------------------------------------------------------

async function pullAndApply(client, adapter, remote, accessToken, cfg, state, result) {
  const blob = await client.downloadByDlink(remote.dlink, accessToken);
  let plain;
  try {
    plain = decryptBuffer(blob, cfg.syncKey);
  } catch (e) {
    // Wrong passphrase or corrupted blob: the remote file cannot be trusted,
    // so keep local data untouched instead of wiping it. Surface it via the
    // cycle result so the success path below doesn't clear the warning.
    result.pullError = `pull-decrypt-failed: ${e?.message ?? e}`;
    logWarn(`Cannot decrypt remote snapshot — skipping pull (check BAIDU_SYNC_KEY on every instance)`);
    return false;
  }
  const incoming = path.join(SYNC_DIR, `incoming-${process.pid}-${Date.now()}.sqlite`);
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  fs.writeFileSync(incoming, plain);
  try {
    const { appliedTables, localExtras } = applySnapshot(adapter, incoming, { excludeTables: cfg.excludeTables });
    state.lastPulledBlobMd5 = remote.md5 || null;
    if (localExtras) {
      // Local usage content the snapshot lacked (merged in, not replaced):
      // keep the previous push baseline so pushIfNeeded uploads the union this
      // cycle — adopting the pulled hash would strand those rows until the
      // next unrelated local write.
      logInfo(`Pull merged ${localExtras} local-only usage item(s) — union will be pushed`);
    } else {
      // Adopt the pulled content as the push baseline so the push step below
      // (which re-hashes the live DB) doesn't immediately echo it back.
      state.lastPushedHash = computeLogicalHash(adapter, cfg.excludeTables);
    }
    logInfo(`Pulled and applied remote snapshot (${appliedTables.length} tables, ${blob.length} bytes encrypted)`);
    return true;
  } finally {
    try { fs.rmSync(incoming, { force: true }); } catch {}
  }
}

async function pushIfNeeded(client, adapter, remotePath, accessToken, cfg, state, result) {
  const localHash = computeLogicalHash(adapter, cfg.excludeTables);
  if (localHash === state.lastPushedHash) return false;

  adapter.checkpoint?.(); // fold WAL in so the snapshot sees everything
  const snapshotPath = path.join(SYNC_DIR, `snapshot-${process.pid}-${Date.now()}.sqlite`);
  try {
    snapshotDbToFile(adapter, snapshotPath, cfg.excludeTables);
    const plain = fs.readFileSync(snapshotPath);
    const blob = encryptBuffer(plain, cfg.syncKey);

    const upload = await client.uploadChunked(remotePath, blob, accessToken);
    result.calls += upload.apiCalls || 3;
    result.pushed = true;
    result.pushedBytes = blob.length;

    state.lastPushedHash = localHash;
    state.lastPushedBlobMd5 = upload.md5 || null;
    state.lastPushedAt = Date.now();
    // Pretend our push happened one skew-window ago so the next filemetas check
    // never mistakes our own upload for a foreign change.
    state.lastAppliedRemoteMtime = Math.max(state.lastAppliedRemoteMtime || 0, Date.now() - SELF_SKEW_MS);
    logInfo(`Pushed snapshot (${blob.length} bytes, md5=${upload.md5 || "n/a"})`);
    return true;
  } finally {
    try { fs.rmSync(snapshotPath, { force: true }); } catch {}
  }
}

/**
 * One cycle: check remote → pull if newer → push if local changed.
 * @param {{ adapter?: object, client?: object }} [deps]
 */
export async function runCycle(deps = {}) {
  const cfg = panClient.getSyncConfig();
  if (!cfg.appKey || !cfg.secretKey) {
    return { status: "skipped", reason: "BAIDU_APP_KEY / BAIDU_SECRET_KEY not set" };
  }
  if (!cfg.syncKey) {
    return { status: "skipped", reason: "BAIDU_SYNC_KEY not set — refusing to upload plaintext DB" };
  }

  const client = deps.client || panClient;
  const adapter = deps.adapter || (await (await import("../../db/driver.js")).getAdapter());
  const state = loadState();
  const result = { status: "ok", pulled: false, pushed: false, calls: 0 };

  try {
    const accessToken = await client.getAccessToken();
    result.calls += 1;

    const remotePath = client.getRemoteFilePath();
    const remote = await client.statRemoteFile(remotePath, accessToken);
    result.calls += 1;

    if (remote && remote.dlink && shouldPull(state, remote)) {
      const pulled = await pullAndApply(client, adapter, remote, accessToken, cfg, state, result);
      result.pulled = pulled;
      if (pulled) state.lastAppliedRemoteMtime = (remote.serverMtime || 0) * 1000;
    }

    if (remote && remote.dlink && !result.pulled && remote.md5 && remote.md5 !== state.lastPushedBlobMd5) {
      // A foreign file exists that we chose not to pull (e.g. decrypt failure).
      // Overwriting it blindly could destroy the other side's newer data, so
      // surface it and still allow the push below — last-writer-wins by design.
      logWarn(`Remote snapshot not pulled (older or undecryptable) — a push will overwrite it`);
    }

    try {
      await pushIfNeeded(client, adapter, remotePath, accessToken, cfg, state, result);
    } catch (e) {
      // First upload ever: the remote folder may not exist yet. Create it and
      // retry the push exactly once.
      if (e?.kind === "path" || e?.kind === "notfound") {
        logWarn(`Upload hit a path error — creating remote dir and retrying once`);
        await ensureRemoteDir(client, accessToken);
        result.calls += 1;
        await pushIfNeeded(client, adapter, remotePath, accessToken, cfg, state, result);
      } else {
        throw e;
      }
    }

    state.throttleLevel = 0;
    // Keep a pull-decrypt warning visible in status until the next clean pull.
    state.lastError = result.pullError || null;
    state.lastSyncAt = Date.now();
    saveState(state);
    result.state = getStateSummary();
    return result;
  } catch (e) {
    state.lastError = `${e?.kind || "error"}: ${e?.message ?? e}`;
    state.lastSyncAt = Date.now();
    if (e?.kind === "throttled") {
      // Level itself is bumped by the scheduler (noteThrottleFailure) so the
      // increment happens in exactly one place.
      result.retryAfterMs = getNextDelayMs(
        { ...state, throttleLevel: (Number(state.throttleLevel) || 0) + 1 },
        deps.intervalMs || 30 * 60 * 1000
      );
    }
    saveState(state);
    throw e;
  }
}

// First-upload helper: if an upload fails with a path error the remote folder
// may not exist yet — create it and let the caller retry once.
export async function ensureRemoteDir(client, accessToken) {
  const cfg = panClient.getSyncConfig();
  try {
    await client.createRemoteDir(cfg.remoteDir, accessToken);
    return true;
  } catch (e) {
    // -8 "already exists" etc. — treat any outcome except auth as fine.
    if (e?.kind === "auth" || e?.kind === "throttled") throw e;
    return false;
  }
}

export { SYNC_DIR };
