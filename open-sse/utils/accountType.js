// Account-type detection for tunnel-only behavior gating.
//
// Subscription tunnels (OAuth / personal access tokens) spend a fixed monthly
// quota and need client-identity disguise (Claude Code system line, fabricated
// warmup/title replies, tool cloaking). API-key connections are metered per
// byte: those rewrites are pure contamination there and must never run, so
// every tunnel-only behavior gates on this helper instead of firing for all
// accounts of a provider.

export function isSubscriptionCredentials(credentials) {
  if (!credentials || typeof credentials !== "object") return false;
  const authType = String(credentials.authType || "").toLowerCase().replace(/_/g, "");
  if (authType === "oauth" || authType === "accesstoken") return true;
  // Legacy rows without authType: a connection carrying only an account token
  // (no API key) is a tunnel.
  if (!authType && credentials.accessToken && !credentials.apiKey) return true;
  return false;
}
