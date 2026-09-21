// Baidu Netdisk OpenAPI client for the DB sync feature.
//
// Doc map (https://pan.baidu.com/union/doc):
// - OAuth: openapi.baidu.com/oauth/2.0/authorize|token. access_token lives 30 days;
//   refresh_token is SINGLE-USE — every successful refresh returns a new one and the
//   old stops working, so the new value is persisted before anything else happens.
// - Upload: 3-step chunked only — precreate → superfile2 (4MB slices) → create
//   (rtype=3 = overwrite on conflict). The single-step `method=upload` endpoint is
//   retired: `pcs/file` answers 31064 "file is not authorized" and `xpan/file`
//   answers 31832 "unsupported api" (verified against the live API 2026-09-21), so
//   every upload goes through the chunked flow regardless of size.
//   Upload host must come from `method=locateupload`, never hardcoded (we keep
//   d.pcs.baidu.com only as a fallback when locateupload is unavailable).
// - Download: filemetas(dlink=1) → GET dlink with `User-Agent: pan.baidu.com`.
// All calls go through the global fetch (proxy patch in open-sse/utils/proxyFetch.js
// applies automatically). No inbound connectivity is ever needed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../../dataDir.js";

const OAUTH_AUTHORIZE_URL = "https://openapi.baidu.com/oauth/2.0/authorize";
const OAUTH_TOKEN_URL = "https://openapi.baidu.com/oauth/2.0/token";
const XPAN_FILE_URL = "https://pan.baidu.com/rest/2.0/xpan/file";
// locateupload's appid is a fixed platform value per the official doc, not the
// developer AppID (examples all use 250528 regardless of app).
const LOCATE_UPLOAD_APPID = 250528;
const DOWNLOAD_USER_AGENT = "pan.baidu.com";
const DEFAULT_UPLOAD_BASE = "https://d.pcs.baidu.com";
const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB slices for non-VIP accounts
const API_TIMEOUT_MS = 60 * 1000;
const TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;
const REFRESH_LEAD_MS = 24 * 60 * 60 * 1000; // refresh 24h before the 30-day expiry

export class BaiduPanError extends Error {
  /**
   * @param {string} kind ok|auth|throttled|permission|path|notfound|storage|api|network
   */
  constructor(kind, message, { errno = null, retryable = false, needsReauth = false } = {}) {
    super(message);
    this.name = "BaiduPanError";
    this.kind = kind;
    this.errno = errno;
    this.retryable = retryable;
    this.needsReauth = needsReauth;
  }
}

export function getSyncConfig() {
  const appName = process.env.BAIDU_APP_NAME || "9router";
  const remoteDir = process.env.BAIDU_REMOTE_DIR || `/apps/${appName}/9router-sync`;
  return {
    appKey: process.env.BAIDU_APP_KEY || "",
    secretKey: process.env.BAIDU_SECRET_KEY || "",
    signKey: process.env.BAIDU_SIGN_KEY || "",
    syncKey: process.env.BAIDU_SYNC_KEY || "",
    appName,
    remoteDir,
    excludeTables: (process.env.BAIDU_SYNC_EXCLUDE_TABLES || "requestDetails")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function isConfigured() {
  const cfg = getSyncConfig();
  return Boolean(cfg.appKey && cfg.secretKey && cfg.syncKey);
}

export function getRemoteFilePath() {
  return `${getSyncConfig().remoteDir}/data.sqlite.enc`;
}

export function stateDir() {
  return path.join(DATA_DIR, "baidu-sync");
}

export function tokenFilePath() {
  return path.join(stateDir(), "token.json");
}

function ensureStateDir() {
  fs.mkdirSync(stateDir(), { recursive: true });
}

function atomicWriteJson(file, obj, mode = 0o600) {
  ensureStateDir();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode });
  try { fs.chmodSync(tmp, mode); } catch {}
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Token store — lives OUTSIDE the DB on purpose: the DB file itself gets
// overwritten by pulls, and each instance must keep an independent OAuth
// refresh chain (refresh_token rotates on every refresh).
// ---------------------------------------------------------------------------

function loadTokenRecord() {
  try {
    const raw = fs.readFileSync(tokenFilePath(), "utf8");
    const rec = JSON.parse(raw);
    return rec && rec.access_token ? rec : null;
  } catch {
    return null;
  }
}

function saveTokenRecord(rec) {
  atomicWriteJson(tokenFilePath(), { ...rec, updatedAt: new Date().toISOString() });
}

export function getTokenStatus() {
  const rec = loadTokenRecord();
  if (!rec) return { hasToken: false, needsReauth: false, expiresAt: null };
  return {
    hasToken: true,
    needsReauth: Boolean(rec.needsReauth),
    expiresAt: rec.expiresAt || null,
    scope: rec.scope || null,
    authorizedPaths: rec.authorized_paths || rec.authorizedPaths || null,
  };
}

function oauthError(json, fallback) {
  const desc = json?.error_description || json?.error || fallback || "OAuth request failed";
  return new BaiduPanError("auth", String(desc), { needsReauth: true });
}

export function buildAuthorizeUrl({ redirectUri } = {}) {
  const cfg = getSyncConfig();
  if (!cfg.appKey) throw new BaiduPanError("auth", "BAIDU_APP_KEY is not set");
  const ru = redirectUri || process.env.BAIDU_REDIRECT_URI || "oob";
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: cfg.appKey,
    redirect_uri: ru,
    scope: "basic,netdisk",
    display: "page",
  });
  return `${OAUTH_AUTHORIZE_URL}?${qs.toString()}`;
}

