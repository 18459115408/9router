"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/shared/components";

// Cooldown override inputs. Values are entered in minutes (except
// maxBackoffLevel, a count) and stored as ms. Shared by the AI-provider
// detail page (providers/[id]) and the media-provider ConnectionsCard.
const COOLDOWN_FIELDS = [
  { key: "cooldownLongMs", label: "Auth / quota error (min)", placeholder: "2", step: 1 },
  { key: "maxBackoffMs", label: "Rate-limit backoff cap (min)", placeholder: "5", step: 1 },
  { key: "maxRateLimitCooldownMs", label: "Upstream reset cap (min)", placeholder: "30", step: 1 },
  { key: "cooldownShortMs", label: "Rejected request (min)", placeholder: "0.08", step: 0.5 },
  { key: "transientCooldownMs", label: "Unknown error (min)", placeholder: "0.5", step: 0.5 },
  { key: "backoffBaseMs", label: "Backoff base (min)", placeholder: "0.03", step: 0.5 },
  { key: "maxBackoffLevel", label: "Max backoff level (count)", placeholder: "15", step: 1 },
];

/**
 * Collapsible "Cooldown override" panel for one provider.
 * Reads/writes settings.providerStrategies[providerId].cooldown via
 * PATCH /api/settings; blank input = fall back to the global constant.
 */
export default function CooldownOverrideSection({ providerId }) {
  const [draft, setDraft] = useState({});

  const loadDraft = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const cd = ((data.providerStrategies || {})[providerId] || {}).cooldown || {};
      // Cooldown values are stored in ms; the inputs show minutes.
      const next = {};
      for (const [k, v] of Object.entries(cd)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          next[k] = k === "maxBackoffLevel" ? String(v) : String(v / 60000);
        }
      }
      setDraft(next);
    } catch (e) { console.log("CooldownOverrideSection load error:", e); }
  }, [providerId]);

  useEffect(() => { loadDraft(); }, [loadDraft]);

  // Cooldown overrides are edited in minutes; maxBackoffLevel is a plain count.
  // An empty/invalid input clears that key so the global constant applies again.
  const saveCooldown = async (key, rawValue) => {
    setDraft((prev) => ({ ...prev, [key]: rawValue }));
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      const cooldown = { ...(override.cooldown || {}) };
      const num = Number(rawValue);
      const invalid = rawValue === "" || !Number.isFinite(num) || num < 0;
      if (invalid) delete cooldown[key];
      else cooldown[key] = key === "maxBackoffLevel" ? Math.floor(num) : Math.round(num * 60 * 1000);
      if (Object.keys(cooldown).length === 0) delete override.cooldown;
      else override.cooldown = cooldown;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerStrategies: updated }) });
    } catch (e) { console.log("CooldownOverrideSection save error:", e); }
  };

  const clearCooldown = async () => {
    setDraft({});
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      delete override.cooldown;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerStrategies: updated }) });
    } catch (e) { console.log("CooldownOverrideSection clear error:", e); }
  };

  return (
    <div className="mb-4 rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <span className="text-sm font-medium">Cooldown override</span>
          <p className="text-xs text-text-muted">
            How long this provider&apos;s accounts are benched after an error. Blank = use the default.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={clearCooldown}>Clear</Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {COOLDOWN_FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">{f.label}</span>
            <input
              type="number" min={0} step={f.step}
              value={draft[f.key] ?? ""}
              placeholder={f.placeholder}
              onChange={(e) => saveCooldown(f.key, e.target.value)}
              className="w-full px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:border-primary"
            />
          </label>
        ))}
      </div>
    </div>
  );
}
