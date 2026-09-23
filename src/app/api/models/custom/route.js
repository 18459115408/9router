import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, deleteCustomModel } from "@/models";
import { CAPACITY_META } from "@/shared/constants/models";
import { refreshDeclaredCaps, THINKING_FORMATS, THINKING_LEVELS } from "open-sse/providers/customCapsOverride.js";

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

// GET /api/models/custom - List all custom models
export async function GET() {
  try {
    const models = await getCustomModels();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add custom model
export async function POST(request) {
  try {
    const { providerAlias, id, type, name, caps } = await request.json();
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    const cleanCaps = { ...(sanitizeCaps(caps) || {}), ...(sanitizeThinking(caps) || {}) };
    const added = await addCustomModel({
      providerAlias, id, type: type || "llm", name,
      ...(Object.keys(cleanCaps).length ? { caps: cleanCaps } : {}),
    });
    // Re-read the declarations so the change applies to the very next request
    // instead of waiting for the next refresh tick.
    await refreshDeclaredCaps().catch(() => {});
    return NextResponse.json({ success: true, added });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
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
    await refreshDeclaredCaps().catch(() => {});
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