export async function exchangeCode(code, { redirectUri } = {}) {
  const cfg = getSyncConfig();
  const ru = redirectUri || process.env.BAIDU_REDIRECT_URI || "oob";
  const qs = new URLSearchParams({
    grant_type: "authorization_code",
    code: String(code || "").trim(),
    client_id: cfg.appKey,
    client_secret: cfg.secretKey,
    redirect_uri: ru,
  });
  let json;
  try {
    const res = await fetch(`${OAUTH_TOKEN_URL}?${qs.toString()}`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    throw new BaiduPanError("network", `Token exchange failed: ${e?.message ?? e}`);
  }
  if (!json.access_token) throw oauthError(json, "No access_token in exchange response");
  saveTokenRecord({
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 30 * 24 * 3600) * 1000 - REFRESH_LEAD_MS,
    scope: json.scope || "",
    authorized_paths: json.authorized_paths || [],
    needsReauth: false,
  });
  return { scope: json.scope || "", expiresAt: Date.now() + (Number(json.expires_in) || 0) * 1000 };
}

async function refreshAccessToken(record) {
  const cfg = getSyncConfig();
  const qs = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: record.refresh_token || "",
    client_id: cfg.appKey,
    client_secret: cfg.secretKey,
  });
  let json;
  try {
    const res = await fetch(`${OAUTH_TOKEN_URL}?${qs.toString()}`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    // Transport-level failure: the refresh may or may not have consumed the
    // token server-side. Keep it and retry next cycle; a definitive OAuth
    // error below marks needsReauth.
    throw new BaiduPanError("network", `Token refresh failed: ${e?.message ?? e}`);
  }
  if (!json.access_token) {
    // Per docs, a failed refresh invalidates the old refresh_token too.
    saveTokenRecord({ ...record, needsReauth: true });
    throw oauthError(json, "Refresh failed — re-authorization required");
  }
  // refresh_token is single-use: persist the NEW one before anything else.
  saveTokenRecord({
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 30 * 24 * 3600) * 1000 - REFRESH_LEAD_MS,
    scope: json.scope || record.scope || "",
    authorized_paths: json.authorized_paths || record.authorized_paths || [],
    needsReauth: false,
  });
}

