import { createHash } from "node:crypto";
import { DefaultExecutor } from "./default.js";

// Neutral system prompt used when the client's first message isn't a system
// message. Upstream rejects such requests with 11-128 "first message is not
// system prompt", so the executor prepends one — the same fallback the official
// client applies before sending.
const FALLBACK_SYSTEM = "You are a helpful AI assistant that helps with software engineering tasks.";

// Agent-identity system prompts are replaced with the neutral one above. This
// mirrors codebuddy-cn, where the gateway is known to flag CLI agent prompts.
// NOTE: not reproducible against workbuddy.ai in isolation — every agent prompt
// tried (including a full Claude Code prompt) answered 200, and the 11-128 seen
// elsewhere comes from the `developer` role, not from the text. Kept because it
// is cheap, matches the sibling provider, and the filter may be
// context-dependent (long conversations, tool calls) in ways a single-turn probe
// cannot reach.
const NEUTRAL_PROMPT = "You are a helpful AI assistant that helps with software engineering tasks.";
const AGENT_PATTERN = /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|you are .{0,30}(?:powerful )?ai agent|orchestration capabilities|OhMyOpenCode|<agent-identity>|<Role>|<Behavior_Instructions>/i;

// Flatten message content to text for pattern matching; shape is preserved on
// replacement so the client's format (string vs typed blocks) survives.
function flatten(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n");
  }
  return "";
}

// Stable per-account device identifiers. The seed is the account uid when known
// (persisted at OAuth time), else the connection id — both survive restarts and
// differ per account, so upstream's risk scoring sees one steady device per
// account instead of a blank device dimension. Purpose is mixed into the hash so
// the machine and session ids differ from each other, mirroring the reference
// implementation's shape.
function deriveStableId(purpose, seed) {
  return createHash("sha256").update(`9r:wb:${purpose}:${seed}`).digest("hex").slice(0, 36);
}

/**
 * Device/identity headers for a WorkBuddy account, derived from its stored
 * credentials. Shared with the usage path so chat and billing present the same
 * device profile. Refresh and model fetches must NOT use this — upstream treats
 * an auth-class device header as a suspicious client.
 *
 * @param {object} providerSpecificData - connection's providerSpecificData
 * @param {string} [connectionId] - fallback seed when no uid is stored
 * @returns {object} header fragment (empty when nothing can be derived)
 */
export function deriveWorkBuddyDeviceHeaders(providerSpecificData, connectionId) {
  const specific = providerSpecificData || {};
  const headers = {};
  const seed = specific.uid || connectionId;
  if (seed) {
    headers["X-Machine-ID"] = deriveStableId("machine", seed);
    headers["X-Session-ID"] = deriveStableId("session", seed);
  }
  if (specific.uid) headers["X-User-Id"] = specific.uid;
  if (specific.enterpriseId) {
    headers["X-Enterprise-Id"] = specific.enterpriseId;
    headers["X-No-Enterprise-Id"] = null; // caller drops nulls
  }
  if (specific.deviceToken) headers["X-Device-Token"] = specific.deviceToken;
  return headers;
}

/**
 * WorkBuddyExecutor — talks to https://www.workbuddy.ai/v2/chat/completions
 *
 * The gateway is OpenAI-compatible but stream-only (a non-stream request is
 * rejected with 400 "Non-stream chat request is currently not supported"), and
 * it requires messages[0] to be a system message. 9router still re-aggregates
 * the SSE into a JSON response for non-streaming clients.
 */
export class WorkBuddyExecutor extends DefaultExecutor {
  constructor() {
    super("workbuddy");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const messages = Array.isArray(transformed.messages) ? transformed.messages : [];

    // `developer` is not an accepted role upstream (400, code 11-128) — it must
    // be downgraded to `system` rather than dropped, so its content still counts.
    let normalized = messages.map((message) => {
      if (!message || typeof message !== "object" || message.role !== "developer") return message;
      return { ...message, role: "system" };
    });

    // Neutralize agent-identity system prompts before the ordering fix below, so
    // an injected fallback is never itself rewritten.
    normalized = normalized.map((message) => {
      if (!message || message.role !== "system") return message;
      const text = flatten(message.content);
      if (!text) return message;
      if (text.length > 2000 || AGENT_PATTERN.test(text)) {
        return typeof message.content === "string"
          ? { ...message, content: NEUTRAL_PROMPT }
          : { ...message, content: [{ type: "text", text: NEUTRAL_PROMPT }] };
      }
      return message;
    });

    // Upstream requires the FIRST message to be a system message; anything else
    // (including an empty list) is rejected with 11-128. Prepend a fallback
    // rather than rebuilding the list, so later system messages and the client's
    // content shape are preserved.
    if (!normalized[0] || normalized[0].role !== "system") {
      normalized = [{ role: "system", content: FALLBACK_SYSTEM }, ...normalized];
    }
    transformed.messages = normalized;

    // Reasoning is surfaced via OpenAI-style params. The gateway has no "none"
    // level, so an explicit off request just omits the field; an explicit on
    // request mirrors the official client's reasoning_summary so the model's
    // reasoning is returned.
    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    return transformed;
  }

  buildHeaders(credentials, stream = true, url, model) {
    const headers = super.buildHeaders(credentials, stream, url, model);
    const overlay = deriveWorkBuddyDeviceHeaders(
      credentials?.providerSpecificData,
      credentials?.connectionId,
    );
    for (const [key, value] of Object.entries(overlay)) {
      if (value === null) delete headers[key];
      else headers[key] = value;
    }
    return headers;
  }
}

export default WorkBuddyExecutor;
