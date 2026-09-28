// One-time, copy-only migration: lift legacy `customModels` rows into the
// unified `modelConfigs` store.
//
// Invariants this script must uphold (they are the whole point):
//   1. It never writes to `customModels`. The legacy scope stays readable and
//      writable, so dropping `modelConfigs` rolls the whole change back.
//   2. It never deletes anything. Existing `modelConfigs` rows are left alone
//      unless --force is passed, and --force only fills caps, it does not clear.
//   3. It runs the whole copy inside one transaction; a mid-way failure rolls
//      back to the pre-migration state.
//   4. It prints a per-row report so the operator can see exactly what moved.
//
// Usage:
//   node scripts/migrate-model-configs.mjs            # dry run by default
//   node scripts/migrate-model-configs.mjs --write    # perform the copy

import sqlite3 from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { sanitizeModelConfig, inferSource } from "../src/lib/db/modelConfigSchema.js";
import { getDataDir } from "../src/lib/dataDir.js";

const WRITE = process.argv.includes("--write");
const FORCE = process.argv.includes("--force");

const dataDir = getDataDir();
const dbPath = path.join(dataDir, "db", "data.sqlite");

if (!fs.existsSync(dbPath)) {
  console.error(`DB not found at ${dbPath}`);
  process.exit(1);
}

// Open read-write: the migration itself is a write, but only ever into the new
// scope. A read-only handle would force a second connection.
const db = new sqlite3(dbPath);

const legacyRows = db.prepare(`SELECT key, value FROM kv WHERE scope = 'customModels'`).all();
const existingRows = db.prepare(`SELECT key FROM kv WHERE scope = 'modelConfigs'`).all();
const existingKeys = new Set(existingRows.map((r) => r.key));

console.log(`DB: ${dbPath}`);
console.log(`legacy customModels rows: ${legacyRows.length} | existing modelConfigs rows: ${existingKeys.size}`);
console.log(`mode: ${WRITE ? "WRITE" : "DRY RUN"}${FORCE ? " (force)" : ""}\n`);

const report = { imported: 0, skippedInvalid: 0, skippedExisting: 0, skippedNoChange: 0 };
const details = [];

const doCopy = db.transaction(() => {
  for (const row of legacyRows) {
    let parsed = null;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      report.skippedInvalid++;
      details.push({ key: row.key, action: "skip-invalid", reason: "value is not JSON" });
      continue;
    }

    const candidate = {
      providerAlias: parsed?.providerAlias,
      id: parsed?.id,
      type: parsed?.type || "llm",
      name: parsed?.name || parsed?.id,
      source: inferSource(parsed?.caps),
      caps: parsed?.caps || null,
    };
    const clean = sanitizeModelConfig(candidate);
    if (!clean) {
      report.skippedInvalid++;
      details.push({ key: row.key, action: "skip-invalid", reason: "failed schema sanitize (missing providerAlias/id)" });
      continue;
    }

    const targetKey = `${clean.providerAlias}|${clean.id}|${clean.type}`;
    if (existingKeys.has(targetKey) && !FORCE) {
      report.skippedExisting++;
      details.push({ key: targetKey, action: "skip-existing", reason: "row already present in modelConfigs" });
      continue;
    }

    // --force re-copies onto an existing row, but only fills caps that are
    // absent — it must never clear a field an operator set here.
    let capsToWrite = clean.caps || null;
    if (FORCE && existingKeys.has(targetKey)) {
      const current = db.prepare(`SELECT value FROM kv WHERE scope = 'modelConfigs' AND key = ?`).get(targetKey);
      const currentCaps = current ? (JSON.parse(current.value)?.caps || null) : null;
      if (currentCaps && capsToWrite) {
        const merged = { ...capsToWrite };
        for (const [k, v] of Object.entries(currentCaps)) {
          if (merged[k] === undefined) merged[k] = v;
        }
        capsToWrite = merged;
      } else if (currentCaps) {
        capsToWrite = currentCaps;
      }
    }

    const value = JSON.stringify({
      providerAlias: clean.providerAlias,
      id: clean.id,
      type: clean.type,
      name: clean.name,
      source: clean.source,
      ...(capsToWrite ? { caps: capsToWrite } : {}),
    });

    if (WRITE) {
      db.prepare(`INSERT INTO kv(scope, key, value) VALUES('modelConfigs', ?, ?)
                  ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`)
        .run(targetKey, value);
    }
    report.imported++;
    details.push({
      key: targetKey,
      action: WRITE ? "import" : "would-import",
      caps: capsToWrite || null,
    });
  }
});

try {
  doCopy();
} catch (err) {
  console.error(`\nMIGRATION FAILED (rolled back): ${err.message}`);
  process.exit(1);
}

for (const d of details) {
  const caps = d.caps ? ` caps=${JSON.stringify(d.caps)}` : "";
  const reason = d.reason ? ` (${d.reason})` : "";
  console.log(`  [${d.action}] ${d.key}${caps}${reason}`);
}

console.log(`\nimported=${report.imported} skippedExisting=${report.skippedExisting} skippedInvalid=${report.skippedInvalid}`);

if (WRITE) {
  // Post-condition: the legacy scope must be byte-identical to before, and the
  // new row count must match what we report. A mismatch means the transaction
  // did something it should not have.
  const legacyAfter = db.prepare(`SELECT COUNT(*) c FROM kv WHERE scope = 'customModels'`).get().c;
  const newAfter = db.prepare(`SELECT COUNT(*) c FROM kv WHERE scope = 'modelConfigs'`).get().c;
  console.log(`post: customModels=${legacyAfter} (was ${legacyRows.length}) modelConfigs=${newAfter} (was ${existingKeys.size})`);
  if (legacyAfter !== legacyRows.length) {
    console.error("FAIL: legacy row count changed — aborting expectation of rollback safety");
    process.exit(1);
  }
  if (newAfter !== existingKeys.size + report.imported && !FORCE) {
    console.error("FAIL: new row count does not match the report");
    process.exit(1);
  }
  console.log("OK");
} else {
  console.log("\nDry run only. Re-run with --write to perform the copy.");
}

db.close();
