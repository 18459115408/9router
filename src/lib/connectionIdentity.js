import crypto from "crypto";
import { getProviderConnections } from "./db/repos/connectionsRepo.js";

// Two connections of the same provider are only genuinely separate accounts
// when they authenticate upstream as different users. A login that silently
// returns an already-authorized identity (e.g. an SSO session that was never
// switched) otherwise produces a second row that looks like a new account but
// shares the first one's quota — failover then rotates between labels of the
// same upstream user, and every "account" hits the same rate limit at once.

function rawCredential(conn) {
  return conn?.accessToken || conn?.apiKey || conn?.idToken || "";
}

export function credentialFingerprint(conn) {
  const raw = rawCredential(conn);
  if (typeof raw !== "string" || raw.length < 16) return null;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// The signature is deliberately not verified: the token was issued by the
// provider's identity provider and is already stored locally, so only the
// claims are read here.
function decodeJwtPayload(token) {
  if (typeof token !== "string" || !token.startsWith("eyJ")) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export function tokenIdentity(conn) {
  const payload = decodeJwtPayload(conn?.accessToken);
  const subject = payload?.sub;
  if (!subject) return null;
  return { subject: String(subject), email: payload.email || null, name: payload.name || null };
}

/**
 * Which connections of one provider share a credential.
 * Returns Map<connectionId, { of: { id, name }, reason }> where reason is
 * "same-token" (byte-identical credential) or "same-account" (a different
 * token that still resolves to the same upstream subject). Connections
 * without a usable credential are skipped.
 */
export function findCredentialDuplicates(connections = []) {
  const byProvider = new Map();
  for (const conn of connections) {
    if (!conn?.id) continue;
    const fingerprint = credentialFingerprint(conn);
    const identity = tokenIdentity(conn);
    if (!fingerprint && !identity) continue;
    const bucket = byProvider.get(conn.provider) || [];
    bucket.push({ conn, fingerprint, identity });
    byProvider.set(conn.provider, bucket);
  }

  const duplicates = new Map();
  for (const bucket of byProvider.values()) {
    for (const entry of bucket) {
      let match = bucket.find(o => o !== entry && o.fingerprint && o.fingerprint === entry.fingerprint);
      let reason = "same-token";
      if (!match && entry.identity) {
        match = bucket.find(o => o !== entry && o.identity && o.identity.subject === entry.identity.subject);
        reason = "same-account";
      }
      if (match) {
        duplicates.set(entry.conn.id, {
          of: { id: match.conn.id, name: match.conn.name || match.conn.email || match.conn.id },
          reason,
        });
      }
    }
  }
  return duplicates;
}

/**
 * Duplicate info for one freshly created connection, resolved against its
 * current siblings. Never throws — detection must not break a login flow.
 */
export async function findDuplicateForConnection(connection) {
  if (!connection?.id || !connection?.provider) return null;
  try {
    const siblings = await getProviderConnections({ provider: connection.provider });
    return findCredentialDuplicates(siblings).get(connection.id) || null;
  } catch {
    return null;
  }
}
