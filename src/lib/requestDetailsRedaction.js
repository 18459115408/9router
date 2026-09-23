/**
 * Payload redaction for the request-details API.
 *
 * Stored request details include full conversation payloads (user prompts, tool
 * calls, completions). `/api/usage/request-details` is reachable by anyone when
 * `requireLogin` is disabled, and the dashboard may be exposed through a tunnel,
 * so the payloads are stripped by default and only the metadata (model, tokens,
 * latency, status) is returned.
 *
 * Single-user local installs can opt out via the `observabilityRedactPayloads`
 * setting to inspect raw request/response bodies in the details drawer.
 */

export const REDACTED_PAYLOAD_KEYS = [
  "request",
  "providerRequest",
  "providerResponse",
  "response",
];

/**
 * Replace conversation payload fields with a `{ redacted: true }` marker.
 *
 * @param {Array<object>|null|undefined} details - Rows from getRequestDetails().
 * @param {{ redact?: boolean }} [options] - `redact: false` returns rows as-is.
 * @returns {Array<object>} Rows safe to serialize to the client.
 */
export function redactRequestDetails(details, { redact = true } = {}) {
  const rows = details || [];
  if (!redact) return rows;

  return rows.map((detail) => {
    const redacted = { ...detail };
    for (const key of REDACTED_PAYLOAD_KEYS) {
      if (redacted[key] !== undefined) {
        redacted[key] = { redacted: true };
      }
    }
    return redacted;
  });
}
