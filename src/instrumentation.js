export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    // Same mechanism for the operator's own capability declarations on custom
    // models — without it, any model the hand-written tables don't know (every
    // user-added compatible node) resolves to vision:false and has its images
    // replaced with a placeholder before the request leaves.
    const { installCustomCapsSource } = await import("open-sse/providers/customCapsOverride.js");
    await installCustomCapsSource();

    // Unified model-config store. Same reader mechanism, but authoritative: a
    // saved field overrides the built-in tables outright, including a `false`.
    // Installed after the declared-caps source so it supersedes it.
    const { installModelConfigSource } = await import("open-sse/providers/modelConfigOverride.js");
    await installModelConfigSource();

    // One-time lift of legacy `customModels` rows into the unified store, so an
    // install that predates it still resolves those declarations through the
    // new overlay. Guarded by a marker (once per database) and idempotent per
    // row; scripts/migrate-model-configs.mjs remains the audit / --force path.
    // A failure here must not stop the server, so it is contained: the lift
    // retries on the next boot.
    try {
      const { getCustomModels } = await import("@/models");
      const { liftLegacyRows } = await import("@/lib/db/repos/modelConfigRepo.js");
      const { refreshModelConfigSource } = await import("open-sse/providers/modelConfigOverride.js");
      const lifted = await liftLegacyRows(await getCustomModels());
      if (lifted.imported > 0) await refreshModelConfigSource();
    } catch (error) {
      console.warn(`[modelConfigs] legacy lift deferred: ${error.message}`);
    }

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Baidu Netdisk DB sync (per-instance scheduler; no-op unless configured).
    const { startBaiduSync } = await import("@/lib/sync/baidu/index.js");
    startBaiduSync();
  }
}
