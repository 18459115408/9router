"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";

// Wire formats the runtime understands, with a human hint about what each one
// sends. Mirrors THINKING_FORMATS in open-sse/providers/customCapsOverride.js —
// keep the two in step.
export const FORMAT_OPTIONS = [
  { value: "", label: "自动（按模型名推断）", hint: "让网关按内置规则决定，等于不声明" },
  { value: "openai", label: "OpenAI reasoning_effort", hint: '发送 reasoning_effort: "low" | "high" …' },
  { value: "deepseek", label: "DeepSeek", hint: "thinking.type + reasoning_effort（low/medium 会并成 high）" },
  { value: "zai", label: "Z.ai / GLM", hint: "thinking.type + reasoning_effort（仅 low | high | max）" },
  { value: "qwen", label: "Qwen", hint: "enable_thinking + thinking_budget" },
  { value: "kimi", label: "Kimi", hint: "reasoning_effort（按官方档位映射）" },
  { value: "minimax", label: "MiniMax", hint: "thinking.type = adaptive | disabled" },
  { value: "hunyuan", label: "腾讯混元", hint: "thinking.type + budget_tokens" },
  { value: "step", label: "StepFun", hint: "reasoning_effort（xhigh/max 并成 high）" },
  { value: "claude-adaptive", label: "Claude 自适应", hint: "thinking.type + output_config.effort" },
  { value: "claude-budget", label: "Claude 预算制", hint: "thinking.type + budget_tokens" },
  { value: "gemini-level", label: "Gemini 档位制", hint: "thinkingConfig.thinkingLevel" },
  { value: "gemini-budget", label: "Gemini 预算制", hint: "thinkingConfig.thinkingBudget" },
];

// Levels offered for selection, low→high. Mirrors THINKING_LEVELS in
// open-sse/providers/customCapsOverride.js.
export const LEVEL_OPTIONS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const LEVEL_LABELS = {
  none: "关闭", minimal: "最低", low: "低", medium: "中",
  high: "高", xhigh: "极高", max: "最高", ultra: "极限",
};

function MappingEditor({ mapping, onChange }) {
  const [draft, setDraft] = useState(() => JSON.stringify(mapping || {}, null, 2));
  const [error, setError] = useState("");

  const commit = (text) => {
    setDraft(text);
    const trimmed = text.trim();
    if (!trimmed) { setError(""); onChange(null); return; }
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("必须是一个 JSON 对象");
        return;
      }
      setError("");
      onChange(parsed);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] text-text-muted">
        参数映射（可选）— 键为档位名或 <code className="font-mono">disabled</code>，值为要发送的字段
      </label>
      <textarea
        value={draft}
        onChange={(e) => commit(e.target.value)}
        spellCheck={false}
        rows={6}
        placeholder={'{\n  "low":  { "reasoning_effort": "low" },\n  "high": { "reasoning_effort": "high" },\n  "disabled": { "thinking": { "type": "disabled" } }\n}'}
        className="w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed focus:border-primary focus:outline-none"
      />
      {error && <span className="text-[11px] text-red-500">JSON 无效：{error}</span>}
      {!error && mapping && <span className="text-[11px] text-green-600">已生效，优先于上面的格式</span>}
    </div>
  );
}

MappingEditor.propTypes = {
  mapping: PropTypes.object,
  onChange: PropTypes.func.isRequired,
};

/**
 * Thinking configuration for one custom model: which levels this model accepts
 * (the level picker's options) and how those levels reach the wire.
 *
 * Everything here is optional and overrides the built-in tables — see
 * applyDeclaredCaps() in open-sse/providers/capabilities.js for why thinking
 * config overrides rather than merges.
 */
export default function ThinkingConfigEditor({ caps, onChange }) {
  const levels = Array.isArray(caps?.thinkingLevels) ? caps.thinkingLevels : [];
  const format = caps?.thinkingFormat || "";
  const canDisable = caps?.thinkingCanDisable !== false;
  const [showAdvanced, setShowAdvanced] = useState(!!caps?.thinkingMapping);

  const toggleLevel = (level) => {
    const next = levels.includes(level)
      ? levels.filter((l) => l !== level)
      // Keep the canonical low→high order regardless of click order, so the
      // picker and the stored value never disagree about ordering.
      : LEVEL_OPTIONS.filter((l) => l === level || levels.includes(l));
    onChange({ thinkingLevels: next.length ? next : null });
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-sidebar/30 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-text-muted">思考格式</span>
        <select
          value={format}
          onChange={(e) => onChange({ thinkingFormat: e.target.value || null })}
          className="rounded-md border border-border bg-background px-1.5 py-1 text-[11px] focus:border-primary focus:outline-none"
        >
          {FORMAT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span className="text-[11px] text-text-muted/70">
          {FORMAT_OPTIONS.find((o) => o.value === format)?.hint}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-text-muted">推理等级（从低到高）</span>
        {LEVEL_OPTIONS.map((level) => {
          const active = levels.includes(level);
          return (
            <button
              key={level}
              type="button"
              onClick={() => toggleLevel(level)}
              title={level}
              className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-text-muted hover:border-primary/40 hover:text-text-main"
              }`}
            >
              {LEVEL_LABELS[level]}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[11px] text-text-muted">
          <input
            type="checkbox"
            checked={canDisable}
            onChange={(e) => onChange({ thinkingCanDisable: e.target.checked })}
            className="size-3.5 accent-primary"
          />
          可以关闭思考
        </label>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-[11px] text-primary hover:underline"
        >
          {showAdvanced ? "收起高级设置" : "高级：自定义参数映射"}
        </button>
      </div>

      {showAdvanced && (
        <MappingEditor
          mapping={caps?.thinkingMapping}
          onChange={(m) => onChange({ thinkingMapping: m })}
        />
      )}

      {!levels.length && !format && !caps?.thinkingMapping && (
        <p className="text-[11px] text-text-muted/70">
          未声明时按模型名匹配内置规则；声明后完全以这里为准。
        </p>
      )}
    </div>
  );
}

ThinkingConfigEditor.propTypes = {
  caps: PropTypes.object,
  onChange: PropTypes.func.isRequired,
};
