/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Plugin Config create / edit form                  */
/* ------------------------------------------------------------------ */

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  MCP_GATEWAY_AGGREGATE_ONLY_PATHS,
  MCP_GATEWAY_TRANSPARENT_NOTE,
  mcpGatewayConfigHasAggregateOnlyFields,
  omitMcpGatewayAggregateOnlyFields,
  pickMcpGatewayAggregateOnlyFields,
  readMcpGatewayMode,
  sanitizeMcpGatewayConfigForSubmit,
  switchMcpGatewayMode,
  type McpGatewayMode,
} from "@/lib/mcpGatewayConfig";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select, type SelectOptionGroup } from "@/components/ui/Select";
import { FormValidationSummary } from "./FormValidationSummary";
import { useFormValidationSummary } from "@/lib/collapsedFormValidation";
import type {
  PluginConfig,
  PluginConfigCreate,
  PluginScope,
  PluginTrigger,
} from "@/api/types";
import {
  formatPluginConfigDefault,
  formatPluginName,
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
  /** True only after all membership pages succeed; [] can then mean empty. */
  initialProxyGroupIdsLoaded?: boolean;
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

export function PluginConfigForm(props: PluginConfigFormProps) {
  const membershipLoaded =
    props.initialProxyGroupIdsLoaded ?? props.initialProxyGroupIds !== undefined;

  // Mount fresh when this plugin's complete membership first arrives. Do not
  // key on the IDs themselves: refetches must preserve subsequent user edits.
  return (
    <PluginConfigFormFields
      key={JSON.stringify([props.initialData?.id, membershipLoaded])}
      {...props}
    />
  );
}

function PluginConfigFormFields({
  initialData,
  defaults,
  onSubmit,
  isLoading,
  availablePlugins,
  initialProxyGroupIds,
}: PluginConfigFormProps) {
  const navigate = useNavigate();
  const isEdit = !!initialData;
  const formRef = useRef<HTMLFormElement>(null);
  const validationSummary = useFormValidationSummary();

  /* ---------- State ---------- */
  // Seeded once per editor identity: the parent keys this form on
  // `{ namespace, resourceId }` so a tenant or resource change remounts it,
  // while a background refetch of the same identity never rewrites fields
  // (see the refresh policy in `src/lib/editorIdentity.ts`).
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
  const mcpAggregateStashRef = useRef<Record<string, unknown>>({});

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
    const ok = Object.keys(errs).length === 0;
    if (!ok) {
      validationSummary.onValidationFailed(errs, formRef.current);
    } else {
      validationSummary.clearValidationSummary();
    }
    return ok;
  };

  /* ---------- Submit ---------- */

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    let parsedConfig = JSON.parse(configJson) as Record<string, unknown>;
    if (pluginName === "mcp_gateway") {
      parsedConfig = sanitizeMcpGatewayConfigForSubmit(parsedConfig);
    }

    const data: PluginConfigCreate = {
      plugin_name: pluginName,
      scope,
      config: parsedConfig,
      enabled,
      ...(scope === "proxy" && proxyId && { proxy_id: proxyId }),
      ...(priorityOverride !== "" && { priority_override: Number(priorityOverride) }),
      trigger: triggerEnabled ? (JSON.parse(triggerJson) as PluginTrigger) : null,
    };

    await onSubmit(data, scope === "proxy_group" ? proxyGroupIds : undefined);
  };

  /* ---------- Helpers ---------- */

  // Group by category so the picker reads like a catalog instead of one flat
  // ~80-entry list; the group heading carries the category, so an option label
  // is just the plugin's display name. Internal (__-prefixed) plugins are
  // gateway-injected and never user-configurable.
  const pluginGroups = useMemo<SelectOptionGroup[]>(() => {
    const byCategory = new Map<string, SelectOptionGroup>();
    for (const plugin of availablePlugins) {
      if (isInternalPlugin(plugin)) continue;
      const { category } = getPluginMeta(plugin);
      let group = byCategory.get(category);
      if (!group) {
        group = { label: category, options: [] };
        byCategory.set(category, group);
      }
      group.options.push({ value: plugin, label: formatPluginName(plugin) });
    }
    const groups = [...byCategory.values()].sort((a, b) =>
      a.label.localeCompare(b.label),
    );
    for (const group of groups) {
      group.options.sort((a, b) => a.label.localeCompare(b.label));
    }
    return groups;
  }, [availablePlugins]);

  const selectedMeta = pluginName ? getPluginMeta(pluginName) : undefined;

  const numVal = (v: number | ""): string => (v === "" ? "" : String(v));

  const currentDefault = formatPluginConfigDefault(pluginName);
  const configMatchesDefault = configJson === currentDefault;

  const resetConfigToPluginDefault = () => {
    mcpAggregateStashRef.current = {};
    setConfigJson(currentDefault);
    setUserEditedConfig(false);
    setErrors(({ config: _config, ...remainingErrors }) => remainingErrors);
  };

  const parsedMcpGatewayConfig = useMemo(() => {
    if (pluginName !== "mcp_gateway") return null;
    try {
      return JSON.parse(configJson) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [configJson, pluginName]);

  const mcpGatewayMode = parsedMcpGatewayConfig
    ? readMcpGatewayMode(parsedMcpGatewayConfig)
    : "aggregate_router";

  const handleMcpGatewayModeChange = (nextMode: McpGatewayMode) => {
    if (!parsedMcpGatewayConfig || nextMode === mcpGatewayMode) return;
    const { config, stash } = switchMcpGatewayMode(
      parsedMcpGatewayConfig,
      nextMode,
      mcpAggregateStashRef.current,
    );
    mcpAggregateStashRef.current = stash;
    setConfigJson(JSON.stringify(config, null, 2));
    setUserEditedConfig(true);
    setErrors(({ config: _config, ...remainingErrors }) => remainingErrors);
  };

  useEffect(() => {
    if (pluginName !== "mcp_gateway" || !parsedMcpGatewayConfig) return;
    if (readMcpGatewayMode(parsedMcpGatewayConfig) !== "transparent_proxy") return;
    if (!mcpGatewayConfigHasAggregateOnlyFields(parsedMcpGatewayConfig)) return;

    mcpAggregateStashRef.current = {
      ...mcpAggregateStashRef.current,
      ...pickMcpGatewayAggregateOnlyFields(parsedMcpGatewayConfig),
    };
    const stripped = omitMcpGatewayAggregateOnlyFields(parsedMcpGatewayConfig);
    stripped.mode = "transparent_proxy";
    const nextJson = JSON.stringify(stripped, null, 2);
    if (nextJson !== configJson) {
      setConfigJson(nextJson);
    }
  }, [configJson, parsedMcpGatewayConfig, pluginName]);

  // When plugin name changes in create mode, always update config to the new default
  useEffect(() => {
    if (isEdit || !pluginName) return;
    mcpAggregateStashRef.current = {};
    const nextConfigJson = formatPluginConfigDefault(pluginName);
    setConfigJson(nextConfigJson);
    setUserEditedConfig(false);
  }, [isEdit, pluginName]);

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-0">
      {/* ── Basic Fields ── */}
      <div className="border-b border-border/50 py-4">
        <h3 className="text-sm font-semibold text-text-primary mb-4">Plugin Configuration</h3>
        <div className="space-y-4">
          <Select
            label="Plugin Name"
            value={pluginName}
            onValueChange={setPluginName}
            groups={pluginGroups}
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
              // Editing another scope must not discard the existing draft.
              // Submit includes only the selections for the chosen scope.
              if (!isEdit) {
                if (next !== "proxy") setProxyId("");
                if (next !== "proxy_group") setProxyGroupIds([]);
              }
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

      {pluginName === "mcp_gateway" && parsedMcpGatewayConfig && (
        <div className="border-b border-border/50 py-4">
          <h3 className="text-sm font-semibold text-text-primary mb-4">MCP Gateway Mode</h3>
          <div className="space-y-3">
            <Select
              label="Mode"
              value={mcpGatewayMode}
              onValueChange={(value) => handleMcpGatewayModeChange(value as McpGatewayMode)}
              options={[
                { value: "aggregate_router", label: "Aggregate router" },
                { value: "transparent_proxy", label: "Transparent proxy" },
              ]}
              helpText="Aggregate mode exposes a merged catalog with policy controls. Transparent mode proxies upstream MCP servers directly."
            />
            {mcpGatewayMode === "transparent_proxy" && (
              <p className="text-xs text-text-muted">{MCP_GATEWAY_TRANSPARENT_NOTE}</p>
            )}
            {mcpGatewayMode === "transparent_proxy" && (
              <p className="text-xs text-text-muted">
                Omitted in transparent mode:{" "}
                {MCP_GATEWAY_AGGREGATE_ONLY_PATHS.join(", ")}.
              </p>
            )}
          </div>
        </div>
      )}

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
            aria-label="Plugin config JSON"
            value={configJson}
            onChange={(e) => {
              setUserEditedConfig(true);
              setConfigJson(e.target.value);
            }}
            rows={12}
            aria-invalid={errors.config ? true : undefined}
            aria-describedby={errors.config ? "plugin-config-error" : undefined}
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
          {errors.config && (
            <p id="plugin-config-error" className="text-danger text-xs">
              {errors.config}
            </p>
          )}
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
              aria-label="Execution trigger JSON"
              value={triggerJson}
              onChange={(e) => setTriggerJson(e.target.value)}
              rows={8}
              aria-invalid={errors.trigger ? true : undefined}
              aria-describedby={errors.trigger ? "plugin-trigger-error" : undefined}
              className={`bg-code-bg border rounded-lg px-3 py-2 text-text-primary text-sm font-mono placeholder:text-text-muted transition-colors duration-150 resize-y min-h-[100px] ${
                errors.trigger
                  ? "border-danger focus:border-danger focus:ring-1 focus:ring-danger/30"
                  : "border-border focus:border-orange focus:ring-1 focus:ring-orange/30"
              }`}
              spellCheck={false}
            />
            {errors.trigger && (
              <p id="plugin-trigger-error" className="text-danger text-xs">
                {errors.trigger}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Actions ── */}
      <div className="flex flex-col items-end gap-3 pt-6">
        {validationSummary.showSummary && (
          <FormValidationSummary count={validationSummary.errorCount} />
        )}
        <div className="flex items-center justify-end gap-3 w-full">
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
      </div>
    </form>
  );
}
