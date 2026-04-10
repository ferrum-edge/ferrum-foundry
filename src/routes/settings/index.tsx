/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Settings page                                     */
/* ------------------------------------------------------------------ */

import { useState } from "react";
import { SettingsForm } from "@/components/forms/SettingsForm";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useNamespace } from "@/stores/namespace";
import { useNamespaces } from "@/hooks/useNamespaces";
import {
  getStoredMetricsRefreshInterval,
  METRICS_REFRESH_OPTIONS,
  setStoredMetricsRefreshInterval,
} from "@/utils/metricsRefresh";

/* ================================================================== */
/*  SettingsPage                                                       */
/* ================================================================== */

export default function SettingsPage() {
  const { toast } = useToast();
  const { selectedNamespace, setNamespace } = useNamespace();
  const { data: namespaces, isLoading: nsLoading } = useNamespaces();

  const [refreshInterval, setRefreshInterval] = useState(() =>
    String(getStoredMetricsRefreshInterval()),
  );

  /* ── Handlers ───────────────────────────────────────────────────── */

  function handleRefreshChange(value: string) {
    setRefreshInterval(value);
    try {
      setStoredMetricsRefreshInterval(Number(value));
      toast("success", "Metrics refresh interval updated");
    } catch {
      toast("error", "Failed to save preference");
    }
  }

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div className="space-y-8 max-w-3xl">
      <h1 className="text-2xl font-bold text-text-primary">Settings</h1>

      {/* ── BFF Connection Settings ────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          BFF Connection
        </h2>
        <SettingsForm />
      </section>

      {/* ── Namespace Selection ────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          Namespace
        </h2>
        <Card>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-sm text-text-secondary">
                Current namespace:
              </span>
              <Badge variant="orange">{selectedNamespace}</Badge>
            </div>

            {nsLoading ? (
              <div className="h-10 w-48 bg-bg-card-hover rounded animate-pulse" />
            ) : namespaces && namespaces.length > 0 ? (
              <Select
                label="Switch Namespace"
                value={selectedNamespace}
                onValueChange={setNamespace}
                options={namespaces.map((ns: string) => ({
                  value: ns,
                  label: ns,
                }))}
              />
            ) : (
              <Input
                label="Namespace"
                value={selectedNamespace}
                onChange={(e) => setNamespace(e.target.value)}
                helpText="Enter the namespace name manually (no namespaces returned from server)"
              />
            )}
          </div>
        </Card>
      </section>

      {/* ── Metrics Refresh ───────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          Metrics Refresh
        </h2>
        <Card>
          <Select
            label="Default Refresh Interval"
            value={refreshInterval}
            onValueChange={handleRefreshChange}
            options={METRICS_REFRESH_OPTIONS}
          />
          <p className="text-text-muted text-xs mt-3">
            Controls how often metrics data is automatically refreshed on the
            Metrics and Dashboard pages.
          </p>
        </Card>
      </section>
    </div>
  );
}
