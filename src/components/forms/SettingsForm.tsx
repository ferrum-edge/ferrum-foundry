/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – BFF connection settings form                      */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { isGatewayTargetRetired } from "@/api/gatewayTarget";
import { validateNamespaceName } from "@/api/namespaces";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { useCapabilities } from "@/stores/capabilities";
import { CapabilityNotice } from "@/components/shared/CapabilityGate";
import { isReadDenied, ReadDeniedNotice } from "@/components/shared/ReadState";
import {
  formatCommaList,
  missingNumberError,
  numberDraftFromInput,
  numberDraftText,
  parseCommaList,
  resolveNumberDrafts,
  type WithNumberDrafts,
} from "@/lib/formDrafts";

/* ── Types ─────────────────────────────────────────────────────────── */

interface Settings {
  authMode: "static" | "trusted-proxy";
  adminUrl: string;
  jwtIssuer: string;
  jwtTtl: number;
  jwtRole: "viewer" | "operator" | "admin";
  jwtAudience: string | string[] | undefined;
  jwtNamespaces: string[] | undefined;
  tlsCaConfigured: boolean;
  tlsVerify: boolean;
  connectTimeout: number;
  readTimeout: number;
  writeTimeout: number;
  runtimeSettingsEnabled: boolean;
}

// Numeric settings hold `""` while cleared so the input never snaps to `0`;
// save rejects an empty value, and the BFF enforces each field's range.
const SETTINGS_NUMBER_FIELDS = [
  ["jwtTtl", "JWT TTL"],
  ["connectTimeout", "Connect timeout"],
  ["readTimeout", "Read timeout"],
  ["writeTimeout", "Write timeout"],
] as const;
const SETTINGS_NUMBER_KEYS = SETTINGS_NUMBER_FIELDS.map(([key]) => key);
type SettingsDraft = WithNumberDrafts<Settings, (typeof SETTINGS_NUMBER_KEYS)[number]>;

/** Each comma-separated grant must be a valid namespace name. */
function namespaceGrantsError(text: string): string | undefined {
  for (const grant of parseCommaList(text)) {
    const error = validateNamespaceName(grant);
    if (error) return `${error} ("${grant}")`;
  }
  return undefined;
}

interface StatusResult {
  reachable: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

/* ================================================================== */
/*  SettingsForm                                                       */
/* ================================================================== */

export function SettingsForm() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { capabilities } = useCapabilities();
  const canWrite = capabilities.bffSettings;

  // `null` until a successful read: an unobserved response is never rendered
  // as an editable server snapshot or an invented default configuration.
  const [settings, setSettings] = useState<SettingsDraft | null>(null);
  // Namespace grants keep the operator's raw text (commas included) and are
  // parsed on save; `settings.jwtNamespaces` stays the last server value.
  const [namespaceText, setNamespaceText] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  // A terminal failed read is either a permission denial or unavailable data;
  // both render an explicit read state, never a fabricated configuration.
  const [readFailed, setReadFailed] = useState<"denied" | "unavailable" | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<StatusResult | null>(null);

  /* ── Fetch current settings ─────────────────────────────────────── */

  const adoptSettings = useCallback((data: Settings) => {
    setSettings(data);
    setNamespaceText(formatCommaList(data.jwtNamespaces));
    setErrors({});
    queryClient.setQueryData(["settings"], data);
  }, [queryClient]);

  const fetchSettings = useCallback(async () => {
    try {
      const data = await api.get("api/settings").json<Settings>();
      adoptSettings(data);
      setReadFailed(null);
    } catch (error) {
      setReadFailed(isReadDenied(error) ? "denied" : "unavailable");
    } finally {
      setLoading(false);
    }
  }, [adoptSettings]);

  async function retry() {
    setRetrying(true);
    try {
      await fetchSettings();
    } finally {
      setRetrying(false);
    }
  }

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  /* ── Field helpers ──────────────────────────────────────────────── */

  function update<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function checkNamespaceGrants() {
    const error = namespaceGrantsError(namespaceText);
    setErrors((prev) => {
      const next = { ...prev };
      if (error) next.jwtNamespaces = error;
      else delete next.jwtNamespaces;
      return next;
    });
  }

