/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Upstream create / edit form                       */
/* ------------------------------------------------------------------ */

import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { CollapsibleSection } from "./CollapsibleSection";
import { TargetForm } from "./TargetForm";
import type {
  Upstream,
  UpstreamCreate,
  UpstreamTarget,
  HealthCheckConfig,
  ActiveHealthCheck,
  PassiveHealthCheck,
  HashOnCookieConfig,
  ServiceDiscoveryConfig,
} from "@/api/types";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface UpstreamFormProps {
  initialData?: Upstream;
  onSubmit: (data: UpstreamCreate) => Promise<void>;
  isLoading: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ALGORITHMS: Upstream["algorithm"][] = [
  "round_robin",
  "weighted_round_robin",
  "least_connections",
  "least_latency",
  "consistent_hashing",
  "random",
];

const ALGORITHM_OPTIONS = ALGORITHMS.map((a) => ({
  value: a,
  label: a.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
}));

const SD_PROVIDERS = [
  { value: "dns_sd", label: "DNS Service Discovery" },
  { value: "kubernetes", label: "Kubernetes" },
  { value: "consul", label: "Consul" },
];

const SAME_SITE_OPTIONS = [
  { value: "Strict", label: "Strict" },
  { value: "Lax", label: "Lax" },
  { value: "None", label: "None" },
];

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

/* ------------------------------------------------------------------ */
/*  Default builders                                                   */
/* ------------------------------------------------------------------ */

function defaultActiveHealthCheck(): ActiveHealthCheck {
  return {
    http_path: "/health",
    interval_seconds: 10,
    timeout_ms: 5000,
    healthy_threshold: 3,
    unhealthy_threshold: 3,
    healthy_status_codes: [200, 302],
    probe_type: "http",
    use_tls: false,
  };
}

function defaultPassiveHealthCheck(): PassiveHealthCheck {
  return {
    unhealthy_threshold: 3,
    unhealthy_status_codes: [500, 502, 503, 504],
    unhealthy_window_seconds: 30,
  };
}

function defaultHashOnCookieConfig(): HashOnCookieConfig {
  return {
    path: "/",
    ttl_seconds: 3600,
    domain: undefined,
    http_only: true,
    secure: false,
    same_site: "Lax",
  };
}

/* ================================================================== */
/*  UpstreamForm                                                       */
/* ================================================================== */

export function UpstreamForm({ initialData, onSubmit, isLoading }: UpstreamFormProps) {
  const navigate = useNavigate();
  const isEdit = !!initialData;

  /* ---------- Basic ---------- */
  const [name, setName] = useState(initialData?.name ?? "");
  const [algorithm, setAlgorithm] = useState<Upstream["algorithm"]>(
    initialData?.algorithm ?? "round_robin",
  );
  const [hashOn, setHashOn] = useState(initialData?.hash_on ?? "");

  /* ---------- Targets ---------- */
  const [targets, setTargets] = useState<UpstreamTarget[]>(initialData?.targets ?? []);
  const [showTargetForm, setShowTargetForm] = useState(false);
  const [editingTargetIndex, setEditingTargetIndex] = useState<number | null>(null);

  /* ---------- Health Checks ---------- */
  const [activeHcEnabled, setActiveHcEnabled] = useState(!!initialData?.health_checks?.active);
  const [activeHc, setActiveHc] = useState<ActiveHealthCheck>(
    initialData?.health_checks?.active ?? defaultActiveHealthCheck(),
  );
  const [passiveHcEnabled, setPassiveHcEnabled] = useState(!!initialData?.health_checks?.passive);
  const [passiveHc, setPassiveHc] = useState<PassiveHealthCheck>(
    initialData?.health_checks?.passive ?? defaultPassiveHealthCheck(),
  );

  /* ---------- Hash Cookie Config ---------- */
  const [cookieConfig, setCookieConfig] = useState<HashOnCookieConfig>({
    path: initialData?.hash_on_cookie_config?.path ?? "/",
    ttl_seconds: initialData?.hash_on_cookie_config?.ttl_seconds ?? 3600,
    domain: initialData?.hash_on_cookie_config?.domain,
    http_only: initialData?.hash_on_cookie_config?.http_only ?? true,
    secure: initialData?.hash_on_cookie_config?.secure ?? false,
    same_site: initialData?.hash_on_cookie_config?.same_site ?? "Lax",
  });

  /* ---------- Service Discovery ---------- */
  const [sdEnabled, setSdEnabled] = useState(!!initialData?.service_discovery);
  const [sdProvider, setSdProvider] = useState(initialData?.service_discovery?.provider ?? "dns_sd");
  const [sdServiceName, setSdServiceName] = useState(() => {
    const sd = initialData?.service_discovery;
    if (!sd) return "";
    return sd.dns_sd?.service_name ?? sd.kubernetes?.service_name ?? sd.consul?.service_name ?? "";
  });
  const [sdConfig, setSdConfig] = useState<Record<string, unknown>>(() => {
    const sd = initialData?.service_discovery;
    if (!sd) return {};
    const providerConfig = sd[sd.provider] as Record<string, unknown> | undefined;
    if (!providerConfig) return {};
    const { service_name: _, ...rest } = providerConfig;
    return { ...rest, default_weight: sd.default_weight ?? 1 };
  });

  /* ---------- Validation ---------- */
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (targets.length === 0 && !sdEnabled) errs.targets = "At least one target is required (unless service discovery is enabled)";
    if (algorithm === "consistent_hashing" && !hashOn.trim()) {
      errs.hash_on = "Hash key is required for consistent hashing";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  /* ---------- Submit ---------- */

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    const healthChecks: HealthCheckConfig | undefined =
      activeHcEnabled || passiveHcEnabled
        ? {
            ...(activeHcEnabled && { active: activeHc }),
            ...(passiveHcEnabled && { passive: passiveHc }),
          }
        : undefined;

    const hashOnCookie: HashOnCookieConfig | undefined =
      hashOn.startsWith("cookie:")
        ? {
            path: cookieConfig.path,
            ttl_seconds: cookieConfig.ttl_seconds,
            ...(cookieConfig.domain && { domain: cookieConfig.domain }),
            http_only: cookieConfig.http_only,
            secure: cookieConfig.secure,
            same_site: cookieConfig.same_site,
          }
        : undefined;

    const serviceDiscovery: ServiceDiscoveryConfig | undefined = sdEnabled
      ? {
          provider: sdProvider as ServiceDiscoveryConfig["provider"],
          ...(sdProvider === "dns_sd" && {
            dns_sd: {
              service_name: sdServiceName,
              poll_interval_seconds: (sdConfig.poll_interval_seconds as number) ?? 30,
            },
          }),
          ...(sdProvider === "kubernetes" && {
            kubernetes: {
              service_name: sdServiceName,
              namespace: (sdConfig.namespace as string) || undefined,
              port_name: (sdConfig.port_name as string) || undefined,
              poll_interval_seconds: (sdConfig.poll_interval_seconds as number) ?? 30,
            },
          }),
          ...(sdProvider === "consul" && {
            consul: {
              address: (sdConfig.address as string) || undefined,
              service_name: sdServiceName,
              datacenter: (sdConfig.datacenter as string) || undefined,
              tag: (sdConfig.tag as string) || undefined,
              healthy_only: (sdConfig.healthy_only as boolean) ?? true,
              token: (sdConfig.token as string) || undefined,
              poll_interval_seconds: (sdConfig.poll_interval_seconds as number) ?? 30,
            },
          }),
          default_weight: (sdConfig.default_weight as number) ?? 1,
        }
      : undefined;

    const data: UpstreamCreate = {
      targets,
      algorithm,
      ...(name.trim() && { name: name.trim() }),
      ...(hashOn.trim() && { hash_on: hashOn.trim() }),
      ...(hashOnCookie && { hash_on_cookie_config: hashOnCookie }),
      ...(healthChecks && { health_checks: healthChecks }),
      ...(serviceDiscovery && { service_discovery: serviceDiscovery }),
    };

    await onSubmit(data);
  };

  /* ---------- Target handlers ---------- */

  const handleAddTarget = (target: UpstreamTarget) => {
    setTargets((prev) => [...prev, target]);
    setShowTargetForm(false);
  };

  const handleUpdateTarget = (target: UpstreamTarget) => {
    if (editingTargetIndex === null) return;
    setTargets((prev) => prev.map((t, i) => (i === editingTargetIndex ? target : t)));
    setEditingTargetIndex(null);
  };

  const handleRemoveTarget = (index: number) => {
    setTargets((prev) => prev.filter((_, i) => i !== index));
    if (editingTargetIndex === index) setEditingTargetIndex(null);
  };

  /* ---------- SD config helpers ---------- */

  const updateSdConfig = (key: string, value: unknown) => {
    setSdConfig((prev) => ({ ...prev, [key]: value }));
  };

  /* ---------- Helpers ---------- */

  const numVal = (v: number | ""): string => (v === "" ? "" : String(v));
  const showHashCookie = hashOn.startsWith("cookie:");

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <form onSubmit={handleSubmit} className="space-y-0">
      {/* ── Basic ── */}
      <div className="border-b border-border/50 py-4">
        <h3 className="text-sm font-semibold text-text-primary mb-4">Basic Configuration</h3>
        <div className="space-y-4">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Upstream"
            helpText="Optional friendly name for this upstream"
          />
          <Select
            label="Algorithm"
            value={algorithm}
            onValueChange={(v) => setAlgorithm(v as Upstream["algorithm"])}
            options={ALGORITHM_OPTIONS}
          />
          {algorithm === "consistent_hashing" && (
            <Input
              label="Hash On"
              value={hashOn}
              onChange={(e) => setHashOn(e.target.value)}
              placeholder="ip, header:<name>, cookie:<name>"
              helpText="Key used for consistent hashing: ip, header:<name>, or cookie:<name>"
              error={errors.hash_on}
              required
            />
          )}
        </div>
      </div>

      {/* ── Targets ── */}
      <div className="border-b border-border/50 py-4">
        <h3 className="text-sm font-semibold text-text-primary mb-4">
          Targets
          {targets.length > 0 && (
            <span className="ml-2 text-text-muted font-normal">({targets.length})</span>
          )}
        </h3>

        {errors.targets && (
          <p className="text-danger text-xs mb-3">{errors.targets}</p>
        )}

        {/* Existing targets */}
        {targets.length > 0 && (
          <div className="space-y-2 mb-4">
            {targets.map((target, index) => (
              <div key={`${target.host}-${target.port}-${index}`}>
                {editingTargetIndex === index ? (
                  <TargetForm
                    initialData={target}
                    onSubmit={handleUpdateTarget}
                    onCancel={() => setEditingTargetIndex(null)}
                  />
                ) : (
                  <Card className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-text-primary font-mono">
                        {target.host}:{target.port}
                      </span>
                      <Badge variant="default">weight {target.weight}</Badge>
                      {target.path && (
                        <Badge variant="blue">{target.path}</Badge>
                      )}
                      {target.tags && Object.keys(target.tags).length > 0 && (
                        <div className="flex gap-1">
                          {Object.entries(target.tags).map(([k, v]) => (
                            <Badge key={k} variant="purple">
                              {k}:{v}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowTargetForm(false);
                          setEditingTargetIndex(index);
                        }}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveTarget(index)}
                      >
                        <svg className="w-4 h-4 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </Button>
                    </div>
                  </Card>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add target form */}
        {showTargetForm ? (
          <TargetForm
            onSubmit={handleAddTarget}
            onCancel={() => setShowTargetForm(false)}
          />
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditingTargetIndex(null);
              setShowTargetForm(true);
            }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add Target
          </Button>
        )}
      </div>

      {/* ── Health Checks ── */}
      <CollapsibleSection
        title="Health Checks"
        badge={activeHcEnabled || passiveHcEnabled ? "ON" : undefined}
      >
        {/* Active */}
        <Checkbox
          label="Enable active health checks"
          checked={activeHcEnabled}
          onChange={setActiveHcEnabled}
        />
        {activeHcEnabled && (
          <div className="space-y-4 pl-6 border-l-2 border-border/50">
            <Select
              label="Probe Type"
              value={activeHc.probe_type ?? "http"}
              onValueChange={(v) => setActiveHc({ ...activeHc, probe_type: v as "http" | "tcp" | "udp" })}
              options={[
                { value: "http", label: "HTTP / HTTPS" },
                { value: "tcp", label: "TCP" },
                { value: "udp", label: "UDP" },
              ]}
            />
            <Input
              label="Interval (seconds)"
              type="number"
              value={String(activeHc.interval_seconds)}
              onChange={(e) => setActiveHc({ ...activeHc, interval_seconds: Number(e.target.value) })}
            />
            <Input
              label="Timeout (ms)"
              type="number"
              value={String(activeHc.timeout_ms)}
              onChange={(e) => setActiveHc({ ...activeHc, timeout_ms: Number(e.target.value) })}
            />
            <Input
              label="Healthy Threshold"
              type="number"
              value={String(activeHc.healthy_threshold)}
              onChange={(e) => setActiveHc({ ...activeHc, healthy_threshold: Number(e.target.value) })}
            />
            <Input
              label="Unhealthy Threshold"
              type="number"
              value={String(activeHc.unhealthy_threshold)}
              onChange={(e) => setActiveHc({ ...activeHc, unhealthy_threshold: Number(e.target.value) })}
            />
            {(activeHc.probe_type ?? "http") === "http" && (
              <>
                <Input
                  label="HTTP Path"
                  value={activeHc.http_path}
                  onChange={(e) => setActiveHc({ ...activeHc, http_path: e.target.value })}
                  placeholder="/health"
                />
                <Input
                  label="Healthy Status Codes"
                  value={activeHc.healthy_status_codes.join(", ")}
                  onChange={(e) =>
                    setActiveHc({
                      ...activeHc,
                      healthy_status_codes: e.target.value
                        .split(",")
                        .map((s) => parseInt(s.trim(), 10))
                        .filter((n) => !isNaN(n)),
                    })
                  }
                  placeholder="200, 302"
                  helpText="Comma-separated HTTP status codes considered healthy"
                />
                <Checkbox
                  label="Use HTTPS for health probes"
                  checked={activeHc.use_tls ?? false}
                  onChange={(v) => setActiveHc({ ...activeHc, use_tls: v })}
                />
              </>
            )}
            {(activeHc.probe_type) === "udp" && (
              <Input
                label="UDP Probe Payload"
                value={activeHc.udp_probe_payload ?? ""}
                onChange={(e) => setActiveHc({ ...activeHc, udp_probe_payload: e.target.value || undefined })}
                placeholder="0000"
                helpText="Hex-encoded payload to send for UDP probes. If empty, a single zero byte is sent."
              />
            )}
          </div>
        )}

        {/* Passive */}
        <div className="mt-4">
          <Checkbox
            label="Enable passive health checks"
            checked={passiveHcEnabled}
            onChange={setPassiveHcEnabled}
          />
        </div>
        {passiveHcEnabled && (
          <div className="space-y-4 pl-6 border-l-2 border-border/50">
            <Input
              label="Unhealthy Status Codes"
              value={passiveHc.unhealthy_status_codes.join(", ")}
              onChange={(e) =>
                setPassiveHc({
                  ...passiveHc,
                  unhealthy_status_codes: e.target.value
                    .split(",")
                    .map((s) => parseInt(s.trim(), 10))
                    .filter((n) => !isNaN(n)),
                })
              }
              placeholder="500, 502, 503"
              helpText="Comma-separated HTTP status codes"
            />
            <Input
              label="Unhealthy Threshold"
              type="number"
              value={String(passiveHc.unhealthy_threshold)}
              onChange={(e) => setPassiveHc({ ...passiveHc, unhealthy_threshold: Number(e.target.value) })}
            />
            <Input
              label="Unhealthy Window (seconds)"
              type="number"
              value={String(passiveHc.unhealthy_window_seconds)}
              onChange={(e) => setPassiveHc({ ...passiveHc, unhealthy_window_seconds: Number(e.target.value) })}
            />
          </div>
        )}
      </CollapsibleSection>

      {/* ── Hash Cookie Config ── */}
      {showHashCookie && (
        <CollapsibleSection title="Hash Cookie Config">
          <Input
            label="Path"
            value={cookieConfig.path ?? ""}
            onChange={(e) => setCookieConfig({ ...cookieConfig, path: e.target.value })}
            placeholder="/"
          />
          <Input
            label="TTL (seconds)"
            type="number"
            value={String(cookieConfig.ttl_seconds ?? "")}
            onChange={(e) => setCookieConfig({ ...cookieConfig, ttl_seconds: Number(e.target.value) })}
          />
          <Input
            label="Domain"
            value={cookieConfig.domain ?? ""}
            onChange={(e) => setCookieConfig({ ...cookieConfig, domain: e.target.value })}
            placeholder=".example.com"
          />
          <Checkbox
            label="HTTP Only"
            checked={cookieConfig.http_only ?? false}
            onChange={(v) => setCookieConfig({ ...cookieConfig, http_only: v })}
          />
          <Checkbox
            label="Secure"
            checked={cookieConfig.secure ?? false}
            onChange={(v) => setCookieConfig({ ...cookieConfig, secure: v })}
          />
          <Select
            label="SameSite"
            value={cookieConfig.same_site ?? "Lax"}
            onValueChange={(v) => setCookieConfig({ ...cookieConfig, same_site: v as HashOnCookieConfig["same_site"] })}
            options={SAME_SITE_OPTIONS}
          />
        </CollapsibleSection>
      )}

      {/* ── Service Discovery ── */}
      <CollapsibleSection
        title="Service Discovery"
        badge={sdEnabled ? sdProvider.toUpperCase() : undefined}
      >
        <Checkbox
          label="Enable service discovery"
          checked={sdEnabled}
          onChange={setSdEnabled}
        />
        {sdEnabled && (
          <div className="space-y-4 pl-6 border-l-2 border-border/50">
            <Select
              label="Provider"
              value={sdProvider}
              onValueChange={(v) => {
                setSdProvider(v as ServiceDiscoveryConfig["provider"]);
                setSdConfig({});
              }}
              options={SD_PROVIDERS}
            />
            <Input
              label="Service Name"
              value={sdServiceName}
              onChange={(e) => setSdServiceName(e.target.value)}
              placeholder="my-service"
              required
            />
            {/* Provider-specific fields */}
            {sdProvider === "dns_sd" && (
              <Input
                label="Poll Interval (seconds)"
                type="number"
                value={String((sdConfig.poll_interval_seconds as number) ?? 30)}
                onChange={(e) => updateSdConfig("poll_interval_seconds", Number(e.target.value))}
              />
            )}

            {sdProvider === "kubernetes" && (
              <>
                <Input
                  label="Namespace"
                  value={String(sdConfig.namespace ?? "")}
                  onChange={(e) => updateSdConfig("namespace", e.target.value)}
                  placeholder="default"
                />
                <Input
                  label="Port Name"
                  value={String(sdConfig.port_name ?? "")}
                  onChange={(e) => updateSdConfig("port_name", e.target.value)}
                  placeholder="http"
                />
                <Input
                  label="Poll Interval (seconds)"
                  type="number"
                  value={String((sdConfig.poll_interval_seconds as number) ?? 30)}
                  onChange={(e) => updateSdConfig("poll_interval_seconds", Number(e.target.value))}
                />
              </>
            )}

            {sdProvider === "consul" && (
              <>
                <Input
                  label="Address"
                  value={String(sdConfig.address ?? "")}
                  onChange={(e) => updateSdConfig("address", e.target.value)}
                  placeholder="http://consul.local:8500"
                />
                <Input
                  label="Datacenter"
                  value={String(sdConfig.datacenter ?? "")}
                  onChange={(e) => updateSdConfig("datacenter", e.target.value)}
                  placeholder="dc1"
                />
                <Input
                  label="Tag"
                  value={String(sdConfig.tag ?? "")}
                  onChange={(e) => updateSdConfig("tag", e.target.value)}
                  placeholder="production"
                />
                <Checkbox
                  label="Healthy Only"
                  checked={(sdConfig.healthy_only as boolean) ?? true}
                  onChange={(v) => updateSdConfig("healthy_only", v)}
                />
                <Input
                  label="Token"
                  value={String(sdConfig.token ?? "")}
                  onChange={(e) => updateSdConfig("token", e.target.value)}
                  placeholder="consul-acl-token"
                />
                <Input
                  label="Poll Interval (seconds)"
                  type="number"
                  value={String((sdConfig.poll_interval_seconds as number) ?? 30)}
                  onChange={(e) => updateSdConfig("poll_interval_seconds", Number(e.target.value))}
                />
              </>
            )}

            <Input
              label="Default Weight"
              type="number"
              value={String((sdConfig.default_weight as number) ?? 1)}
              onChange={(e) => updateSdConfig("default_weight", Number(e.target.value))}
              helpText="Default weight for discovered targets"
            />
          </div>
        )}
      </CollapsibleSection>

      {/* ── Actions ── */}
      <div className="flex items-center justify-end gap-3 pt-6">
        <Button
          type="button"
          variant="secondary"
          onClick={() => navigate({ to: "/upstreams" })}
          disabled={isLoading}
        >
          Cancel
        </Button>
        <Button type="submit" loading={isLoading}>
          {isEdit ? "Update Upstream" : "Create Upstream"}
        </Button>
      </div>
    </form>
  );
}
