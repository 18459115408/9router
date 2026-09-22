// panClient unit tests with a stubbed global fetch — verifies token rotation
// semantics (single-use refresh_token), errno classification, stat/upload/download.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  BAIDU_APP_KEY: process.env.BAIDU_APP_KEY,
  BAIDU_SECRET_KEY: process.env.BAIDU_SECRET_KEY,
  BAIDU_SYNC_KEY: process.env.BAIDU_SYNC_KEY,
};
let tempDir;
let panClient;

function tokenFile() {
  return path.join(tempDir, "baidu-sync", "token.json");
}

function writeToken(rec) {
  fs.mkdirSync(path.join(tempDir, "baidu-sync"), { recursive: true });
  fs.writeFileSync(tokenFile(), JSON.stringify(rec));
}

function readToken() {
  return JSON.parse(fs.readFileSync(tokenFile(), "utf8"));
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-baidu-pc-"));
  process.env.DATA_DIR = tempDir;
  process.env.BAIDU_APP_KEY = "test-appkey";
  process.env.BAIDU_SECRET_KEY = "test-secret";
  process.env.BAIDU_SYNC_KEY = "testkey";
  vi.resetModules();
  panClient = await import("@/lib/sync/baidu/panClient.js");
});

afterAll(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe("baidu pan client", () => {
  it("classifies errnos into retry/backoff kinds", () => {
    expect(panClient.classifyBaiduErrno(0).kind).toBe("ok");
    expect(panClient.classifyBaiduErrno(-6).kind).toBe("auth");
    expect(panClient.classifyBaiduErrno(111066).kind).toBe("auth");
    expect(panClient.classifyBaiduErrno(20012).kind).toBe("throttled");
    expect(panClient.classifyBaiduErrno(9013).kind).toBe("throttled");
    expect(panClient.classifyBaiduErrno(20013).kind).toBe("permission");
    expect(panClient.classifyBaiduErrno(-7).kind).toBe("path");
    expect(panClient.classifyBaiduErrno(31066).kind).toBe("notfound");
  });

  it("normalizes baidu slash-md5 values", () => {
    expect(panClient.normalizeMd5("/ABCDEF0123456789abcdef0123456789")).toBe(
      "abcdef0123456789abcdef0123456789"
    );
    expect(panClient.normalizeMd5("not-a-hash")).toBeNull();
    expect(panClient.normalizeMd5(null)).toBeNull();
  });

  it("rotates refresh_token on refresh and persists the NEW one immediately", async () => {
    writeToken({
      access_token: "old-at",
      refresh_token: "R1",
      expiresAt: Date.now() - 1000, // expired → refresh on next getAccessToken
    });
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        calls.push(String(url));
        return jsonResponse({ access_token: "new-at", refresh_token: "R2", expires_in: 2592000, scope: "basic" });
      })
    );
    const at = await panClient.getAccessToken();
    expect(at).toBe("new-at");
    expect(calls[0]).toContain("grant_type=refresh_token");
    expect(calls[0]).toContain("refresh_token=R1");
    const saved = readToken();
    expect(saved.refresh_token).toBe("R2"); // old R1 must be replaced
    expect(saved.access_token).toBe("new-at");
    expect(saved.needsReauth).toBeFalsy();
  });

  it("marks needsReauth when the refresh definitively fails", async () => {
    writeToken({ access_token: "at", refresh_token: "R1", expiresAt: Date.now() - 1000 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid_grant", error_description: "expired token" }))
    );
    await expect(panClient.getAccessToken()).rejects.toMatchObject({ kind: "auth", needsReauth: true });
    expect(readToken().needsReauth).toBe(true);
  });

  it("throws an auth error with authorize hint when no token exists", async () => {
    fs.rmSync(tokenFile(), { force: true });
    await expect(panClient.getAccessToken()).rejects.toMatchObject({ kind: "auth", needsReauth: true });
  });

  it("stats a remote file by path and normalizes the md5", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          errno: 0,
          // filemetas answers with `info`, not `list` — mocking `list` here is what
          // let a push-only sync ship: stat always returned null, so nothing pulled.
          info: [
            {
              path: "/apps/9router/9router-sync/data.sqlite.enc",
              size: 123,
              md5: "/abcdef0123456789abcdef0123456789",
              server_mtime: 1690000000,
              isdir: 0,
              dlink: "https://d.pcs.baidu.com/file/x?fid=1",
            },
          ],
        });
      })
    );
    const stat = await panClient.statRemoteFile("/apps/9router/9router-sync/data.sqlite.enc", "tk");
    expect(stat.size).toBe(123);
    expect(stat.md5).toBe("abcdef0123456789abcdef0123456789");
    expect(stat.serverMtime).toBe(1690000000);
    expect(stat.dlink).toContain("d.pcs.baidu.com");
    const call = calls[0];
    expect(call.url).toContain("method=filemetas");
    const body = new URLSearchParams(call.init.body);
    expect(body.get("target")).toBe(JSON.stringify(["/apps/9router/9router-sync/data.sqlite.enc"]));
    expect(body.get("dlink")).toBe("1");
  });

  it("returns null for a missing remote file (31066)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errno: 31066 })));
    expect(await panClient.statRemoteFile("/apps/9router/9router-sync/data.sqlite.enc", "tk")).toBeNull();
  });

  it("returns null when filemetas answers with an empty info array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errno: 0, info: [] })));
    expect(await panClient.statRemoteFile("/apps/9router/9router-sync/data.sqlite.enc", "tk")).toBeNull();
  });

  it("chunked upload runs precreate → superfile2 → create and returns the created md5", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.includes("method=precreate")) {
          return jsonResponse({ errno: 0, uploadid: "UPLOAD-ID", block_list: [0] });
        }
        if (u.includes("method=locateupload")) {
          return jsonResponse({ error_code: 0, servers: [{ server: "d.pcs.baidu.com" }] });
        }
        if (u.includes("superfile2")) {
          return jsonResponse({ md5: "11111111111111111111111111111111" });
        }
        return jsonResponse({ errno: 0, md5: "22222222222222222222222222222222", size: 11 });
      })
    );

    const out = await panClient.uploadChunked(
      "/apps/9router/9router-sync/data.sqlite.enc",
      Buffer.from("hello world"),
      "tk"
    );

    expect(out.md5).toBe("22222222222222222222222222222222");
    expect(out.apiCalls).toBe(4); // precreate + locateupload + superfile2 + create

    const encodedPath = encodeURIComponent("/apps/9router/9router-sync/data.sqlite.enc");
    expect(calls[0].url).toContain("method=precreate");
    expect(String(calls[0].init.body)).toContain("rtype=3");
    expect(String(calls[0].init.body)).toContain(`path=${encodedPath}`);

    const sliceUrl = calls.find((c) => c.url.includes("superfile2")).url;
    expect(sliceUrl).toContain("type=tmpfile");
    expect(sliceUrl).toContain("partseq=0");

    const createCall = calls[calls.length - 1];
    expect(createCall.url).toContain("method=create");
    expect(String(createCall.init.body)).toContain("uploadid=UPLOAD-ID");
  });

  it("download sends the required User-Agent and appends the access_token", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(Buffer.from("blob-bytes"), { headers: { "content-type": "application/octet-stream" } });
      })
    );
    const buf = await panClient.downloadByDlink("https://d.pcs.baidu.com/file/x?fid=1", "tk");
    expect(buf.toString()).toBe("blob-bytes");
    expect(calls[0].init.headers["User-Agent"]).toBe("pan.baidu.com");
    expect(calls[0].url).toContain("access_token=tk");
  });

  it("builds an authorize URL with oob redirect by default", () => {
    const url = panClient.buildAuthorizeUrl();
    expect(url).toContain("client_id=test-appkey");
    expect(url).toContain("redirect_uri=oob");
    expect(url).toContain("scope=basic");
  });

  it("exchanges a code and stores tokens", async () => {
    fs.rmSync(tokenFile(), { force: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ access_token: "at1", refresh_token: "r1", expires_in: 2592000, scope: "basic,netdisk" }))
    );
    const info = await panClient.exchangeCode("some-code");
    expect(info.scope).toBe("basic,netdisk");
    const saved = readToken();
    expect(saved.access_token).toBe("at1");
    expect(saved.refresh_token).toBe("r1");
  });
});
