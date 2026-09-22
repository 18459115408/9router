// Stable per-instance shard id for multi-machine usage merging (usageDaily
// byMachine buckets, totalRequestsLifetime:<id> keys).
//
// Derived from DATA_DIR/machine-id — the same file shared/utils/machineId.js
// persists — because a regenerating id would open a fresh shard on every
// process start, and a key inside _meta would be synced to the other machines
// and make two instances write the same shard (single-writer is what makes
// shard merges safe). Falls back to minting that file ourselves; whichever
// module initializes first defines the value, the other adopts it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../../dataDir.js";

let cachedShardId = null;

export function getSyncMachineId() {
  if (cachedShardId) return cachedShardId;
  const file = path.join(DATA_DIR, "machine-id");
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8").trim(); } catch {}
  if (!raw) {
    raw = crypto.randomUUID();
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, raw, { mode: 0o600 });
    } catch {}
  }
  cachedShardId = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return cachedShardId;
}
