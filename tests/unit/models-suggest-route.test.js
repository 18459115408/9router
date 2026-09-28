import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  suggestModelConfig: vi.fn(() => ({ found: false, source: "none", caps: {}, routing: {}, detail: {} })),
  setSuggestCatalogSource: vi.fn(),
  getStoredConfig: vi.fn(() => null),
  isConfigLocked: vi.fn(() => false),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("open-sse/providers/suggestModelConfig.js", () => ({
  suggestModelConfig: mocks.suggestModelConfig,
  setSuggestCatalogSource: mocks.setSuggestCatalogSource,
}));

vi.mock("open-sse/providers/modelConfigOverride.js", () => ({
  getStoredConfig: mocks.getStoredConfig,
}));

vi.mock("@/lib/db/modelConfigSchema.js", () => ({
  isConfigLocked: mocks.isConfigLocked,
}));

const { GET } = await import("../../src/app/api/models/suggest/route.js");

function request(params) {
  return { url: `http://localhost/api/models/suggest?${params}` };
}

describe("GET /api/models/suggest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStoredConfig.mockReturnValue(null);
    mocks.isConfigLocked.mockReturnValue(false);
  });

  it("rejects a request missing either parameter", async () => {
    await GET(request("providerAlias=wb"));

    expect(mocks.json).toHaveBeenCalledWith(
      { error: "providerAlias and id required" },
      { status: 400 }
    );
  });

  it("resolves the storage alias to the registry id before proposing", async () => {
    // The capability tables are keyed by registry id while the store/dashboard
    // spelling is the alias; passing the alias straight through makes every
    // registry provider pre-fill the floor instead of its real entry.
    await GET(request("providerAlias=wb&id=primary-model"));

    expect(mocks.suggestModelConfig).toHaveBeenCalledWith("wb", "primary-model", {
      providerId: "workbuddy",
    });
  });

  it("passes a compatible provider's id through untouched", async () => {
    // Compatible providers are stored under their own id, which is not in the
    // provider table — resolving must be a no-op for them, not a silent miss.
    await GET(request("providerAlias=some-custom-node&id=gpt-4o"));

    expect(mocks.suggestModelConfig).toHaveBeenCalledWith("some-custom-node", "gpt-4o", {
      providerId: "some-custom-node",
    });
  });

  it("pre-fills an existing row and outranks any suggestion", async () => {
    mocks.getStoredConfig.mockReturnValue({ source: "operator", caps: { vision: false } });
    mocks.isConfigLocked.mockReturnValue(true);

    const response = await GET(request("providerAlias=wb&id=primary-model"));

    expect(response.body).toEqual({
      found: true,
      source: "operator",
      caps: { vision: false },
      routing: {},
      existing: true,
      locked: true,
    });
  });
});
