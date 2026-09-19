import { WORKBUDDY_CONFIG } from "../constants/oauth.js";

// WorkBuddy (international) — Browser OAuth Polling Flow, structurally identical
// to codebuddy-cn (same /v2/plugin/auth endpoints, same envelope, no PKCE).
// 1. POST stateUrl → get { state, authUrl }
// 2. Open authUrl in browser
// 3. Poll tokenUrl with state until success (code 0) or timeout
const workbuddy = {
  config: WORKBUDDY_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const response = await fetch(`${config.stateUrl}?platform=${config.platform}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.workbuddy.ai",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-Product": "WorkBuddy",
      },
      body: "{}",
    });
    if (!response.ok) throw new Error(`WorkBuddy state request failed: ${await response.text()}`);
    const data = await response.json();
    if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
      throw new Error(`WorkBuddy state error: ${data.msg || "missing state/authUrl"}`);
    }
    return {
      device_code: data.data.state,
      verification_uri: data.data.authUrl,
      user_code: "",
      interval: config.pollInterval / 1000,
      _isWorkBuddy: true,
    };
  },
  pollToken: async (config, deviceCode) => {
    // Like CodeBuddy, the token endpoint is polled via GET with the state as a
    // query param (not POST/body), matching the official client's
    // /v2/plugin/auth/token?state=...
    const response = await fetch(`${config.tokenUrl}?state=${encodeURIComponent(deviceCode)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.workbuddy.ai",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-No-Enterprise-Id": "true",
        "X-No-Department-Info": "true",
        "X-Product": "WorkBuddy",
      },
    });
    if (!response.ok) return { ok: false, data: { error: "request_failed" } };
    const data = await response.json();
    // code 11217 = pending (RetryFetchToken), code 0 = success
    if (data.code === 0 && data.data?.accessToken) {
      // uid/enterpriseId ride along in the token payload. Persisting them lets
      // the executor send X-User-Id and derive a per-account X-Machine-ID seed
      // that survives restarts (see executors/workbuddy.js).
      const account = data.data.account || data.data.user || {};
      return {
        ok: true,
        data: {
          access_token: data.data.accessToken,
          refresh_token: data.data.refreshToken || "",
          token_type: data.data.tokenType || "Bearer",
          expires_in: data.data.expiresIn,
          _wbUid: account.uid || data.data.uid || "",
          _wbEnterpriseId: account.enterpriseId || data.data.enterpriseId || "",
        },
      };
    }
    if (data.code === 11217) return { ok: true, data: { error: "authorization_pending" } };
    return { ok: false, data: { error: data.msg || "unknown_error" } };
  },
  mapTokens: (tokens) => {
    const providerSpecificData = {};
    if (tokens._wbUid) providerSpecificData.uid = tokens._wbUid;
    if (tokens._wbEnterpriseId) providerSpecificData.enterpriseId = tokens._wbEnterpriseId;
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in || 86400,
      providerSpecificData,
    };
  },
};

export default workbuddy;
