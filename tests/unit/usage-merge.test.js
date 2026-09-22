// Pure-helper tests for the sharded usageDaily merge (no DB, no sync engine).
import { describe, expect, it } from "vitest";
import {
  aggregateEntryToDay,
  emptyDayShard,
  mergeUsageDailyDocs,
  normalizeDailyDoc,
  pickNewerShard,
  recomputeDayTotals,
} from "@/lib/db/helpers/usageMerge.js";

const shard = (overrides = {}) => ({ ...emptyDayShard(), ts: 1, ...overrides });
const asBlob = (byMachine) => JSON.stringify({ byMachine });

describe("usageDaily shard merge", () => {
  it("sums two machines' shards into one top-level total", () => {
    const a = asBlob({ m1: shard({ requests: 8, promptTokens: 100000000, ts: 10 }) });
    const b = asBlob({ m2: shard({ requests: 3, promptTokens: 50000000, ts: 20 }) });
    const merged = JSON.parse(mergeUsageDailyDocs(a, b));
    expect(merged.promptTokens).toBe(150000000);
    expect(merged.requests).toBe(11);
    expect(Object.keys(merged.byMachine).sort()).toEqual(["m1", "m2"]);
    // shard values survive untouched — only top-level is derived
    expect(merged.byMachine.m1.requests).toBe(8);
    expect(merged.byMachine.m2.requests).toBe(3);
  });

  it("is idempotent: re-merging the same remote changes nothing", () => {
    const local = asBlob({ m1: shard({ promptTokens: 10, ts: 10 }) });
    const remote = asBlob({ m2: shard({ promptTokens: 5, ts: 20 }) });
    const once = mergeUsageDailyDocs(local, remote);
    const twice = mergeUsageDailyDocs(once, remote);
    expect(twice).toBe(once);
    expect(JSON.parse(once).promptTokens).toBe(15);
  });

  it("keeps the newer copy per shard and flags local-ahead content for re-push", () => {
    // Our copy of m1 (ts 30) is ahead of a stale cloud copy (ts 10).
    const local = asBlob({ m1: shard({ promptTokens: 300, ts: 30 }) });
    const remote = asBlob({ m1: shard({ promptTokens: 100, ts: 10 }) });
    const flags = [];
    const merged = JSON.parse(mergeUsageDailyDocs(local, remote, flags));
    expect(merged.byMachine.m1.promptTokens).toBe(300); // stale remote must not roll us back
    expect(flags).toContain("m1"); // cloud lacks our newer count ⇒ push back
  });

  it("does not flag identical shards", () => {
    const local = asBlob({ m1: shard({ promptTokens: 100, ts: 10 }) });
    const flags = [];
    mergeUsageDailyDocs(local, JSON.stringify(JSON.parse(local)), flags);
    expect(flags).toEqual([]);
  });

  it("folds equal legacy blobs into one shared shard without double counting", () => {
    const legacy = JSON.stringify({
      requests: 9, promptTokens: 900, completionTokens: 0, cachedTokens: 0, cost: 0,
      byProvider: {}, byModel: { "g|p": { requests: 9, promptTokens: 900, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: "g", provider: "p" } },
      byAccount: {}, byApiKey: {}, byEndpoint: {},
    });
    const merged = JSON.parse(mergeUsageDailyDocs(legacy, legacy));
    expect(merged.promptTokens).toBe(900); // not 1800 — same synced value on both sides
    expect(merged.byMachine.legacy.requests).toBe(9);
    expect(merged.byModel["g|p"].promptTokens).toBe(900);
    expect(merged.byModel["g|p"].rawModel).toBe("g"); // meta carried through
  });

  it("keeps the larger of two diverged legacy blobs (old LWW outcome, never a sum)", () => {
    const smaller = JSON.stringify({ requests: 5, promptTokens: 500, completionTokens: 0, cost: 0, byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {} });
    const larger = JSON.stringify({ requests: 7, promptTokens: 700, completionTokens: 0, cost: 0, byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {} });
    expect(JSON.parse(mergeUsageDailyDocs(smaller, larger)).promptTokens).toBe(700);
    expect(JSON.parse(mergeUsageDailyDocs(larger, smaller)).promptTokens).toBe(700);
  });

  it("tie-breaks deterministically regardless of argument order (no push war)", () => {
    const a = { ...emptyDayShard(), requests: 5, promptTokens: 100, ts: 0 };
    const b = { ...emptyDayShard(), requests: 5, promptTokens: 200, ts: 0 };
    expect(pickNewerShard(a, b)).toBe(pickNewerShard(b, a)); // same canonical pick from either machine
  });

  it("normalizes garbage and empty input", () => {
    expect(normalizeDailyDoc(null)).toEqual({ byMachine: {} });
    expect(normalizeDailyDoc("not json")).toEqual({ byMachine: {} });
    expect(normalizeDailyDoc(JSON.stringify({ requests: 0, cost: 0, byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {} }))).toEqual({ byMachine: {} });
  });

  it("aggregates entries into one shard with top-level equal to the shard sum", () => {
    const doc = { byMachine: { m1: emptyDayShard() } };
    aggregateEntryToDay(doc.byMachine.m1, {
      model: "g", provider: "p", cost: 0.5, endpoint: "ep",
      tokens: { prompt_tokens: 7, completion_tokens: 3, cache_read_input_tokens: 2 },
    });
    recomputeDayTotals(doc);
    expect(doc.requests).toBe(1);
    expect(doc.promptTokens).toBe(7);
    expect(doc.completionTokens).toBe(3);
    expect(doc.cachedTokens).toBe(2);
    expect(doc.cost).toBe(0.5);
    expect(doc.byModel["g|p"].promptTokens).toBe(7);
    expect(doc.byEndpoint["ep|g|p"].promptTokens).toBe(7);
  });
});
