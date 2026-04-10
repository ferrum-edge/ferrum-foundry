/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin Config create / edit form                  */
/* ------------------------------------------------------------------ */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import type { PluginConfig, PluginConfigCreate } from "@/api/types";
import { formatPluginConfigDefault } from "@/lib/pluginConfigDefaults";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface PluginConfigFormProps {
  initialData?: PluginConfig;
  onSubmit: (data: PluginConfigCreate) => Promise<void>;
  isLoading: boolean;
  availablePlugins: string[];
}

/* ------------------------------------------------------------------ */
/*  Helper: Checkbox                                                   */
/* ------------------------------------------------------------------ */

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded border-border bg-bg-input text-orange accent-orange cursor-pointer"
      />
      <span className="text-sm text-text-secondary">{label}</span>
    </label>
  );
}

/* ================================================================== */
/*  PluginConfigForm                                                   */
/* ================================================================== */

export function PluginConfigForm({
  initialData,
  onSubmit,
  isLoading,
  availablePlugins,
}: PluginConfigFormProps) {
  const navigate = useNavigate();
  const isEdit = !!initialData;

  /* ---------- State ---------- */
  const [pluginName, setPluginName] = useState(initialData?.plugin_name ?? "");
  const [scope, setScope] = useState<"global" | "proxy">(initialData?.scope ?? "global");
  const [proxyId, setProxyId] = useState(initialData?.proxy_id ?? "");
  const [enabled, setEnabled] = useState(initialData?.enabled ?? true);
  const [priorityOverride, setPriorityOverride] = useState<number | "">(
    initialData?.priority_override ?? "",
  );
  const initialConfigJson = initialData
    ? JSON.stringify(initialData.config, null, 2)
    : formatPluginConfigDefault("");
  const generatedConfigJsonRef = useRef<string | null>(isEdit ? null : initialConfigJson);
  const [configJson, setConfigJson] = useState(initialConfigJson);

  /* ---------- Validation ---------- */
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!pluginName) errs.plugin_name = "Plugin name is required";
    if (scope === "proxy" && !proxyId.trim()) errs.proxy_id = "Proxy ID is required for proxy scope";
    if (priorityOverride !== "" && (Number(priorityOverride) < 0 || Number(priorityOverride) > 10000)) {
      errs.priority_override = "Must be between 0 and 10000";
    }
    try {
      JSON.parse(configJson);
    } catch {
      errs.config = "Invalid JSON";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  /* ---------- Submit ---------- */

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    const data: PluginConfigCreate = {
      plugin_name: pluginName,
      scope,
      config: JSON.parse(configJson),
      enabled,
      ...(scope === "proxy" && proxyId && { proxy_id: proxyId }),
      ...(priorityOverride !== "" && { priority_override: Number(priorityOverride) }),
    };

    await onSubmit(data);
  };

  /* ---------- Helpers ---------- */

  const pluginOptions = availablePlugins.map((p) => ({
    value: p,
    label: p.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  }));

  const numVal = (v: number | ""): string => (v === "" ? "" : String(v));

  const resetConfigToPluginDefault = () => {
    const nextConfigJson = formatPluginConfigDefault(pluginName);
    generatedConfigJsonRef.current = nextConfigJson;
    setConfigJson(nextConfigJson);
    setErrors(({ config, ...remainingErrors }) => remainingErrors);
  };

  useEffect(() => {
    if (isEdit || !pluginName) return;

    const nextConfigJson = formatPluginConfigDefault(pluginName);
    setConfigJson((currentConfigJson) => {
      const shouldReplace =
        currentConfigJson.trim() === "" ||
        currentConfigJson.trim() === "{}" ||
        currentConfigJson === generatedConfigJsonRef.current;

      if (!shouldReplace) return currentConfigJson;

      generatedConfigJsonRef.current = nextConfigJson;
      return nextConfigJson;
    });
  }, [isEdit, pluginName]);

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <form onSubmit={handleSubmit} className="space-y-0">
      {/* ── Basic Fields ── */}
      <div className="border-b border-border/50 py-4">
        <h3 className="text-sm font-semibold text-text-primary mb-4">Plugin Configuration</h3>
        <div className="space-y-4">
          <Select
            label="Plugin Name"
            value={pluginName}
            onValueChange={setPluginName}
            options={pluginOptions}
            placeholder="Select a plugin..."
            error={errors.plugin_name}
            disabled={isEdit}
          />

          <Select
            label="Scope"
            value={scope}
            onValueChange={(v) => setScope(v as "global" | "proxy")}
            options={[
              { value: "global", label: "Global" },
              { value: "proxy", label: "Proxy" },
            ]}
          />

          {scope === "proxy" && (
            <Input
              label="Proxy ID"
              value={proxyId}
              onChange={(e) => setProxyId(e.target.value)}
              placeholder="proxy-uuid"
              error={errors.proxy_id}
              required
            />
          )}

          <Checkbox label="Enabled" checked={enabled} onChange={setEnabled} />

          <Input
            label="Priority Override"
            type="number"
            value={numVal(priorityOverride)}
            onChange={(e) => {
              const raw = e.target.value;
              setPriorityOverride(raw === "" ? "" : Number(raw));
            }}
            placeholder="Optional (0-10000)"
            helpText="Higher priority plugins execute first. Leave empty for default."
            error={errors.priority_override}
          />
        </div>
      </div>

      {/* ── Config JSON ── */}
      <div className="border-b border-border/50 py-4">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-sm font-semibold text-text-primary">Config (JSON)</h3>
          {!isEdit && pluginName && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={resetConfigToPluginDefault}
            >
              Reset Defaults
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <textarea
            value={configJson}
            onChange={(e) => {
              generatedConfigJsonRef.current = null;
              setConfigJson(e.target.value);
            }}
            rows={12}
            className={`bg-code-bg border rounded-lg px-3 py-2 text-text-primary text-sm font-mono placeholder:text-text-muted transition-colors duration-150 resize-y min-h-[120px] ${
              errors.config
                ? "border-danger focus:border-danger focus:ring-1 focus:ring-danger/30"
                : "border-border focus:border-orange focus:ring-1 focus:ring-orange/30"
            }`}
            spellCheck={false}
          />
          {!isEdit && (
            <p className="text-xs text-text-muted">
              Defaults are editable templates for the selected plugin.
            </p>
          )}
          {errors.config && <p className="text-danger text-xs">{errors.config}</p>}
        </div>
      </div>

      {/* ── Actions ── */}
      <div className="flex items-center justify-end gap-3 pt-6">
        <Button
          type="button"
          variant="secondary"
          onClick={() => navigate({ to: "/plugins" })}
          disabled={isLoading}
        >
          Cancel
        </Button>
        <Button type="submit" loading={isLoading}>
          {isEdit ? "Update Plugin" : "Create Plugin"}
        </Button>
      </div>
    </form>
  );
}
