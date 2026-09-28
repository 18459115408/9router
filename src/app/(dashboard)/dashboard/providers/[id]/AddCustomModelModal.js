"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Button, Modal, Toggle } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import { CAPACITY_META } from "@/shared/constants/models";

// Nothing is pre-filled to `false` here. Seeding every toggle with the floor's
// value used to make "Add" write an explicit `vision:false, reasoning:false`
// for a model the tables actually cover — and under the unified config a saved
// `false` now wins outright, so that mis-click would silently strip the model's
// images. Untouched means untouched: the patch only carries keys the operator
// actually flipped.

// Open-count key. The Modal stays mounted while hidden, so bumping this on each
// open remounts the form below — which is what resets the fields. Doing it with
// a reset effect instead would setState synchronously inside an effect and
// cascade a render on every open.
let openCount = 0;

export default function AddCustomModelModal({ isOpen, providerAlias, providerDisplayAlias, onSave, onUnlock, onClose }) {
  // Capture the count once per mount so a re-render while open does not change it.
  const [formKey] = useState(() => ++openCount);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Custom Model">
      <AddCustomModelForm
        key={isOpen ? formKey : "closed"}
        providerAlias={providerAlias}
        providerDisplayAlias={providerDisplayAlias}
        onSave={onSave}
        onUnlock={onUnlock}
        onClose={onClose}
      />
    </Modal>
  );
}

