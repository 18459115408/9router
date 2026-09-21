// Two-instance sync simulation with a mocked Baidu client and real SQLite
// adapters (one temp DATA_DIR per instance, fresh module registry each).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  BAIDU_APP_KEY: process.env.BAIDU_APP_KEY,
  BAIDU_SECRET_KEY: process.env.BAIDU_SECRET_KEY,
  BAIDU_SYNC_KEY: process.env.BAIDU_SYNC_KEY,
};
const temps = [];

beforeAll(() => {
  process.env.BAIDU_APP_KEY = "test-appkey";
  process.env.BAIDU_SECRET_KEY = "test-secret";
  process.env.BAIDU_SYNC_KEY = "testkey";
});

afterAll(() => {
  for (const t of temps) {
    try { fs.rmSync(t, { recursive: true, force: true }); } catch {}
  }
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const md5hex = (buf) => crypto.createHash("md5").update(buf).digest("hex");

async function freshInstance(label) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `9router-baidu-${label}-`));
  temps.push(tempDir);
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter; // driver.js singleton keyed on global — reset per instance
  vi.resetModules();
  const driver = await import("@/lib/db/driver.js");
  const engine = await import("@/lib/sync/baidu/engine.js");
  const adapter = await driver.getAdapter();
  return { tempDir, adapter, engine };
}

const REMOTE_PATH = "/apps/9router/9router-sync/data.sqlite.enc";

function mockClient({ remoteBlob = null, remoteMd5 = null, serverMtime = 0, uploads = [] }) {
  return {
    async getAccessToken() {
      return "test-token";
    },
    getRemoteFilePath() {
      return REMOTE_PATH;
    },
    async statRemoteFile() {
      if (!remoteBlob) return null;
      return {
        path: REMOTE_PATH,
        size: remoteBlob.length,
        md5: remoteMd5,
        serverMtime,
        dlink: "mock://dlink",
        fsId: 1,
      };
    },
    async downloadByDlink() {
      return remoteBlob;
    },
    async uploadChunked(p, blob) {
      uploads.push(Buffer.from(blob));
      return { md5: md5hex(blob), size: blob.length, apiCalls: 3 };
    },
    async createRemoteDir() {
      return true;
    },
  };
}

