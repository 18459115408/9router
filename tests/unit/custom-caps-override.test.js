import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The reader is what turns stored customModels rows into the synchronous lookup
// capabilities.js calls. Its one non-obvious job is name normalization: rows are
// written under the dashboard alias (`cl`, `qd`, `ds`) while requests arrive
// carrying the provider id (`cline`, `qoder`, `deepseek`), and neither is
// derivable from the other — `ds` lives in the registry's aliases[].
const { getDeclaredCaps, refreshDeclaredCaps, setDeclaredCaps, __resetCustomCapsForTest } =
  await import("../../open-sse/providers/customCapsOverride.js");

const NODE = "openai-compatible-chat-0dcce5df-5d45-4c99-ae90-52ecefab4955";

let rows = [];
// Flip to make the mocked DB read throw — used to prove a transient failure
// does not wipe the declarations already in the cache.
let dbShouldThrow = false;
vi.mock("@/lib/db/index.js", () => ({
  getCustomModels: async () => {
    if (dbShouldThrow) throw new Error("db down");
    return rows;
  },
}));

beforeEach(() => {
  rows = [];
  dbShouldThrow = false;
  __resetCustomCapsForTest();
});

afterEach(() => __resetCustomCapsForTest());

describe("declared caps reader", () => {
  it("resolves a declaration stored under a custom node id", async () => {
    rows = [{ providerAlias: NODE, id: "step-5-preview", type: "llm", caps: { vision: true } }];
    await refreshDeclaredCaps();
    expect(getDeclaredCaps(NODE, "step-5-preview")).toEqual({ vision: true });
  });

  it("resolves a declaration stored under a provider alias from the request's provider id", async () => {
    rows = [
      { providerAlias: "ds", id: "deepseek-flash", type: "llm", caps: { vision: true } },
      { providerAlias: "qd", id: "qfmodel", type: "llm", caps: { vision: true } },
      { providerAlias: "cl", id: "some-model", type: "llm", caps: { vision: true } },
    ];
    await refreshDeclaredCaps();
    expect(getDeclaredCaps("deepseek", "deepseek-flash")).toEqual({ vision: true });
    expect(getDeclaredCaps("qoder", "qfmodel")).toEqual({ vision: true });
    expect(getDeclaredCaps("cline", "some-model")).toEqual({ vision: true });
  });

  it("also answers under the stored alias, whichever name a request arrives with", async () => {
    rows = [{ providerAlias: "ds", id: "deepseek-flash", type: "llm", caps: { vision: true } }];
    await refreshDeclaredCaps();
    expect(getDeclaredCaps("ds", "deepseek-flash")).toEqual({ vision: true });
  });

  it("normalizes vendor-prefixed and :free-suffixed model ids", async () => {
    rows = [{ providerAlias: NODE, id: "step-5-preview", type: "llm", caps: { vision: true } }];
    await refreshDeclaredCaps();
    expect(getDeclaredCaps(NODE, "stepfun/step-5-preview")).toEqual({ vision: true });
    expect(getDeclaredCaps(NODE, "step-5-preview:free")).toEqual({ vision: true });
  });

  it("ignores rows without caps and drops non-true values", async () => {
    rows = [
      { providerAlias: NODE, id: "no-caps", type: "llm" },
      { providerAlias: NODE, id: "explicit-false", type: "llm", caps: { vision: false } },
      { providerAlias: NODE, id: "junk", type: "llm", caps: { vision: "yes", bogus: true } },
    ];
    await refreshDeclaredCaps();
    expect(getDeclaredCaps(NODE, "no-caps")).toBeNull();
    expect(getDeclaredCaps(NODE, "explicit-false")).toBeNull();
    expect(getDeclaredCaps(NODE, "junk")).toBeNull();
  });

  it("keeps the previous cache when the database read fails", async () => {
    rows = [{ providerAlias: NODE, id: "step-5-preview", type: "llm", caps: { vision: true } }];
    await refreshDeclaredCaps();
    expect(getDeclaredCaps(NODE, "step-5-preview")).toEqual({ vision: true });

    // A transient read failure must leave the old declarations in place —
    // dropping them would start stripping the operator's images.
    dbShouldThrow = true;
    await refreshDeclaredCaps();
    expect(getDeclaredCaps(NODE, "step-5-preview")).toEqual({ vision: true });
  });

  it("updates one declaration in place without a full refresh", async () => {
    setDeclaredCaps(NODE, "step-5-preview", { vision: true });
    expect(getDeclaredCaps(NODE, "step-5-preview")).toEqual({ vision: true });
    setDeclaredCaps(NODE, "step-5-preview", null);
    expect(getDeclaredCaps(NODE, "step-5-preview")).toBeNull();
  });
});
