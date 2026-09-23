// TEMP debug — reproduce requestDetails row loss. Delete after diagnosis.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-debug-rd-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });
  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();
});

afterAll(() => {
  if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function countRows() {
  const r = adapter.get("SELECT COUNT(*) c FROM requestDetails");
  return r ? r.c : -1;
}

describe("debug row loss", () => {
  it("saves with delays, checks each", async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    await db.saveRequestDetail({ id: "dbg-1", provider: "openai", model: "m", status: "ok", tokens: {}, request: {}, response: {} });
    await sleep(300);
    console.log("after dbg-1 (300ms):", countRows());

    await db.saveRequestDetail({ id: "dbg-2", provider: "anthropic", model: "m", status: "ok", tokens: {}, request: {}, response: {} });
    await sleep(300);
    console.log("after dbg-2 (300ms):", countRows());

    // rapid-fire 5 saves with NO delay (mimic real request bursts)
    for (let i = 0; i < 5; i++) {
      db.saveRequestDetail({ id: `burst-${i}`, provider: "wb", model: "m", status: "ok", tokens: {}, request: {}, response: {} });
    }
    await sleep(500);
    console.log("after burst of 5 (500ms):", countRows());

    // oversized field
    const huge = "x".repeat(20 * 1024);
    await db.saveRequestDetail({ id: "dbg-big", provider: "openai", model: "g", status: "ok", tokens: {}, request: { blob: huge }, response: {} });
    await sleep(300);
    const big = await db.getRequestDetailById("dbg-big");
    console.log("dbg-big row:", big ? JSON.stringify({ request: big.request, keys: Object.keys(big) }) : "ROW MISSING");

    const rows = adapter.all("SELECT id FROM requestDetails ORDER BY id").map((r) => r.id);
    console.log("final ids:", rows.join(","));
    expect(true).toBe(true);
  });
});
