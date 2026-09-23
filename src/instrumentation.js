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

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Baidu Netdisk DB sync (per-instance scheduler; no-op unless configured).
    const { startBaiduSync } = await import("@/lib/sync/baidu/index.js");
    startBaiduSync();
  }
}