export async function getAccessToken({ forceRefresh = false } = {}) {
  const rec = loadTokenRecord();
  if (!rec) {
    throw new BaiduPanError("auth", "No Baidu token yet — open /api/sync/baidu/authorize first", {
      needsReauth: true,
    });
  }
  if (rec.needsReauth) {
    throw new BaiduPanError("auth", "Token needs re-authorization — open /api/sync/baidu/authorize", {
      needsReauth: true,
    });
  }
  if (forceRefresh || !rec.expiresAt || rec.expiresAt <= Date.now()) {
    await refreshAccessToken(rec);
    return loadTokenRecord().access_token;
  }
  return rec.access_token;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function classifyBaiduErrno(errno) {
  if (errno === 0 || errno == null) return { kind: "ok" };
  if (errno === -6 || errno === 111066) return { kind: "auth", retryable: true };
  if (errno === 20012 || errno === 9013) return { kind: "throttled", retryable: true };
  if (errno === 20011 || errno === 20013 || errno === 31024) return { kind: "permission" };
  if (errno === -7 || errno === -8 || errno === 31079) return { kind: "path" };
  if (errno === 31066 || errno === 12 || errno === 31190) return { kind: "notfound" };
  if (errno === -10) return { kind: "storage" };
  return { kind: "api", retryable: true };
}

function errnoError(errno, context) {
  const c = classifyBaiduErrno(errno);
  return new BaiduPanError(c.kind, `${context} failed (errno=${errno})`, {
    errno,
    retryable: Boolean(c.retryable),
  });
}

function normalizeMd5(md5) {
  const s = String(md5 || "").replace(/^\//, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(s) ? s : null;
}

export { normalizeMd5 };

// Generic xpan/file call. `method` + access_token go in the query string; extra
// query params and/or a form body are appended as given.
async function xpanCall(method, { query = {}, form = null, timeoutMs = API_TIMEOUT_MS } = {}, accessToken) {
  const qs = new URLSearchParams({ method, access_token: accessToken, ...query });
  const url = `${XPAN_FILE_URL}?${qs.toString()}`;
  const init = { method: form ? "POST" : "GET", signal: AbortSignal.timeout(timeoutMs) };
  if (form) {
    init.body = new URLSearchParams(form).toString();
    init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new BaiduPanError("network", `${method} request failed: ${e?.message ?? e}`, { retryable: true });
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new BaiduPanError("api", `${method} returned non-JSON (HTTP ${res.status})`, { retryable: res.status >= 500 });
  }
  const errno = json && json.errno != null ? json.errno : json && json.error_code != null ? json.error_code : 0;
  const c = classifyBaiduErrno(errno);
  if (c.kind !== "ok") throw errnoError(errno, method);
  return json;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

// Stat a remote file by absolute path (1 API call). Returns
// null when the file does not exist, else { path, size, md5, serverMtime, dlink, fsId }.
export async function statRemoteFile(remotePath, accessToken) {
  let json;
  try {
    json = await xpanCall(
      "filemetas",
      { form: { target: JSON.stringify([remotePath]), dlink: 1, blocks: 0, media: 0 } },
      accessToken
    );
  } catch (e) {
    if (e instanceof BaiduPanError && (e.kind === "notfound" || e.kind === "path")) return null;
    throw e;
  }
  const list = Array.isArray(json?.list) ? json.list : [];
  const entry = list.find((it) => it && it.path === remotePath && Number(it.isdir) === 0);
  if (!entry) return null;
  return {
    path: entry.path,
    size: Number(entry.size) || 0,
    md5: normalizeMd5(entry.md5),
    serverMtime: Number(entry.server_mtime) || 0,
    dlink: entry.dlink || null,
    fsId: entry.fs_id != null ? Number(entry.fs_id) : null,
  };
}

// Create an intermediate directory (method=create with isdir=1 — no uploadid needed).
export async function createRemoteDir(dirPath, accessToken) {
  await xpanCall("create", { form: { path: dirPath, isdir: 1, size: 0, block_list: "[]" } }, accessToken);
  return true;
}

async function locateUploadBase(remotePath, accessToken, uploadid) {
  try {
    const json = await xpanCall(
      "locateupload",
      {
        query: {
          appid: LOCATE_UPLOAD_APPID,
          path: remotePath,
          uploadid: String(uploadid),
          upload_version: "2.0",
        },
      },
      accessToken
    );
    const candidates = [...(json?.servers || []), ...(json?.bak_servers || [])]
      .map((s) => (typeof s === "string" ? s : s?.server))
      .filter(Boolean);
    const pick = candidates.find((s) => String(s).startsWith("https://")) || candidates[0];
    if (pick) return String(pick).startsWith("http") ? pick : `https://${pick}`;
    return DEFAULT_UPLOAD_BASE;
  } catch (e) {
    console.warn(`[BAIDU_SYNC] locateupload failed (${e?.message ?? e}) — falling back to ${DEFAULT_UPLOAD_BASE}`);
    return DEFAULT_UPLOAD_BASE;
  }
}

async function postMultipart(url, blob, filename, timeoutMs) {
  const form = new FormData();
  form.append("file", new Blob([blob]), filename);
  let res;
  try {
    res = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new BaiduPanError("network", `Upload failed: ${e?.message ?? e}`, { retryable: true });
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new BaiduPanError("api", `Upload returned non-JSON (HTTP ${res.status})`, { retryable: res.status >= 500 });
  }
  const errno = json?.errno != null ? json.errno : json?.error_code != null ? json.error_code : 0;
  const c = classifyBaiduErrno(errno);
  if (c.kind !== "ok") throw errnoError(errno, "upload");
  return json;
}

// Chunked upload: precreate → superfile2 slices → create (rtype=3 overwrite).
// The only upload path — see the doc map at the top of this file.
export async function uploadChunked(remotePath, blob, accessToken) {
  const sliceCount = Math.ceil(blob.length / CHUNK_SIZE);
  const md5s = [];
  for (let i = 0; i < sliceCount; i++) {
    md5s.push(crypto.createHash("md5").update(blob.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)).digest("hex"));
  }
  const pre = await xpanCall(
    "precreate",
    {
      form: {
        path: remotePath,
        size: String(blob.length),
        isdir: "0",
        autoinit: "1",
        rtype: "3",
        block_list: JSON.stringify(md5s),
      },
    },
    accessToken
  );
  const uploadid = pre?.uploadid;
  if (!uploadid) throw new BaiduPanError("api", "precreate returned no uploadid");
  const seqs = Array.isArray(pre?.block_list) && pre.block_list.length ? pre.block_list : md5s.map((_, i) => i);
  const base = await locateUploadBase(remotePath, accessToken, uploadid);

  const returnedMd5 = new Array(sliceCount).fill(null);
  for (const seq of seqs) {
    const start = Number(seq) * CHUNK_SIZE;
    const slice = blob.subarray(start, Math.min(start + CHUNK_SIZE, blob.length));
    const qs = new URLSearchParams({
      method: "upload",
      type: "tmpfile",
      access_token: accessToken,
      path: remotePath,
      uploadid: String(uploadid),
      partseq: String(seq),
    });
    const json = await postMultipart(
      `${base}/rest/2.0/pcs/superfile2?${qs.toString()}`,
      slice,
      `part-${seq}`,
      TRANSFER_TIMEOUT_MS
    );
    returnedMd5[Number(seq)] = normalizeMd5(json.md5) || md5s[Number(seq)];
  }
  const finalBlockList = returnedMd5.map((m, i) => m || md5s[i]);
  const created = await xpanCall(
    "create",
    {
      form: {
        path: remotePath,
        size: String(blob.length),
        isdir: "0",
        rtype: "3",
        uploadid: String(uploadid),
        block_list: JSON.stringify(finalBlockList),
      },
    },
    accessToken
  );
  return {
    md5: normalizeMd5(created?.md5),
    size: blob.length,
    apiCalls: 3 + Number(seqs.length), // precreate + locateupload + create + slices
  };
}

export async function downloadByDlink(dlink, accessToken) {
  const url = dlink.includes("?") ? `${dlink}&access_token=${encodeURIComponent(accessToken)}` : `${dlink}?access_token=${encodeURIComponent(accessToken)}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": DOWNLOAD_USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
  } catch (e) {
    throw new BaiduPanError("network", `Download failed: ${e?.message ?? e}`, { retryable: true });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    let json = null;
    try { json = JSON.parse(buf.toString("utf8")); } catch {}
    const errno = json?.errno;
    if (errno != null) throw errnoError(errno, "download");
    throw new BaiduPanError("network", `Download failed (HTTP ${res.status})`, { retryable: res.status >= 500 });
  }
  // Baidu serves JSON error bodies with HTTP 200 on some failure paths.
  if (res.headers.get("content-type")?.includes("application/json") && buf.length < 4096) {
    try {
      const json = JSON.parse(buf.toString("utf8"));
      if (json?.errno != null && json.errno !== 0) throw errnoError(json.errno, "download");
    } catch (e) {
      if (e instanceof BaiduPanError) throw e;
    }
  }
  return buf;
}
