/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Settings page                                     */
/* ------------------------------------------------------------------ */

import { useState, type FormEvent } from "react";
import { SettingsForm } from "@/components/forms/SettingsForm";
import { BackupRestoreCard } from "@/components/forms/BackupRestoreCard";
import { NamespaceManagerCard } from "@/components/forms/NamespaceManagerCard";
import { ServiceManifestPreviewCard } from "@/components/forms/ServiceManifestPreviewCard";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/shared/PageHeader";
import { ReadStateNotice } from "@/components/shared/ReadState";
import { useToast } from "@/components/ui/Toast";
import { useNamespace } from "@/stores/namespace";
import { useNamespaces } from "@/hooks/useNamespaces";
import { validateNamespaceName } from "@/api/namespaces";
import {
  getStoredMetricsRefreshInterval,
  METRICS_REFRESH_OPTIONS,
  setStoredMetricsRefreshInterval,
} from "@/utils/metricsRefresh";

/* ================================================================== */
/*  NamespaceEntry                                                     */
/* ================================================================== */

/**
 * Free-text namespace selection, offered when the registry lists nothing or
 * cannot be read. The typed name is a draft: it becomes the active namespace
 * only on an explicit Switch (or Enter), and only once it passes the
 * gateway's name rule, so a half-typed or empty name never retargets the
 * session's reads and writes.
 */
function NamespaceEntry({
  label,
  helpText,
  selectedNamespace,
  onSwitch,
}: {
  label: string;
  helpText: string;
  selectedNamespace: string;
  onSwitch: (namespace: string) => void;
}) {
  const [draft, setDraft] = useState(selectedNamespace);
  const [error, setError] = useState<string | undefined>();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = validateNamespaceName(draft);
    if (problem) {
      setError(problem);
      return;
    }
    if (draft !== selectedNamespace) onSwitch(draft);
  }

  return (
    <form className="flex items-start gap-2" onSubmit={handleSubmit} noValidate>
      <div className="min-w-0 flex-1">
        <Input
          label={label}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(undefined);
          }}
          error={error}
          helpText={helpText}
        />
      </div>
      <Button type="submit" variant="secondary" className="shrink-0 mt-[1.625rem]"
        disabled={draft === selectedNamespace}>
        Switch
      </Button>
    </form>
  );
}

/* ================================================================== */
/*  SettingsPage                                                       */
/* ================================================================== */

export default function SettingsPage() {
  const { toast } = useToast();
  const { selectedNamespace, setNamespace } = useNamespace();
  const namespaceQuery = useNamespaces();
  const { data: namespaces, isLoading: nsLoading } = namespaceQuery;

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
      <PageHeader
        title="Settings"
        description="Foundry's gateway connection, namespaces, backup and restore, and display preferences."
      />

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
            ) : namespaceQuery.isError ? (
              <div className="space-y-3">
                <ReadStateNotice query={namespaceQuery} label="Namespace registry" />
                {namespaces && namespaces.length > 0 ? (
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
                  <NamespaceEntry
                    key={selectedNamespace}
                    label="Namespace fallback"
                    selectedNamespace={selectedNamespace}
                    onSwitch={setNamespace}
                    helpText="The registry is unavailable. You can enter a namespace manually as a fallback."
                  />
                )}
              </div>
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
              <NamespaceEntry
                key={selectedNamespace}
                label="Namespace"
                selectedNamespace={selectedNamespace}
                onSwitch={setNamespace}
                helpText="No namespaces are currently listed. Enter a namespace name manually."
              />
            )}
          </div>
        </Card>

        <div className="mt-4">
          <NamespaceManagerCard />
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          Alloy Service Manifest
        </h2>
        <ServiceManifestPreviewCard />
      </section>

      {/* ── Backup & Restore ──────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          Backup &amp; Restore
        </h2>
        <BackupRestoreCard />
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
