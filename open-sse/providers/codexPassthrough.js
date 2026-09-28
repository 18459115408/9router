// Codex wire-shape fixups for the native-passthrough path.
//
// These used to be inline branches in the chat orchestrator, which meant the
// orchestrator had to know how Codex's request body differs. They are body
// rewrites rather than declarative switches, so they live here with the
// provider that owns the shape; the orchestrator just calls in.

import { applyThinking } from "../translator/concerns/thinkingUnified.js";

/**
 * Fold a thinking-level suffix into Codex's nested `reasoning.effort`.
 *
 * Codex reads effort from `reasoning.effort`, not the top-level
 * `reasoning_effort` the rest of the gateway speaks. A client that addresses the
 * model as `gpt-5.6-sol(high)` therefore has to be translated at the boundary,
 * and the top-level key deleted so the upstream never sees both.
 *
 * @param {object} body the outbound body (already model-stripped)
 * @param {string} sourceFormat
 * @param {string} upstreamModel Codex-side model id
 * @param {string} provider
 * @returns {object} the body, rewritten when an effort was resolved
 */
export function applyCodexPassthroughThinking(body, sourceFormat, upstreamModel, provider) {
  if (!body || typeof body !== "object") return body;

  const suffixThinking = {};
  applyThinking(sourceFormat, upstreamModel, suffixThinking, provider);
  if (!suffixThinking.reasoning_effort) return body;

  const next = { ...body };
  const reasoning = next.reasoning;
  next.reasoning = {
    ...(reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? reasoning : {}),
    effort: suffixThinking.reasoning_effort,
  };
  // The upstream must never see both spellings.
  delete next.reasoning_effort;
  return next;
}
