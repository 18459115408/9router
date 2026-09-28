import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, deleteCustomModel } from "@/models";
import { CAPACITY_META } from "@/shared/constants/models";
import { refreshDeclaredCaps, THINKING_FORMATS, THINKING_LEVELS } from "open-sse/providers/customCapsOverride.js";
import { refreshModelConfigSource } from "open-sse/providers/modelConfigOverride.js";
import { upsertModelConfig, deleteModelConfig, getModelConfigs } from "@/lib/db/repos/modelConfigRepo.js";
import { sanitizeModelConfig, isConfigLocked, ALL_CAPABILITY_KEYS } from "@/lib/db/modelConfigSchema.js";

export const dynamic = "force-dynamic";

// Whitelist capability keys to boolean values — ignore anything else.
// `null` is preserved: it means "delete this capability" for the store's merge.
function sanitizeCaps(caps) {
  if (!caps || typeof caps !== "object") return null;
  const clean = {};
  for (const key of Object.keys(CAPACITY_META)) {
    if (typeof caps[key] === "boolean") clean[key] = caps[key];
    else if (caps[key] === null) clean[key] = null;
  }
  return Object.keys(clean).length ? clean : null;
}

// Thinking config travels alongside the booleans in the same `caps` object.
// Validated here so a typo cannot reach the request path; the runtime sanitizes
// again on read, so a row written by an older version is still safe.
function sanitizeThinking(caps) {
  if (!caps || typeof caps !== "object") return null;
  const clean = {};
  if (typeof caps.thinkingFormat === "string" && THINKING_FORMATS.includes(caps.thinkingFormat)) {
    clean.thinkingFormat = caps.thinkingFormat;
  } else if (caps.thinkingFormat === null) {
    clean.thinkingFormat = null;
  }
  if (typeof caps.thinkingCanDisable === "boolean") clean.thinkingCanDisable = caps.thinkingCanDisable;
  if (Array.isArray(caps.thinkingLevels)) {
    const levels = [...new Set(caps.thinkingLevels.filter((l) => typeof l === "string" && THINKING_LEVELS.includes(l)))];
    clean.thinkingLevels = levels.length ? levels : null;
  } else if (caps.thinkingLevels === null) {
    clean.thinkingLevels = null;
  }
  if (caps.thinkingMapping && typeof caps.thinkingMapping === "object" && !Array.isArray(caps.thinkingMapping)) {
    clean.thinkingMapping = caps.thinkingMapping;
  } else if (caps.thinkingMapping === null) {
    clean.thinkingMapping = null;
  }
  return Object.keys(clean).length ? clean : null;
}

// The unified store accepts exactly the capability keys the schema defines.
// Import that list rather than keeping a second copy here — a hand-maintained
// duplicate is how the routing keys came to be accepted by this route and
// dropped by the schema at the same time. Transport (target format, upstream
// id, strip list, quota family, quirks) is not on the list: the row is the
// capability answer, and the registry — where those values are actually read —
// stays the routing source. sanitizeModelConfig drops anything unknown or
// ill-typed on top of this, so junk never reaches the store either way.
function sanitizeUnified(caps) {
  if (!caps || typeof caps !== "object") return null;
  const clean = {};
  for (const key of ALL_CAPABILITY_KEYS) {
    if (caps[key] !== undefined) clean[key] = caps[key];
  }
  return Object.keys(clean).length ? clean : null;
}

// GET /api/models/custom - List all custom models
//
// Each row is annotated with its unified-store provenance (`source`, `locked`)
// so a surface can tell a provider-supplied row — which mirrors the upstream
// and is read-only until unlocked — from one the operator owns. Without this
// the row list cannot know a row is locked and offers edits that the write
// path then has to refuse.
export async function GET() {
  try {
    const models = await getCustomModels();
    // The store is keyed `alias|id|type` → row, so it comes back as an object,
    // not an array.
    const byKey = new Map(Object.values(await getModelConfigs()).map((c) => [`${c.providerAlias}|${c.id}|${c.type || "llm"}`, c]));
    const annotated = (models || []).map((model) => {
      const stored = byKey.get(`${model.providerAlias}|${model.id}|${model.type || "llm"}`);
      return stored ? { ...model, source: stored.source, locked: isConfigLocked(stored) } : model;
    });
    return NextResponse.json({ models: annotated });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add or edit custom model
//
// Writes both stores: `customModels` (legacy, still read by the dashboard's
// model list and the declared-caps path) and `modelConfigs` (the unified store
// the request path resolves from first). The legacy write keeps every existing
// reader working; the unified write is what makes the row authoritative.
export async function POST(request) {
  try {
    const { providerAlias, id, type, name, caps, source } = await request.json();
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }

    // A provider-supplied row is read-only until it is explicitly unlocked, so
    // an edit must not be able to re-own it as a side effect. The row list used
    // to post caps with no `source`, which made the default below silently flip
    // every locked row to the operator's — and mutate caps the operator was
    // never shown as locked. The check sits here, in the one writer both stores
    // go through, so no surface can route around it: on a locked row, only
    // re-publishing the provider's own config or an explicit unlock is allowed.
    const rowType = type || "llm";
    const existing = Object.values(await getModelConfigs({ fresh: true }))
      .find((c) => c.providerAlias === providerAlias && c.id === id && (c.type || "llm") === rowType);
    if (isConfigLocked(existing) && source !== "provider" && source !== "operator") {
      return NextResponse.json(
        { error: "This row mirrors the provider's config — unlock it before editing" },
        { status: 409 }
      );
    }

    const cleanCaps = { ...(sanitizeCaps(caps) || {}), ...(sanitizeThinking(caps) || {}) };
    const added = await addCustomModel({
      providerAlias, id, type: type || "llm", name,
      ...(Object.keys(cleanCaps).length ? { caps: cleanCaps } : {}),
    });

    // A provider-supplied row is read-only until explicitly unlocked, so honour
    // an explicit `source` here; otherwise an operator edit is the default.
    const unified = sanitizeModelConfig({
      providerAlias, id, type: type || "llm", name: name || id,
      source: source === "provider" || source === "builtin" ? source : "operator",
      caps: sanitizeUnified(caps),
    });
    if (unified) await upsertModelConfig(unified);

    // Refresh both readers so the change applies to the very next request
    // instead of waiting for the next refresh tick.
    await refreshDeclaredCaps().catch(() => {});
    await refreshModelConfigSource().catch(() => {});
    return NextResponse.json({ success: true, added });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
//
// Removes from both stores. Dropping the unified row is what actually restores
// built-in behaviour, so it must not be skipped when the legacy row is absent.
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    const type = searchParams.get("type") || "llm";
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    await deleteCustomModel({ providerAlias, id, type });
    await deleteModelConfig({ providerAlias, id, type });
    await refreshDeclaredCaps().catch(() => {});
    await refreshModelConfigSource().catch(() => {});
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
