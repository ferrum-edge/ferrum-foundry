/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin Config create / edit form                  */
/* ------------------------------------------------------------------ */

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import type {
  PluginConfig,
  PluginConfigCreate,
  PluginScope,
  PluginTrigger,
} from "@/api/types";
import {
  formatPluginConfigDefault,
  getPluginMeta,
  isInternalPlugin,
} from "@/lib/pluginConfigDefaults";
import { ProxySearchPicker } from "@/components/forms/ProxySearchPicker";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface PluginFormDefaults {
  pluginName?: string;
  scope?: PluginScope;
  proxyId?: string;
  /** Pre-selected proxy IDs for proxy_group scope */
  proxyGroupIds?: string[];
}

export interface PluginConfigFormProps {
  initialData?: PluginConfig;
  defaults?: PluginFormDefaults;
  onSubmit: (data: PluginConfigCreate, proxyGroupIds?: string[]) => Promise<void>;
  isLoading: boolean;
  availablePlugins: string[];
  /** Pre-loaded proxy IDs that currently reference this plugin (edit mode, proxy_group) */
  initialProxyGroupIds?: string[];
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
  defaults,
  onSubmit,
  isLoading,
  availablePlugins,
  initialProxyGroupIds,
}: PluginConfigFormProps) {
  const navigate = useNavigate();
  const isEdit = !!initialData;

  /* ---------- State ---------- */
  const [pluginName, setPluginName] = useState(initialData?.plugin_name ?? defaults?.pluginName ?? "");
  const [scope, setScope] = useState<PluginScope>(initialData?.scope ?? defaults?.scope ?? "global");
  const [proxyId, setProxyId] = useState(initialData?.proxy_id ?? defaults?.proxyId ?? "");
  const [proxyGroupIds, setProxyGroupIds] = useState<string[]>(
    initialProxyGroupIds ?? defaults?.proxyGroupIds ?? [],
  );
  const [enabled, setEnabled] = useState(initialData?.enabled ?? true);
  const [priorityOverride, setPriorityOverride] = useState<number | "">(
    initialData?.priority_override ?? "",
  );
  const initialPluginForConfig = initialData?.plugin_name ?? defaults?.pluginName ?? "";
  const initialConfigJson = initialData
    ? JSON.stringify(initialData.config, null, 2)
    : formatPluginConfigDefault(initialPluginForConfig);
  const [configJson, setConfigJson] = useState(initialConfigJson);
  // Track whether the user has manually edited the config textarea
  const [userEditedConfig, setUserEditedConfig] = useState(false);

  /* ---------- Trigger (optional per-instance execution predicate) --- */
  const [triggerEnabled, setTriggerEnabled] = useState(!!initialData?.trigger);
  const [triggerJson, setTriggerJson] = useState(
    initialData?.trigger
      ? JSON.stringify(initialData.trigger, null, 2)
      : JSON.stringify(
          { when: { match: { path: { prefix: ["/api/"] } } } },
          null,
          2,
        ),
  );

  /* ---------- Validation ---------- */
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!pluginName) errs.plugin_name = "Plugin name is required";
    if (scope === "proxy" && !proxyId.trim()) errs.proxy_id = "A proxy is required for proxy scope";
    if (scope === "proxy_group" && proxyGroupIds.length === 0) {
      errs.proxy_group = "Select at least one proxy for proxy group scope";
    }
    if (priorityOverride !== "" && (Number(priorityOverride) < 0 || Number(priorityOverride) > 10000)) {
      errs.priority_override = "Must be between 0 and 10000";
    }
    try {
      JSON.parse(configJson);
    } catch {
      errs.config = "Invalid JSON";
    }
    if (triggerEnabled) {
      try {
        const parsed = JSON.parse(triggerJson) as PluginTrigger;
        if (!parsed || typeof parsed !== "object" || !parsed.when) {
          errs.trigger = 'Trigger must be an object with a "when" predicate node';
        }
      } catch {
        errs.trigger = "Invalid JSON";
      }
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
      trigger: triggerEnabled ? (JSON.parse(triggerJson) as PluginTrigger) : null,
    };

    await onSubmit(data, scope === "proxy_group" ? proxyGroupIds : undefined);
  };

  /* ---------- Helpers ---------- */

  // Group by category so the picker reads like a catalog; internal (__-prefixed)
  // plugins are gateway-injected and never user-configurable.
  const pluginOptions = useMemo(() => {
    const selectable = availablePlugins.filter((p) => !isInternalPlugin(p));
    const sorted = [...selectable].sort((a, b) => {
      const catA = getPluginMeta(a).category;
      const catB = getPluginMeta(b).category;
      if (catA !== catB) return catA.localeCompare(catB);
      return a.localeCompare(b);
    });
    return sorted.map((p) => ({
      value: p,
      label: `${getPluginMeta(p).category} · ${p
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())}`,
    }));
  }, [availablePlugins]);

  const selectedMeta = pluginName ? getPluginMeta(pluginName) : undefined;

  const numVal = (v: number | ""): string => (v === "" ? "" : String(v));

  const currentDefault = formatPluginConfigDefault(pluginName);
  const configMatchesDefault = configJson === currentDefault;

  const resetConfigToPluginDefault = () => {
    setConfigJson(currentDefault);
    setUserEditedConfig(false);
    setErrors(({ config, ...remainingErrors }) => remainingErrors);
  };

  // When plugin name changes in create mode, always update config to the new default
  useEffect(() => {
    if (isEdit || !pluginName) return;
    const nextConfigJson = formatPluginConfigDefault(pluginName);
    setConfigJson(nextConfigJson);
    setUserEditedConfig(false);
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
            helpText={selectedMeta?.description}
            disabled={isEdit}
          />

          <Select
            label="Scope"
            value={scope}
            onValueChange={(v) => {
              const next = v as PluginScope;
              setScope(next);
              // Clear proxy selections when switching scopes
              if (next !== "proxy") setProxyId("");
              if (next !== "proxy_group") setProxyGroupIds([]);
            }}
            options={[
              { value: "global", label: "Global" },
              { value: "proxy", label: "Proxy" },
              { value: "proxy_group", label: "Proxy Group" },
            ]}
          />

          {scope === "proxy" && (
            <ProxySearchPicker
              mode="single"
              label="Proxy"
              value={proxyId}
              onChange={setProxyId}
              error={errors.proxy_id}
              helpText="The single proxy this plugin applies to."
            />
          )}

          {scope === "proxy_group" && (
            <ProxySearchPicker
              mode="multi"
              label="Proxies"
              value={proxyGroupIds}
              onChange={setProxyGroupIds}
              error={errors.proxy_group}
              helpText="Select proxies that will share this plugin instance. Stateful plugins (e.g. rate limiting) share counters across the group."
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
            helpText="Lower values execute first. Leave empty for default."
            error={errors.priority_override}
          />
        </div>
      </div>

      {/* ── Config JSON ── */}
      <div className="border-b border-border/50 py-4">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-sm font-semibold text-text-primary">Config (JSON)</h3>
          {!isEdit && pluginName && userEditedConfig && !configMatchesDefault && (
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
              setUserEditedConfig(true);
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

      {/* ── Execution Trigger ── */}
      <div className="border-b border-border/50 py-4">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h3 className="text-sm font-semibold text-text-primary">Execution Trigger</h3>
          <Checkbox label="Enabled" checked={triggerEnabled} onChange={setTriggerEnabled} />
        </div>
        <p className="text-xs text-text-muted mb-3">
          Optional per-instance predicate deciding when this plugin runs.
          Combine <code className="font-mono">all</code> / <code className="font-mono">any</code> /{" "}
          <code className="font-mono">not</code> nodes with <code className="font-mono">match</code>{" "}
          leaves on method, path, host, SNI, header, query, cookie, protocol,
          source CIDR, consumer, and more.
        </p>
        {triggerEnabled && (
          <div className="flex flex-col gap-1.5">
            <textarea
              value={triggerJson}
              onChange={(e) => setTriggerJson(e.target.value)}
              rows={8}
              className={`bg-code-bg border rounded-lg px-3 py-2 text-text-primary text-sm font-mono placeholder:text-text-muted transition-colors duration-150 resize-y min-h-[100px] ${
                errors.trigger
                  ? "border-danger focus:border-danger focus:ring-1 focus:ring-danger/30"
                  : "border-border focus:border-orange focus:ring-1 focus:ring-orange/30"
              }`}
              spellCheck={false}
            />
            {errors.trigger && <p className="text-danger text-xs">{errors.trigger}</p>}
          </div>
        )}
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
