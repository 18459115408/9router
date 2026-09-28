import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getCustomModels: vi.fn(async () => []),
  addCustomModel: vi.fn(async () => ({ added: true })),
  deleteCustomModel: vi.fn(async () => ({})),
  getModelConfigs: vi.fn(async () => []),
  upsertModelConfig: vi.fn(async () => true),
  deleteModelConfig: vi.fn(async () => true),
  refreshDeclaredCaps: vi.fn(async () => {}),
  refreshModelConfigSource: vi.fn(async () => {}),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("@/models", () => ({
  getCustomModels: mocks.getCustomModels,
  addCustomModel: mocks.addCustomModel,
  deleteCustomModel: mocks.deleteCustomModel,
}));

vi.mock("@/lib/db/repos/modelConfigRepo.js", () => ({
  getModelConfigs: mocks.getModelConfigs,
  upsertModelConfig: mocks.upsertModelConfig,
  deleteModelConfig: mocks.deleteModelConfig,
}));

vi.mock("open-sse/providers/customCapsOverride.js", () => ({
  refreshDeclaredCaps: mocks.refreshDeclaredCaps,
  THINKING_FORMATS: [],
  THINKING_LEVELS: [],
}));

vi.mock("open-sse/providers/modelConfigOverride.js", () => ({
  refreshModelConfigSource: mocks.refreshModelConfigSource,
}));

const { GET, POST } = await import("../../src/app/api/models/custom/route.js");

function post(body) {
  return { json: async () => body };
}

const LOCKED_ROW = { providerAlias: "wb", id: "primary-model", type: "llm", source: "provider", caps: { vision: true } };

describe("GET /api/models/custom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("annotates each row with the unified store's provenance", async () => {
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "wb", id: "primary-model", type: "llm", name: "primary-model" },
      { providerAlias: "wb", id: "mine", type: "llm", name: "mine" },
    ]);
    mocks.getModelConfigs.mockResolvedValue([
      { ...LOCKED_ROW, type: "llm" },
      { providerAlias: "wb", id: "mine", type: "llm", source: "operator" },
    ]);

    const response = await GET();

    expect(response.body.models[0]).toMatchObject({ id: "primary-model", source: "provider", locked: true });
    expect(response.body.models[1]).toMatchObject({ id: "mine", source: "operator", locked: false });
  });

  it("leaves a row with no unified config unannotated rather than guessing", async () => {
    mocks.getCustomModels.mockResolvedValue([{ providerAlias: "wb", id: "plain", type: "llm" }]);
    mocks.getModelConfigs.mockResolvedValue([]);

    const response = await GET();

    expect(response.body.models[0].locked).toBeUndefined();
    expect(response.body.models[0].source).toBeUndefined();
  });
});

describe("POST /api/models/custom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getModelConfigs.mockResolvedValue([]);
  });

  it("refuses an edit to a locked row that does not unlock it", async () => {
    // The row-list editors used to post caps with no `source`, which made the
    // route's operator default silently re-own every provider-sourced row.
    mocks.getModelConfigs.mockResolvedValue([LOCKED_ROW]);

    const response = await POST(post({ providerAlias: "wb", id: "primary-model", caps: { vision: false } }));

    expect(response.status).toBe(409);
    expect(mocks.addCustomModel).not.toHaveBeenCalled();
    expect(mocks.upsertModelConfig).not.toHaveBeenCalled();
  });

  it("lets the provider re-publish its own config on a locked row", async () => {
    mocks.getModelConfigs.mockResolvedValue([LOCKED_ROW]);

    const response = await POST(post({ providerAlias: "wb", id: "primary-model", source: "provider", caps: { vision: false } }));

    expect(response.status).toBe(200);
    expect(mocks.upsertModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({ source: "provider", caps: { vision: false } })
    );
  });

  it("lets an explicit unlock through", async () => {
    mocks.getModelConfigs.mockResolvedValue([LOCKED_ROW]);

    const response = await POST(post({ providerAlias: "wb", id: "primary-model", source: "operator", caps: {} }));

    expect(response.status).toBe(200);
    expect(mocks.upsertModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({ source: "operator" })
    );
  });

  it("writes an unlocked edit as operator-owned", async () => {
    const response = await POST(post({ providerAlias: "wb", id: "mine", caps: { vision: false } }));

    expect(response.status).toBe(200);
    expect(mocks.upsertModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({ providerAlias: "wb", id: "mine", source: "operator", caps: { vision: false } })
    );
  });
});
