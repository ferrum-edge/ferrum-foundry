/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – BFF connection settings form                      */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";

/* ── Types ─────────────────────────────────────────────────────────── */

interface Settings {
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

interface StatusResult {
  reachable: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

const DEFAULT_SETTINGS: Settings = {
  adminUrl: "",
  jwtIssuer: "ferrum-edge",
  jwtTtl: 900,
  jwtRole: "admin",
  jwtAudience: undefined,
  jwtNamespaces: undefined,
  tlsCaConfigured: false,
  tlsVerify: true,
  connectTimeout: 5000,
  readTimeout: 60000,
  writeTimeout: 60000,
  runtimeSettingsEnabled: false,
};

/* ================================================================== */
/*  SettingsForm                                                       */
/* ================================================================== */

export function SettingsForm() {
  const { toast } = useToast();

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<StatusResult | null>(null);

  /* ── Fetch current settings ─────────────────────────────────────── */

  const fetchSettings = useCallback(async () => {
    try {
      const data = await api.get("api/settings").json<Settings>();
      setSettings(data);
    } catch {
      toast("error", "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  /* ── Field helpers ──────────────────────────────────────────────── */

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
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
    setSaving(true);
    try {
      const {
        tlsCaConfigured: _tlsCaConfigured,
        runtimeSettingsEnabled: _runtimeSettingsEnabled,
        ...updates
      } = settings;
      await api.put("api/settings", { json: updates });
      toast("success", "Settings saved successfully");
    } catch {
      toast("error", "Failed to save settings");
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

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
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
              value={settings.jwtTtl}
              onChange={(e) => update("jwtTtl", Number(e.target.value))}
              helpText="Token lifetime in seconds. Maps to FERRUM_JWT_TTL."
              disabled={!settings.runtimeSettingsEnabled}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Default gateway role"
              value={settings.jwtRole}
              onValueChange={(value) => update("jwtRole", value as Settings["jwtRole"])}
              options={[
                { value: "viewer", label: "Viewer" },
                { value: "operator", label: "Operator" },
                { value: "admin", label: "Admin" },
              ]}
              disabled={!settings.runtimeSettingsEnabled}
            />
            <Input
              label="JWT Audience"
              value={Array.isArray(settings.jwtAudience) ? settings.jwtAudience.join(", ") : settings.jwtAudience ?? ""}
              onChange={(event) => update("jwtAudience", event.target.value || undefined)}
              helpText="Optional comma-separated aud claim; leave empty unless the gateway requires it."
              disabled={!settings.runtimeSettingsEnabled}
            />
          </div>
          <Input
            label="Namespace grants"
            value={settings.jwtNamespaces?.join(", ") ?? ""}
            onChange={(event) => update(
              "jwtNamespaces",
              event.target.value.split(",").map((value) => value.trim()).filter(Boolean),
            )}
            helpText="Exact comma-separated ns grants. No wildcard semantics are inferred."
            disabled={!settings.runtimeSettingsEnabled}
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
            value={settings.connectTimeout}
            onChange={(e) => update("connectTimeout", Number(e.target.value))}
            disabled={!settings.runtimeSettingsEnabled}
          />
          <Input
            label="Read Timeout (ms)"
            type="number"
            min={0}
            value={settings.readTimeout}
            onChange={(e) => update("readTimeout", Number(e.target.value))}
            disabled={!settings.runtimeSettingsEnabled}
          />
          <Input
            label="Write Timeout (ms)"
            type="number"
            min={0}
            value={settings.writeTimeout}
            onChange={(e) => update("writeTimeout", Number(e.target.value))}
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
          <Button onClick={handleSave} loading={saving}>Save Settings</Button>
        )}
      </div>
    </div>
  );
}