  function validate(): boolean {
    if (!settings) return false;
    const errs: Record<string, string> = {};
    for (const [key, label] of SETTINGS_NUMBER_FIELDS) {
      const error = missingNumberError(settings[key], label);
      if (error) errs[key] = error;
    }
    if (settings.authMode === "static") {
      const error = namespaceGrantsError(namespaceText);
      if (error) errs.jwtNamespaces = error;
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  /* ── Test connection ────────────────────────────────────────────── */

  async function handleTest() {
    setTesting(true);
    setStatus(null);
    try {
      const res = await api.get("api/settings/status").json<StatusResult>();
      setStatus(res);
    } catch (err) {
      setStatus({
        reachable: false,
        error: err instanceof Error ? err.message : "Connection test failed",
      });
    } finally {
      setTesting(false);
    }
  }

  /* ── Save settings ──────────────────────────────────────────────── */

  async function handleSave() {
    if (!settings) return;
    if (!canWrite.allowed) return;
    if (!validate()) return;
    setSaving(true);
    try {
      const {
        authMode,
        jwtRole,
        jwtNamespaces: seededNamespaces,
        tlsCaConfigured: _tlsCaConfigured,
        runtimeSettingsEnabled: _runtimeSettingsEnabled,
        ...updates
      } = resolveNumberDrafts(settings, SETTINGS_NUMBER_KEYS);
      // Untouched text keeps the server's value, so an unrestricted
      // (absent) grant list is not rewritten as `[]`.
      const jwtNamespaces = namespaceText === formatCommaList(seededNamespaces)
        ? seededNamespaces
        : parseCommaList(namespaceText);
      const data = await api
        .put("api/settings", {
          json: authMode === "static" ? { ...updates, jwtRole, jwtNamespaces } : updates,
        })
        .json<Settings>();
      // A save that re-pointed the BFF retired this workspace; the gateway
      // target gate reports it and nothing here may repopulate the cache.
      if (isGatewayTargetRetired()) return;
      adoptSettings(data);
      toast("success", "Settings saved successfully");
    } catch {
      // A save refused because this tab's target was replaced is not a
      // failure of the save; the gateway target gate explains it.
      if (!isGatewayTargetRetired()) toast("error", "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  /* ── Loading state ──────────────────────────────────────────────── */

  if (loading) {
    return (
      <Card>
        <div className="animate-pulse space-y-4">
          <div className="h-5 w-2/5 bg-bg-card-hover rounded" />
          <div className="h-10 w-full bg-bg-card-hover rounded" />
          <div className="h-10 w-full bg-bg-card-hover rounded" />
        </div>
      </Card>
    );
  }

  if (settings === null) {
    if (readFailed === "denied") {
      return <ReadDeniedNotice label="Connection settings" />;
    }
    return (
      <Card className="border-warning/40" role="status">
        <p className="text-sm text-warning">Unable to load settings</p>
        <p className="text-xs text-text-muted mt-1">
          No settings response has loaded, so the current configuration is
          unknown. No configuration values are shown here.
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-3"
          loading={retrying}
          onClick={() => void retry()}
        >
          Retry
        </Button>
      </Card>
    );
  }

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      <CapabilityNotice verdict={canWrite} />
      {/* Admin URL + TLS */}
      <Card>
        <h2 className="text-sm font-semibold text-text-primary mb-4">
          Connection
        </h2>
        <div className="space-y-4">
          <Input
            label="Admin URL"
            value={settings.adminUrl}
            onChange={(e) => update("adminUrl", e.target.value)}
            placeholder="http://localhost:9876"
            helpText="The Ferrum Admin API URL that this BFF server connects to"
            disabled={!settings.runtimeSettingsEnabled}
          />

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-text-secondary text-sm font-medium">
              JWT Secret
            </span>
            <div className="rounded-lg border border-border bg-bg-input px-3 py-2 text-text-muted text-sm">
              Configured via the <code className="font-mono text-text-secondary">FERRUM_JWT_SECRET</code> environment variable.
            </div>
            <p className="text-text-muted text-xs">
              The HS256 signing secret cannot be changed at runtime. Restart the
              BFF with an updated <code className="font-mono">FERRUM_JWT_SECRET</code> to rotate it.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="JWT Issuer"
              value={settings.jwtIssuer}
              onChange={(e) => update("jwtIssuer", e.target.value)}
              placeholder="ferrum-edge"
              helpText="JWT 'iss' claim. Must match gateway's FERRUM_ADMIN_JWT_ISSUER."
              disabled={!settings.runtimeSettingsEnabled}
            />
            <Input
              label="JWT TTL (seconds)"
              type="number"
              min={1}
              value={numberDraftText(settings.jwtTtl)}
              onChange={(e) => update("jwtTtl", numberDraftFromInput(e.target.value))}
              error={errors.jwtTtl}
              helpText="Token lifetime in seconds. Maps to FERRUM_JWT_TTL."
              disabled={!settings.runtimeSettingsEnabled}
            />
          </div>
          {settings.authMode === "trusted-proxy" && (
            <p className="text-text-secondary text-sm">
              Your identity proxy manages gateway roles and namespace grants.
              Change access there; these static login defaults do not affect
              trusted-proxy sessions.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Default gateway role"
              helpText="Applies to new static logins. Trusted-proxy roles come from the identity proxy."
              value={settings.jwtRole}
              onValueChange={(value) => update("jwtRole", value as Settings["jwtRole"])}
              options={[
                { value: "viewer", label: "Viewer" },
                { value: "operator", label: "Operator" },
                { value: "admin", label: "Admin" },
              ]}
              disabled={!settings.runtimeSettingsEnabled || settings.authMode !== "static"}
            />
            <Input
              label="JWT Audience"
              value={Array.isArray(settings.jwtAudience) ? settings.jwtAudience.join(", ") : settings.jwtAudience ?? ""}
              onChange={(event) => update("jwtAudience", event.target.value)}
              helpText="Optional comma-separated aud claim; leave empty unless the gateway requires it."
              disabled={!settings.runtimeSettingsEnabled}
            />
          </div>
          <Input
            label="Namespace grants"
            value={namespaceText}
            onChange={(event) => setNamespaceText(event.target.value)}
            onBlur={checkNamespaceGrants}
            helpText="Applies to new static logins: exact comma-separated namespace grants."
            error={errors.jwtNamespaces}
            disabled={!settings.runtimeSettingsEnabled || settings.authMode !== "static"}
          />
        </div>
      </Card>

      {/* TLS */}
      {settings.adminUrl.startsWith("https") && (
        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-4">
            TLS
          </h2>
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-secondary">
              Custom CA bundle: {settings.tlsCaConfigured ? "configured by the server" : "not configured"}
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.tlsVerify}
                onChange={(e) => update("tlsVerify", e.target.checked)}
                className="h-4 w-4 rounded border-border bg-bg-input accent-orange"
                disabled={!settings.runtimeSettingsEnabled}
              />
              <div>
                <span className="text-sm font-medium text-text-secondary">
                  TLS Verify
                </span>
                <p className="text-xs text-text-muted">
                  Verify TLS certificates when connecting to the Admin API
                </p>
              </div>
            </label>
          </div>
        </Card>
      )}

      {/* Timeouts */}
      <Card>
        <h2 className="text-sm font-semibold text-text-primary mb-4">
          Timeouts
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Input
            label="Connect Timeout (ms)"
            type="number"
            min={0}
            value={numberDraftText(settings.connectTimeout)}
            onChange={(e) => update("connectTimeout", numberDraftFromInput(e.target.value))}
            error={errors.connectTimeout}
            disabled={!settings.runtimeSettingsEnabled}
          />
          <Input
            label="Read Timeout (ms)"
            type="number"
            min={0}
            value={numberDraftText(settings.readTimeout)}
            onChange={(e) => update("readTimeout", numberDraftFromInput(e.target.value))}
            error={errors.readTimeout}
            disabled={!settings.runtimeSettingsEnabled}
          />
          <Input
            label="Write Timeout (ms)"
            type="number"
            min={0}
            value={numberDraftText(settings.writeTimeout)}
            onChange={(e) => update("writeTimeout", numberDraftFromInput(e.target.value))}
            error={errors.writeTimeout}
            disabled={!settings.runtimeSettingsEnabled}
          />
        </div>
      </Card>

      {/* Connection test */}
      <Card>
        <h2 className="text-sm font-semibold text-text-primary mb-4">
          Connection Test
        </h2>
        <div className="flex items-center gap-4 flex-wrap">
          <Button
            variant="secondary"
            onClick={handleTest}
            loading={testing}
          >
            Test Connection
          </Button>

          {status && (
            <Badge variant={status.reachable ? "green" : "red"}>
              {status.reachable
                ? `Connected (HTTP ${status.status})`
                : status.error || "Not reachable"}
            </Badge>
          )}
        </div>
      </Card>

      {/* Actions */}
      <div className="flex items-center justify-between gap-4">
        <p className="text-text-muted text-xs max-w-md">
          {settings.runtimeSettingsEnabled
            ? "Overrides reset to environment values on BFF restart and are restricted to the server allowlist."
            : "Connection and signing settings are immutable environment/secret-mounted configuration."}
        </p>
        {settings.runtimeSettingsEnabled && (
          <Button onClick={handleSave} loading={saving} disabled={!canWrite.allowed}>
            Save Settings
          </Button>
        )}
      </div>
    </div>
  );
}
