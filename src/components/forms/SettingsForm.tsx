/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – BFF connection settings form                      */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";

/* ── Types ─────────────────────────────────────────────────────────── */

interface Settings {
  adminUrl: string;
  jwtSecret: string;
  jwtIssuer: string;
  jwtTtl: number;
  tlsCaPath: string | undefined;
  tlsVerify: boolean;
  connectTimeout: number;
  readTimeout: number;
  writeTimeout: number;
}

interface StatusResult {
  reachable: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

const DEFAULT_SETTINGS: Settings = {
  adminUrl: "",
  jwtSecret: "",
  jwtIssuer: "ferrum-edge",
  jwtTtl: 3600,
  tlsCaPath: undefined,
  tlsVerify: true,
  connectTimeout: 5000,
  readTimeout: 60000,
  writeTimeout: 60000,
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
  const [showSecret, setShowSecret] = useState(false);

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
      await api.put("api/settings", { json: settings });
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
          />

          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="jwt-secret" className="text-text-secondary text-sm font-medium">
              JWT Secret
            </label>
            <div className="relative">
              <input
                id="jwt-secret"
                type={showSecret ? "text" : "password"}
                value={settings.jwtSecret}
                onChange={(e) => update("jwtSecret", e.target.value)}
                placeholder="Enter JWT signing secret"
                className="w-full min-w-0 bg-bg-input border border-border rounded-lg px-3 py-2 pr-10 text-text-primary text-sm placeholder:text-text-muted transition-colors duration-150 focus:border-orange focus:ring-1 focus:ring-orange/30"
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-secondary transition-colors cursor-pointer"
              >
                {showSecret ? (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                )}
              </button>
            </div>
            <p className="text-text-muted text-xs">
              HS256 signing secret used by this BFF to sign requests to the
              gateway. Must match the gateway's FERRUM_ADMIN_JWT_SECRET. Changes
              here are in-memory only and reset on BFF restart.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="JWT Issuer"
              value={settings.jwtIssuer}
              onChange={(e) => update("jwtIssuer", e.target.value)}
              placeholder="ferrum-edge"
              helpText="JWT 'iss' claim. Must match gateway's FERRUM_ADMIN_JWT_ISSUER."
            />
            <Input
              label="JWT TTL (seconds)"
              type="number"
              min={1}
              value={settings.jwtTtl}
              onChange={(e) => update("jwtTtl", Number(e.target.value))}
              helpText="Token lifetime in seconds. Maps to FERRUM_JWT_TTL."
            />
          </div>
        </div>
      </Card>

      {/* TLS */}
      {settings.adminUrl.startsWith("https") && (
        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-4">
            TLS
          </h2>
          <div className="space-y-4">
            <Input
              label="TLS CA Path"
              value={settings.tlsCaPath ?? ""}
              onChange={(e) => update("tlsCaPath", e.target.value || undefined)}
              placeholder="/path/to/ca-bundle.pem"
              helpText="Path to a custom CA bundle for verifying the gateway's TLS certificate. Maps to FERRUM_TLS_CA_PATH. In-memory only, resets on restart."
            />
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.tlsVerify}
                onChange={(e) => update("tlsVerify", e.target.checked)}
                className="h-4 w-4 rounded border-border bg-bg-input accent-orange"
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
          />
          <Input
            label="Read Timeout (ms)"
            type="number"
            min={0}
            value={settings.readTimeout}
            onChange={(e) => update("readTimeout", Number(e.target.value))}
          />
          <Input
            label="Write Timeout (ms)"
            type="number"
            min={0}
            value={settings.writeTimeout}
            onChange={(e) => update("writeTimeout", Number(e.target.value))}
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
          All settings are in-memory overrides and reset to their environment
          variable values on BFF restart.
        </p>
        <Button onClick={handleSave} loading={saving}>
          Save Settings
        </Button>
      </div>
    </div>
  );
}
