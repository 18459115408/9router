// WorkBuddy international (www.workbuddy.ai) — the WorkBuddy desktop product's
// own gateway, distinct from CodeBuddy IDE (codebuddy-intl, platform=ide) even
// though both share the same backend: a global token answers on workbuddy.ai and
// codebuddy.ai with an identical model catalog.
//
// CN accounts do NOT belong here — copilot.tencent.com is served by codebuddy-cn.
//
// Two upstream quirks drive the executor (see executors/workbuddy.js):
//   1. messages[0] must be a system message, and `developer` is rejected outright;
//   2. agent-identity system prompts trip the content filter (same as CN).
export default {
  id: "workbuddy",
  alias: "wb",
  uiAlias: "wb",
  hidden: false,
  priority: 90,
  display: {
    name: "WorkBuddy",
    icon: "smart_toy",
    color: "#0B5FFF",
    website: "https://www.workbuddy.ai",
    notice: {
      signupUrl: "https://www.workbuddy.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://www.workbuddy.ai/v2/chat/completions",
    forceStream: true,
    // Unified OpenAI-compatible gateway: every model (GPT, Gemini, GLM, Kimi,
    // MiniMax, DeepSeek, Hunyuan) takes reasoning as OpenAI-style
    // reasoning_effort, not its vendor-native thinking shape.
    thinkingFormat: "openai",
    // Fingerprint headers mirror the WorkBuddy desktop client. They are NOT an
    // admission gate (verified by removing each one in turn — every request
    // still answered 200); they exist to keep the traffic profile close to the
    // official client. Do not treat them as required when debugging.
    headers: {
      "User-Agent": "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1",
      "Accept-Language": "en-US",
      "X-Product": "WorkBuddy",
      "X-IDE-Type": "WorkBuddy",
      "X-IDE-Name": "WorkBuddy",
      "X-IDE-Version": "5.5.4",
      "X-Agent-Purpose": "conversation",
      "X-CodeBuddy-Request": "1",
      "X-No-Enterprise-Id": "1",
      "X-Domain": "www.workbuddy.ai",
      Origin: "https://www.workbuddy.ai",
      Referer: "https://www.workbuddy.ai/",
      "x-requested-with": "XMLHttpRequest",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    // Billing lives on the same host as chat (unlike CN, where chat is on
    // copilot.tencent.com and billing on www.codebuddy.cn). The envelope is
    // identical to CN's (data.Response.Data.Accounts[]), so the CN usage
    // handler serves both.
    usage: {
      url: "https://www.workbuddy.ai/v2/billing/meter/get-user-resource",
    },
  },
  // Catalog mirrors /v3/config's data.models[]. Entries the server no longer
  // publishes are dropped even when the chat endpoint still answers them — the
  // published list is the contract. The five *-model ids are server-side aliases
  // that pick a concrete model per request, so they are listed as-is.
  models: [
    { id: "default-model", name: "Auto" },
    { id: "fast-model", name: "Fast" },
    { id: "balanced-model", name: "Balanced" },
    { id: "primary-model", name: "Primary" },
    { id: "deep-model", name: "Deep" },
    { id: "gpt-6-astra", name: "GPT-6-Astra" },
    { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
    { id: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gemini-3.5-flash", name: "Gemini-3.5-Flash" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "kimi-k3", name: "Kimi-K3" },
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview" },
    { id: "kimi-k2.6", name: "Kimi-K2.6" },
    { id: "hy4-preview", name: "Hy4-Preview" },
    { id: "hy4-preview-f", name: "Hy4-Preview-F" },
    { id: "hy3", name: "Hy3" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash" },
    { id: "deepseek-v4.1-flash-sg", name: "DeepSeek-V4.1-Flash-SG" },
  ],
  oauth: {
    baseUrl: "https://www.workbuddy.ai",
    stateUrl: "https://www.workbuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.workbuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.workbuddy.ai/v2/plugin/auth/token/refresh",
    userAgent: "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1",
    platform: "CLI",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
