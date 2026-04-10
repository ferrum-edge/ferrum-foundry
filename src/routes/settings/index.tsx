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

/* ── Constants ─────────────────────────────────────────────────────── */

const REFRESH_KEY = "ferrum:metricsRefreshInterval";
const DEFAULT_REFRESH = "300000"; // 5 minutes

const REFRESH_OPTIONS = [
  { value: "10000", label: "10 seconds" },
  { value: "30000", label: "30 seconds" },
  { value: "60000", label: "1 minute" },
  { value: "120000", label: "2 minutes" },
  { value: "300000", label: "5 minutes" },
  { value: "600000", label: "10 minutes" },
];

function getStoredRefresh(): string {
  try {
    return localStorage.getItem(REFRESH_KEY) ?? DEFAULT_REFRESH;
  } catch {
    return DEFAULT_REFRESH;
  }
}

/* ================================================================== */
/*  SettingsPage                                                       */
/* ================================================================== */

export default function SettingsPage() {
  const { toast } = useToast();
  const { selectedNamespace, setNamespace } = useNamespace();
  const { data: namespaces, isLoading: nsLoading } = useNamespaces();

  const [refreshInterval, setRefreshInterval] = useState(getStoredRefresh);

  /* ── Handlers ───────────────────────────────────────────────────── */

  function handleRefreshChange(value: string) {
    setRefreshInterval(value);
    try {
      localStorage.setItem(REFRESH_KEY, value);
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
            options={REFRESH_OPTIONS}
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