describe("baidu sync engine", () => {
  it("pushes an encrypted snapshot on the first cycle", async () => {
    const A = await freshInstance("a");
    await A.adapter.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [JSON.stringify({ foo: "bar" })]);
    await A.adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, promptTokens, completionTokens, cost, status) VALUES(?,?,?,?,?,?,?)`,
      [new Date().toISOString(), "openai", "gpt-test", 10, 5, 0.01, "ok"]
    );
    await A.adapter.run(
      `INSERT INTO requestDetails(id, timestamp, data) VALUES(?,?,?)`,
      ["rd-A", new Date().toISOString(), "{}"]
    );

    const uploads = [];
    const res = await A.engine.runCycle({ adapter: A.adapter, client: mockClient({ uploads }) });
    expect(res.pushed).toBe(true);
    expect(res.pulled).toBe(false);
    expect(uploads).toHaveLength(1);

    const { decryptBuffer } = await import("@/lib/sync/baidu/crypto.js");
    const plain = decryptBuffer(uploads[0], "testkey");
    expect(plain.subarray(0, 15).toString("utf8")).toBe("SQLite format 3");

    const state = A.engine.loadState();
    expect(state.lastPushedHash).toBeTruthy();
    expect(state.lastPushedBlobMd5).toBe(md5hex(uploads[0]));
  });

  it("does not re-push unchanged content", async () => {
    const A = await freshInstance("b");
    await A.adapter.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [JSON.stringify({ foo: "bar" })]);
    const uploads = [];
    const client = mockClient({ uploads });
    await A.engine.runCycle({ adapter: A.adapter, client });
    const res2 = await A.engine.runCycle({ adapter: A.adapter, client });
    expect(res2.pushed).toBe(false);
    expect(uploads).toHaveLength(1);
  });

  it("pulls and applies a newer remote snapshot, keeping excluded tables local", async () => {
    // Machine A pushes settings + usageHistory.
    const A = await freshInstance("c");
    await A.adapter.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [JSON.stringify({ foo: "from-A" })]);
    await A.adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, status) VALUES(?,?,?)`,
      [new Date().toISOString(), "anthropic", "ok"]
    );
    const uploads = [];
    await A.engine.runCycle({ adapter: A.adapter, client: mockClient({ uploads }) });
    const blob = uploads[0];

    // Machine B has its own local state + a machine-local requestDetails row.
    const B = await freshInstance("d");
    await B.adapter.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [JSON.stringify({ foo: "local-B" })]);
    await B.adapter.run(
      `INSERT INTO requestDetails(id, timestamp, data) VALUES(?,?,?)`,
      ["rd-B", new Date().toISOString(), "{}"]
    );

    const clientB = mockClient({ remoteBlob: blob, remoteMd5: md5hex(blob), serverMtime: Math.floor(Date.now() / 1000) });
    const res = await B.engine.runCycle({ adapter: B.adapter, client: clientB });
    expect(res.pulled).toBe(true);

    expect(JSON.parse(B.adapter.get(`SELECT data FROM settings WHERE id=1`).data)).toEqual({ foo: "from-A" });
    expect(B.adapter.get(`SELECT COUNT(*) c FROM usageHistory`).c).toBe(1);
    expect(B.adapter.get(`SELECT COUNT(*) c FROM requestDetails`).c).toBe(1); // machine-local, untouched

    // A pre-apply backup archive was written.
    const { BACKUPS_DIR } = await import("@/lib/db/paths.js");
    const backups = fs.readdirSync(BACKUPS_DIR).filter((n) => n.startsWith("sync-apply-"));
    expect(backups.length).toBeGreaterThan(0);

    // Second cycle: nothing to pull (same md5 already applied), nothing to push.
    const res2 = await B.engine.runCycle({ adapter: B.adapter, client: clientB });
    expect(res2.pulled).toBe(false);
    expect(res2.pushed).toBe(false);
  });

  it("skips pull when the remote blob is undecryptable (never wipes local data)", async () => {
    const B = await freshInstance("e");
    await B.adapter.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [JSON.stringify({ foo: "keep-me" })]);
    const wrongKeyBlob = (await import("@/lib/sync/baidu/crypto.js")).encryptBuffer(
      fs.readFileSync((await import("@/lib/db/paths.js")).DATA_FILE),
      "a-different-key"
    );
    const client = mockClient({
      remoteBlob: wrongKeyBlob,
      remoteMd5: md5hex(wrongKeyBlob),
      serverMtime: Math.floor(Date.now() / 1000),
    });
    const res = await B.engine.runCycle({ adapter: B.adapter, client });
    expect(res.pulled).toBe(false);
    expect(JSON.parse(B.adapter.get(`SELECT data FROM settings WHERE id=1`).data)).toEqual({ foo: "keep-me" });
    expect(B.engine.loadState().lastError).toContain("pull-decrypt-failed");
  });

  it("computes a stable logical hash that ignores excluded tables", async () => {
    const A = await freshInstance("f");
    const { computeLogicalHash } = A.engine;
    await A.adapter.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [JSON.stringify({ v: 1 })]);
    const h1 = computeLogicalHash(A.adapter, ["requestDetails"]);
    await A.adapter.run(
      `INSERT INTO requestDetails(id, timestamp, data) VALUES(?,?,?)`,
      ["rd-x", new Date().toISOString(), "{}"]
    );
    expect(computeLogicalHash(A.adapter, ["requestDetails"])).toBe(h1);
    await A.adapter.run(`UPDATE settings SET data=? WHERE id=1`, [JSON.stringify({ v: 2 })]);
    expect(computeLogicalHash(A.adapter, ["requestDetails"])).not.toBe(h1);
  });

  it("pull decisions: fresh adopts, own upload and already-applied are skipped", async () => {
    const A = await freshInstance("g");
    const { shouldPull } = A.engine;
    expect(shouldPull({}, { md5: "aa", serverMtime: Math.floor(Date.now() / 1000) })).toBe(true); // fresh instance
    expect(
      shouldPull(
        { lastPushedBlobMd5: "aa", lastPushedAt: Date.now() },
        { md5: "aa", serverMtime: Math.floor(Date.now() / 1000) }
      )
    ).toBe(false); // our own upload
    expect(
      shouldPull(
        { lastAppliedRemoteMtime: Date.now() + 10_000 },
        { md5: "bb", serverMtime: Math.floor((Date.now() - 60_000) / 1000) }
      )
    ).toBe(false); // not newer than what we applied
    expect(
      shouldPull(
        { lastAppliedRemoteMtime: Date.now() - 3600_000 },
        { md5: "cc", serverMtime: Math.floor(Date.now() / 1000) }
      )
    ).toBe(true); // foreign and newer
  });

  it("backoff doubles per throttled failure and resets on success", async () => {
    const A = await freshInstance("h");
    const { getNextDelayMs, noteThrottleFailure, loadState, runCycle } = A.engine;
    const interval = 30 * 60 * 1000;
    // Establish a push baseline so a later successful cycle has nothing to push.
    await runCycle({ adapter: A.adapter, client: mockClient({ uploads: [] }) });
    noteThrottleFailure();
    noteThrottleFailure();
    expect(getNextDelayMs(loadState(), interval)).toBe(interval * 4);
    expect(getNextDelayMs(loadState(), interval)).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
    // runCycle success resets the level
    const res = await runCycle({ adapter: A.adapter, client: mockClient({ uploads: [] }) });
    expect(res.pushed).toBe(false);
    expect(res.pulled).toBe(false);
    expect(loadState().throttleLevel).toBe(0);
  });

  it("skips the cycle when unconfigured", async () => {
    const A = await freshInstance("i");
    delete process.env.BAIDU_SYNC_KEY;
    try {
      const res = await A.engine.runCycle({ adapter: A.adapter, client: mockClient({}) });
      expect(res.status).toBe("skipped");
      expect(res.reason).toContain("BAIDU_SYNC_KEY");
    } finally {
      process.env.BAIDU_SYNC_KEY = "testkey";
    }
  });
});
