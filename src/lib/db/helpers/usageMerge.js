// usageDaily sharding + merge helpers, shared by the write path
// (repos/usageRepo.saveRequestUsage) and the sync apply path
// (sync/baidu/engine.applySnapshot).
//
// Model: every instance writes ONLY its own shard (doc.byMachine[machineId]);
// the top-level counters and by* dimensions are always recomputed as the sum
// of shards, so read paths keep seeing the same shape as before. Pull-merge
// takes the newer copy per shard — a shard has a single writer and grows
// monotonically, so the two copies of it are prefixes of one line: newer-wins
// is idempotent (re-applying the same snapshot changes nothing) and self-heals
// a stale cloud overwrite. That is why two blobs are never naively SUMmed:
// a re-applied snapshot would double-count.
import { parseJson, stringifyJson } from "./jsonCol.js";

export const COUNTER_FIELDS = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost"];
const DIMENSIONS = ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint"];

export function emptyDayShard() {
  return {
    requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
  };
}

function hasContent(doc) {
  return (
    COUNTER_FIELDS.some((f) => Number(doc[f]) > 0) ||
    DIMENSIONS.some((d) => doc[d] && Object.keys(doc[d]).length > 0)
  );
}

// Accepts a stored blob (string) or an object; always returns a doc with a
// byMachine map. A pre-shard blob is folded into a shared "legacy" shard: both
// instances converted from the same synced value, so the fold makes their
// copies equal (merge keeps either — no double count); a legacy blob that
// diverged under the old last-writer-wins keeps the larger counter, i.e. the
// old outcome, never a sum of overlapping counts.
export function normalizeDailyDoc(data) {
  const doc = parseJson(data, null);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { byMachine: {} };
  if (doc.byMachine && typeof doc.byMachine === "object") return doc;
  const byMachine = {};
  if (hasContent(doc)) {
    const shard = emptyDayShard();
    for (const f of COUNTER_FIELDS) shard[f] = Number(doc[f]) || 0;
    for (const d of DIMENSIONS) if (doc[d] && typeof doc[d] === "object") shard[d] = doc[d];
    shard.ts = 0;
    byMachine.legacy = shard;
  }
  return { byMachine };
}

// Rebuild top-level counters and by* dimensions as the sum over shards.
// Dimension entries merge field-wise: counters add up, meta fields
// (rawModel/provider/endpoint/apiKey) are derived from the key itself, so the
// first shard's copy is kept.
export function recomputeDayTotals(doc) {
  const total = emptyDayShard();
  for (const shard of Object.values(doc.byMachine || {})) {
    if (!shard || typeof shard !== "object") continue;
    for (const f of COUNTER_FIELDS) total[f] += Number(shard[f]) || 0;
    for (const d of DIMENSIONS) mergeCountersInto(total[d], shard[d]);
  }
  for (const f of COUNTER_FIELDS) doc[f] = total[f];
  for (const d of DIMENSIONS) doc[d] = total[d];
  return doc;
}

function mergeCountersInto(dst, src) {
  if (!src || typeof src !== "object") return;
  for (const [k, v] of Object.entries(src)) {
    if (!v || typeof v !== "object") continue;
    if (!dst[k]) {
      dst[k] = { ...v };
      continue;
    }
    for (const f of COUNTER_FIELDS) dst[k][f] = (Number(dst[k][f]) || 0) + (Number(v[f]) || 0);
  }
}

// Two copies of the same single-writer shard: ts orders them (the owner bumps
// ts on every write), requests breaks the legacy tie where ts is 0 on both
// sides, and a final lexicographic tie-break makes a still-equal-content
// choice identical from either machine's view — "local wins" would let two
// instances keep overwriting each other forever on a divergent legacy blob.
export function pickNewerShard(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = Number(a.ts) || 0;
  const tb = Number(b.ts) || 0;
  if (ta !== tb) return ta > tb ? a : b;
  const ra = Number(a.requests) || 0;
  const rb = Number(b.requests) || 0;
  if (ra !== rb) return ra > rb ? a : b;
  const sa = stringifyJson(a);
  const sb = stringifyJson(b);
  return sa <= sb ? a : b;
}

// Merge two stored usageDaily blobs. Returns the merged stored string.
// `localNewerShards` (optional array) collects dateKeys where the LOCAL side
// contributed something the remote copy does not have — the caller uses it to
// decide whether the merged union must be pushed back to the cloud.
export function mergeUsageDailyDocs(localData, remoteData, localNewerShards = null) {
  const L = normalizeDailyDoc(localData);
  const R = normalizeDailyDoc(remoteData);
  const doc = { byMachine: {} };
  const ids = new Set([...Object.keys(L.byMachine || {}), ...Object.keys(R.byMachine || {})]);
  for (const id of ids) {
    const a = L.byMachine[id];
    const b = R.byMachine[id];
    doc.byMachine[id] = pickNewerShard(a, b);
    if (localNewerShards && a && (!b || (doc.byMachine[id] === a && stringifyJson(a) !== stringifyJson(b)))) {
      localNewerShards.push(id);
    }
  }
  recomputeDayTotals(doc);
  return stringifyJson(doc);
}

// Move (usageRepo's former private helpers) — aggregation writes into exactly
// one shard; top-level totals come from recomputeDayTotals afterwards.
export function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

export function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal = entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null } });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}
