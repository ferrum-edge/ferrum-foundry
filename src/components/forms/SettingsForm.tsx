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
          JWT secret and TLS CA path are configured via environment variables on
          the server.
        </p>
        <Button onClick={handleSave} loading={saving}>
          Save Settings
        </Button>
      </div>
    </div>
  );
}
