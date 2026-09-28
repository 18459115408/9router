import { NextResponse } from "next/server";
import { suggestModelConfig, setSuggestCatalogSource } from "open-sse/providers/suggestModelConfig.js";
import { getStoredConfig } from "open-sse/providers/modelConfigOverride.js";
import { isConfigLocked } from "@/lib/db/modelConfigSchema.js";
import { resolveProviderId } from "@/shared/constants/providers.js";

export const dynamic = "force-dynamic";

// Enable the catalog half of the suggestion. installCatalogSource() has already
// validated the file at startup, so this is a switch rather than a read.
setSuggestCatalogSource(true);

/**
 * GET /api/models/suggest?providerAlias=xxx&id=yyy
 *
 * Propose a starting config for a model the operator is adding. Built-in tables
 * and the synced catalog answer; whatever they hold is returned as a pre-fill
 * with its provenance, and `found:false` says plainly that they hold nothing so
 * the form does not imply otherwise.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }

    // The built-in capability tables are keyed by registry provider id
    // (`workbuddy`), while routing reads are keyed by the alias (`wb`) — the two
    // subsystems never agree on the spelling, so suggestModelConfig takes both.
    // Passing the alias alone resolves the caps against a table that does not
    // exist and silently pre-fills the floor instead.
    const providerId = resolveProviderId(providerAlias);
    const suggestion = suggestModelConfig(providerAlias, id, { providerId });

    // An existing row is the operator's own saved config and outranks any
    // suggestion — the form must pre-fill from it, not from the tables.
    const existing = getStoredConfig(providerAlias, id);
    if (existing) {
      return NextResponse.json({
        found: true,
        source: existing.source,
        caps: existing.caps || {},
        routing: {},
        existing: true,
        locked: isConfigLocked(existing),
      });
    }

    return NextResponse.json({ ...suggestion, existing: false, locked: false });
  } catch (error) {
    console.log("Error suggesting model config:", error);
    return NextResponse.json({ error: "Failed to suggest model config" }, { status: 500 });
  }
}
