// usageHistory retention. The table gains one row per request and nothing else
// trims it, so the repo caps it on insert (oldest rows dropped past the cap).
// Uses a throwaway DATA_DIR — the same pattern as db-concurrent.test.js — so
// the real install's history is never touched, and the injectable env cap keeps
// the test fast.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-retention-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(async () => {
  if (process.env.USAGE_HISTORY_MAX_RECORDS !== undefined) delete process.env.USAGE_HISTORY_MAX_RECORDS;
  // Release the SQLite handle before removing the directory — node:sqlite keeps
  // the file open until close(), and rmSync on Windows EPERMs otherwise
  // (db-concurrent.test.js has failed that way since long before this file).
  try {
    const { getAdapter } = await import("@/lib/db/driver.js");
    (await getAdapter()).close();
  } catch {}
  try {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("usageHistory retention", () => {
  it("keeps the newest rows and drops the oldest past the cap", async () => {
    process.env.USAGE_HISTORY_MAX_RECORDS = "5";
    // Distinct timestamps and models: the dedup check sees eight separate
    // requests, exactly the growth the cap is there to bound.
    for (let i = 0; i < 8; i++) {
      await db.saveRequestUsage({
        provider: "openai", model: `m${i}`, connectionId: "c1",
        tokens: { prompt_tokens: 1, completion_tokens: 1 },
        endpoint: "/v1/chat", status: "ok",
        timestamp: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      });
    }

    const models = (await db.getUsageHistory({ provider: "openai" })).map((h) => h.model).sort();
    expect(models).toEqual(["m3", "m4", "m5", "m6", "m7"]);
  });
});