function AddCustomModelForm({ providerAlias, providerDisplayAlias, onSave, onUnlock, onClose }) {
  const [modelId, setModelId] = useState("");
  const [caps, setCaps] = useState({});
  const [touched, setTouched] = useState({});
  const [suggestion, setSuggestion] = useState(null); // null | {found, source, kind}
  const [testStatus, setTestStatus] = useState(null); // null | "testing" | "ok" | "error"
  const [testError, setTestError] = useState("");
  const [saving, setSaving] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const suggestSeq = useRef(0);

  // Ask the gateway what its built-in sources know about this id. Answers arrive
  // out of order when the operator types fast, so a stale response is dropped.
  // State changes happen only in the async callback — doing them synchronously
  // in the effect body would cascade a render on every keystroke. Clearing the
  // id hides the badge via the render guard, so no reset is needed here.
  useEffect(() => {
    const clean = stripAlias(modelId.trim());
    if (!clean) return;
    const seq = ++suggestSeq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/models/suggest?providerAlias=${encodeURIComponent(providerAlias)}&id=${encodeURIComponent(clean)}`);
        const data = await res.json();
        if (seq !== suggestSeq.current) return;
        if (data.existing) {
          // An already-saved row: pre-fill from the operator's own config.
          setCaps(data.caps || {});
          setSuggestion({ found: true, source: data.source || "operator", kind: null, existing: true, locked: !!data.locked });
          setTouched({});
          return;
        }
        setCaps(data.caps || {});
        setSuggestion({ found: !!data.found, source: data.source, kind: data.detail?.kind || null, existing: false });
        setTouched({});
      } catch {
        if (seq === suggestSeq.current) setSuggestion(null);
      }
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, providerAlias]);

  // Strip provider's own alias prefix (e.g. "cc/model" -> "model" for cc provider)
  function stripAlias(id) {
    const prefix = `${providerAlias}/`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
  }

  const handleTest = async () => {
    const cleanId = stripAlias(modelId.trim());
    if (!cleanId) return;
    setTestStatus("testing");
    setTestError("");
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerAlias}/${cleanId}` }),
      });
      const data = await res.json();
      setTestStatus(data.ok ? "ok" : "error");
      setTestError(data.error || "");
    } catch (err) {
      setTestStatus("error");
      setTestError(err.message);
    }
  };

  const handleSave = async () => {
    const cleanId = stripAlias(modelId.trim());
    if (!cleanId || saving) return;
    setSaving(true);
    try {
      // Only the keys the operator actually flipped. A pre-filled value they
      // left alone is the built-in tables' guess, which the request path still
      // applies on its own — saving it back would freeze today's guess as the
      // operator's intent and hide future table corrections.
      const patch = {};
      for (const key of Object.keys(caps)) {
        if (touched[key]) patch[key] = caps[key];
      }
      await onSave(cleanId, patch);
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleTest();
  };

  // A provider-sourced row mirrors what the upstream reports, so the form keeps
  // it read-only. Unlocking re-saves the very same row as `operator` — the caps
  // are already stored and the upsert merges, so only the provenance moves and
  // the operator can then edit it like any row they added themselves.
  const handleUnlock = async () => {
    const cleanId = stripAlias(modelId.trim());
    if (!cleanId || unlocking) return;
    setUnlocking(true);
    try {
      await onUnlock(cleanId);
      // Clear the badge here rather than re-fetching: the point of unlocking is
      // to edit the row right now, so the form must not stay locked.
      setSuggestion((prev) => (prev ? { ...prev, locked: false } : prev));
    } catch (err) {
      // The writer already alerts its own failures; this catches anything it
      // lets through so the unlock button never looks like it did nothing.
      alert(translate("Failed to unlock model config") + (err?.message ? ": " + err.message : ""));
    } finally {
      setUnlocking(false);
    }
  };

  const sourceLabel = suggestion?.existing
    ? "已保存的配置"
    : suggestion?.found
      ? (suggestion.source === "catalog" ? "来自模型目录" : "来自内置配置")
      : "无内置配置";

  return (
    <>
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-sm font-medium mb-1.5 block">Model ID</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={modelId}
              onChange={(e) => { setModelId(e.target.value); setTestStatus(null); setTestError(""); }}
              onKeyDown={handleKeyDown}
              placeholder="e.g. claude-opus-4-5"
              className="flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
              autoFocus
            />
            <Button
              variant="secondary"
              icon="science"
              loading={testStatus === "testing"}
              onClick={handleTest}
              disabled={!modelId.trim() || testStatus === "testing"}
            >
              {testStatus === "testing" ? "Testing..." : "Test"}
            </Button>
          </div>
          <p className="text-xs text-text-muted mt-1">
            Sent to provider as: <code className="font-mono bg-sidebar px-1 rounded">{stripAlias(modelId.trim()) || "model-id"}</code>
          </p>
          {modelId.trim() && (
            <p className="text-xs text-text-muted mt-1 flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">auto_awesome</span>
              {sourceLabel}
              {suggestion?.found && !suggestion?.existing && (
                <span className="text-text-muted">（已预填，未修改的项不会保存）</span>
              )}
          {suggestion?.existing && suggestion?.locked && (
            <span className="text-amber-500 flex items-center gap-1.5">
              只读，需先解除锁定
              <Button
                size="sm"
                variant="secondary"
                onClick={handleUnlock}
                loading={unlocking}
                disabled={!modelId.trim() || unlocking}
              >
                解除锁定
              </Button>
            </span>
          )}
            </p>
          )}
        </div>

        <div>
          <label className="text-sm font-medium mb-1.5 block">Capabilities</label>
          <div className="flex flex-wrap gap-4">
            {Object.entries(CAPACITY_META).map(([key, meta]) => (
              <Toggle
                key={key}
                checked={!!caps[key]}
                onChange={(v) => {
                  setCaps((prev) => ({ ...prev, [key]: v }));
                  setTouched((prev) => ({ ...prev, [key]: true }));
                }}
                label={meta.label}
                description={meta.desc}
                size="sm"
              />
            ))}
          </div>
          <p className="text-xs text-text-muted mt-2">
            只有你手动改过的开关会被保存；预填值留空即表示沿用网关内置判断。
          </p>
        </div>

        {/* Test result */}
        {testStatus === "ok" && (
          <div className="flex items-center gap-2 text-sm text-green-600">
            <span className="material-symbols-outlined text-base">check_circle</span>
            Model is reachable
          </div>
        )}
        {testStatus === "error" && (
          <div className="flex items-start gap-2 text-sm text-red-500">
            <span className="material-symbols-outlined text-base shrink-0">cancel</span>
            <span>{testError || "Model not reachable"}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button onClick={onClose} variant="ghost" fullWidth size="sm">Cancel</Button>
          <Button
            onClick={handleSave}
            fullWidth
            size="sm"
            disabled={!modelId.trim() || saving || suggestion?.locked}
          >
            {saving ? "Adding..." : "Add Model"}
          </Button>
        </div>
      </div>
    </>
  );
}

AddCustomModelModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  onSave: PropTypes.func.isRequired,
  onUnlock: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
