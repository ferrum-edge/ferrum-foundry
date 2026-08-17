/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TLS management page                               */
/*  Inventory, managed material stores, ACME automation, events,      */
/*  surface rotation, and material validation.                        */
/* ------------------------------------------------------------------ */

import { useState, type ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/Dialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { getApiErrorMessage } from "@/api/client";
import {
  useTlsInventory,
  useTlsEvents,
  useManagedTlsRecords,
  useCreateManagedTlsRecord,
  useDeleteManagedTlsRecord,
  useAcmeCertificates,
  useAcmeOrders,
  useAcmeAccounts,
  useCreateAcmeOrder,
  useDeleteAcmeOrder,
  useFinalizeAcmeOrder,
  useRenewAcmeCertificate,
  useDeleteAcmeCertificate,
  useRotateTlsSurface,
  useValidateTlsMaterial,
} from "@/hooks/useTls";
import type {
  ManagedTlsCollection,
  ManagedTlsRecord,
  TlsRotateSurface,
  AcmeOrder,
} from "@/api/tls";

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

function formatDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function expiryBadge(notAfter?: string): ReactNode {
  if (!notAfter) return null;
  const days = Math.floor((new Date(notAfter).getTime() - Date.now()) / 86400000);
  if (days < 0) return <Badge variant="red">expired</Badge>;
  if (days < 14) return <Badge variant="red">{days}d left</Badge>;
  if (days < 30) return <Badge variant="yellow">{days}d left</Badge>;
  return <Badge variant="green">{days}d left</Badge>;
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-text-muted break-all">{children}</span>;
}

/* ------------------------------------------------------------------ */
/*  Managed record collections                                         */
/* ------------------------------------------------------------------ */

interface ManagedTabConfig {
  collection: ManagedTlsCollection;
  title: string;
  description: string;
  /** Field definitions for the create dialog. */
  fields: Array<{
    key: string;
    label: string;
    textarea?: boolean;
    placeholder?: string;
    required?: boolean;
  }>;
}

const MANAGED_TABS: ManagedTabConfig[] = [
  {
    collection: "certificates",
    title: "Certificates",
    description:
      "Managed server/client certificates referenced as managed://certificates/{id}. Private keys are stored but never returned.",
    fields: [
      { key: "cert_pem", label: "Certificate (PEM)", textarea: true, required: true, placeholder: "-----BEGIN CERTIFICATE-----" },
      { key: "key_pem", label: "Private Key (PEM)", textarea: true, required: true, placeholder: "-----BEGIN PRIVATE KEY-----" },
      { key: "chain_pem", label: "Chain (PEM, optional)", textarea: true },
    ],
  },
  {
    collection: "ca-bundles",
    title: "CA Bundles",
    description:
      "Trust anchor bundles referenced as managed://ca-bundles/{id} for client or backend verification.",
    fields: [
      { key: "ca_bundle_pem", label: "CA Bundle (PEM)", textarea: true, required: true, placeholder: "-----BEGIN CERTIFICATE-----" },
    ],
  },
  {
    collection: "crls",
    title: "CRLs",
    description: "Certificate revocation lists referenced as managed://crls/{id}.",
    fields: [
      { key: "crl_pem", label: "CRL (PEM)", textarea: true, required: true, placeholder: "-----BEGIN X509 CRL-----" },
    ],
  },
  {
    collection: "ocsp-responses",
    title: "OCSP",
    description: "Stapled OCSP responses referenced as managed://ocsp-responses/{id}.",
    fields: [
      { key: "ocsp_der_base64", label: "OCSP Response (base64 DER)", textarea: true, required: true },
    ],
  },
  {
    collection: "jwks",
    title: "JWKS",
    description: "JSON Web Key Sets referenced as managed://jwks/{id} for token verification.",
    fields: [
      { key: "jwks_json", label: "JWKS Document (JSON)", textarea: true, required: true, placeholder: '{"keys":[...]}' },
    ],
  },
];

function ManagedRecordsTab({ config }: { config: ManagedTabConfig }) {
  const { toast } = useToast();
  const { data, isLoading } = useManagedTlsRecords(config.collection);
  const createRecord = useCreateManagedTlsRecord(config.collection);
  const deleteRecord = useDeleteManagedTlsRecord(config.collection);

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ManagedTlsRecord | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});

  const records = data?.data ?? [];

  const handleCreate = async () => {
    for (const field of config.fields) {
      if (field.required && !form[field.key]?.trim()) {
        toast("error", `${field.label} is required`);
        return;
      }
    }
    try {
      const payload: Record<string, string | boolean> = {};
      if (form.id?.trim()) payload.id = form.id.trim();
      if (form.name?.trim()) payload.name = form.name.trim();
      for (const field of config.fields) {
        if (form[field.key]?.trim()) payload[field.key] = form[field.key];
      }
      await createRecord.mutateAsync(payload as never);
      toast("success", `${config.title} record created`);
      setCreateOpen(false);
      setForm({});
    } catch (err) {
      toast("error", await getApiErrorMessage(err, "Failed to create record"));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-text-muted text-sm max-w-2xl">{config.description}</p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          Add {config.title.replace(/s$/, "")}
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        {isLoading && (
          <div className="px-6 divide-y divide-border/50">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        )}
        {!isLoading && records.length === 0 && (
          <EmptyState
            title={`No ${config.title.toLowerCase()} yet`}
            description={`Upload material to reference it from TLS source fields as managed://${config.collection}/{id}.`}
          />
        )}
        {!isLoading && records.length > 0 && (
          <div className="divide-y divide-border/50">
            {records.map((record) => (
              <div key={record.id} className="px-6 py-3.5 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-text-primary">
                      {record.name || record.id}
                    </span>
                    {expiryBadge(record.not_after)}
                    {record.certificate_count != null && record.certificate_count > 1 && (
                      <Badge variant="blue">{record.certificate_count} certs</Badge>
                    )}
                  </div>
                  <Mono>{record.source_uri}</Mono>
                  {record.subject && (
                    <p className="text-xs text-text-muted mt-0.5 truncate">
                      {record.subject}
                      {record.not_after ? ` · expires ${formatDate(record.not_after)}` : ""}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteTarget(record)}
                >
                  <svg className="w-4 h-4 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogTitle>{`Add ${config.title.replace(/s$/, "")}`}</DialogTitle>
          <div className="space-y-4 mt-4">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="ID"
              value={form.id ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
              placeholder="Auto-generated"
            />
            <Input
              label="Name"
              value={form.name ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Friendly name"
            />
          </div>
          {config.fields.map((field) =>
            field.textarea ? (
              <div key={field.key} className="flex flex-col gap-1.5">
                <span className="text-text-secondary text-sm font-medium">{field.label}</span>
                <textarea
                  value={form[field.key] ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
                  rows={6}
                  placeholder={field.placeholder}
                  className="bg-code-bg border border-border rounded-lg px-3 py-2 text-text-primary text-xs font-mono placeholder:text-text-muted focus:border-orange focus:ring-1 focus:ring-orange/30 resize-y"
                  spellCheck={false}
                />
              </div>
            ) : (
              <Input
                key={field.key}
                label={field.label}
                value={form[field.key] ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
              />
            ),
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} loading={createRecord.isPending}>
              Create
            </Button>
          </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name || deleteTarget?.id}?`}
        description="Records still referenced by TLS configuration cannot be deleted (the gateway returns 409)."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteRecord.mutateAsync(deleteTarget.id);
            toast("success", "Record deleted");
          } catch (err) {
            toast("error", await getApiErrorMessage(err, "Failed to delete record"));
          } finally {
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Inventory tab                                                      */
/* ------------------------------------------------------------------ */

const ROTATE_SURFACES: { value: TlsRotateSurface; label: string }[] = [
  { value: "proxy_https", label: "Proxy HTTPS (frontend)" },
  { value: "backend_tls", label: "Backend TLS" },
  { value: "admin_https", label: "Admin HTTPS" },
  { value: "dtls", label: "Frontend DTLS" },
  { value: "database_tls", label: "Database TLS" },
  { value: "cp_grpc", label: "CP gRPC" },
  { value: "dp_grpc", label: "DP gRPC" },
  { value: "svid", label: "Gateway SVID" },
  { value: "all", label: "All surfaces" },
];

function stateBadge(state: string): ReactNode {
  const variant =
    state === "loaded" ? "green" : state === "invalid" ? "red" : "yellow";
  return <Badge variant={variant}>{state}</Badge>;
}

function InventoryTab() {
  const { toast } = useToast();
  const { data, isLoading } = useTlsInventory({ limit: 200 });
  const rotate = useRotateTlsSurface();
  const [surface, setSurface] = useState<TlsRotateSurface>("proxy_https");

  const entries = data?.data ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Select
              label="Rotate surface"
              value={surface}
              onValueChange={(v) => setSurface(v as TlsRotateSurface)}
              options={ROTATE_SURFACES}
            />
          </div>
          <Button
            size="sm"
            loading={rotate.isPending}
            onClick={async () => {
              try {
                await rotate.mutateAsync(surface);
                toast("success", `Rotation enqueued for ${surface}. Check Events for the outcome.`);
              } catch (err) {
                toast("error", await getApiErrorMessage(err, "Rotation failed"));
              }
            }}
          >
            Rotate Now
          </Button>
          <p className="text-xs text-text-muted flex-1 min-w-48">
            Enqueues an immediate source poll for the surface. Success or failure is
            reported asynchronously on the Events tab.
          </p>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="grid grid-cols-[1.2fr_5rem_5rem_2fr_6rem] gap-4 px-6 py-3 border-b border-border text-text-muted text-xs font-semibold uppercase tracking-wider">
          <span>Material</span>
          <span>Kind</span>
          <span>State</span>
          <span>Source</span>
          <span>Expiry</span>
        </div>
        {isLoading && (
          <div className="px-6 divide-y divide-border/50">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        )}
        {!isLoading && entries.length === 0 && (
          <EmptyState
            title="No TLS material found"
            description="The gateway reports no configured TLS sources."
          />
        )}
        {!isLoading &&
          entries.map((entry) => (
            <div
              key={entry.id}
              className="grid grid-cols-[1.2fr_5rem_5rem_2fr_6rem] gap-4 px-6 py-3 border-b border-border/50 last:border-b-0 items-center"
            >
              <div className="min-w-0">
                <p className="text-sm text-text-primary truncate" title={entry.subject || entry.id}>
                  {entry.subject || entry.id}
                </p>
                {entry.used_by.length > 0 && (
                  <p className="text-xs text-text-muted truncate">
                    used by {entry.used_by.map((u) => u.surface).join(", ")}
                  </p>
                )}
                {entry.error && (
                  <p className="text-xs text-danger truncate" title={entry.error}>{entry.error}</p>
                )}
              </div>
              <span className="text-xs text-text-secondary">{entry.material_kind}</span>
              <span>{stateBadge(entry.state)}</span>
              <Mono>
                {entry.source.kind}: {entry.source.identifier}
              </Mono>
              <span>{expiryBadge(entry.not_after) ?? <span className="text-text-muted text-xs">—</span>}</span>
            </div>
          ))}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Events tab                                                         */
/* ------------------------------------------------------------------ */

function EventsTab() {
  const [outcome, setOutcome] = useState<string>("");
  const { data, isLoading } = useTlsEvents({
    limit: 100,
    ...(outcome && { outcome: outcome as "rotated" | "load_error" | "rebuild_error" }),
  });
  const events = data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="w-56">
        <Select
          label="Outcome"
          value={outcome || "all"}
          onValueChange={(v) => setOutcome(v === "all" ? "" : v)}
          options={[
            { value: "all", label: "All outcomes" },
            { value: "rotated", label: "Rotated" },
            { value: "load_error", label: "Load error" },
            { value: "rebuild_error", label: "Rebuild error" },
          ]}
        />
      </div>
      <Card className="overflow-hidden p-0">
        {isLoading && (
          <div className="px-6 divide-y divide-border/50">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        )}
        {!isLoading && events.length === 0 && (
          <EmptyState
            title="No TLS events"
            description="Rotations and load failures will appear here. No-op polls are not recorded."
          />
        )}
        {!isLoading &&
          events.map((event) => (
            <div key={event.id} className="px-6 py-3 border-b border-border/50 last:border-b-0">
              <div className="flex items-center gap-3 flex-wrap">
                <Badge variant={event.outcome === "rotated" ? "green" : "red"}>
                  {event.outcome}
                </Badge>
                <span className="text-sm text-text-primary font-medium">{event.surface}</span>
                {event.revision != null && (
                  <span className="text-xs text-text-muted">rev {event.revision}</span>
                )}
                <span className="text-xs text-text-muted ml-auto">{formatDate(event.at)}</span>
              </div>
              {event.error && <p className="text-xs text-danger mt-1">{event.error}</p>}
              {event.sources.length > 0 && (
                <p className="text-xs text-text-muted mt-1 truncate">
                  {event.sources.map((s) => `${s.label}: ${s.source_id}`).join(" · ")}
                </p>
              )}
            </div>
          ))}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ACME tab                                                           */
/* ------------------------------------------------------------------ */

function acmeStatusBadge(status: AcmeOrder["status"] | string): ReactNode {
  const variant =
    status === "valid" || status === "issued"
      ? "green"
      : status === "failed" || status === "revoked" || status === "cancelled"
        ? "red"
        : "yellow";
  return <Badge variant={variant}>{status.replace(/_/g, " ")}</Badge>;
}

function AcmeTab() {
  const { toast } = useToast();
  const { data: certs, isLoading: certsLoading } = useAcmeCertificates();
  const { data: orders, isLoading: ordersLoading } = useAcmeOrders();
  const { data: accounts } = useAcmeAccounts();
  const createOrder = useCreateAcmeOrder();
  const deleteOrder = useDeleteAcmeOrder();
  const finalizeOrder = useFinalizeAcmeOrder();
  const renewCert = useRenewAcmeCertificate();
  const deleteCert = useDeleteAcmeCertificate();

  const [orderOpen, setOrderOpen] = useState(false);
  const [orderForm, setOrderForm] = useState({
    domains: "",
    directory_url: "https://acme-v02.api.letsencrypt.org/directory",
    contact: "",
    challenge_type: "http01",
    terms_of_service_agreed: false,
  });

  const handleCreateOrder = async () => {
    const domains = orderForm.domains
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    if (domains.length === 0) {
      toast("error", "At least one domain is required");
      return;
    }
    try {
      await createOrder.mutateAsync({
        domains,
        directory_url: orderForm.directory_url,
        ...(orderForm.contact.trim() && {
          contact: orderForm.contact
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
            .map((c) => (c.startsWith("mailto:") ? c : `mailto:${c}`)),
        }),
        challenge_type: orderForm.challenge_type as "http01" | "tls_alpn01" | "dns01",
        terms_of_service_agreed: orderForm.terms_of_service_agreed,
      });
      toast("success", "ACME order created — challenges are being served");
      setOrderOpen(false);
    } catch (err) {
      toast("error", await getApiErrorMessage(err, "Failed to create order"));
    }
  };

  return (
    <div className="space-y-6">
      {/* Certificates */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">Certificates</h3>
          <Button size="sm" onClick={() => setOrderOpen(true)}>
            New ACME Order
          </Button>
        </div>
        <Card className="overflow-hidden p-0">
          {certsLoading && (
            <div className="px-6 divide-y divide-border/50">
              {Array.from({ length: 2 }).map((_, i) => (
                <SkeletonRow key={i} />
              ))}
            </div>
          )}
          {!certsLoading && (certs?.data ?? []).length === 0 && (
            <EmptyState
              title="No ACME certificates"
              description="Create an order to obtain a certificate, or import issued material."
            />
          )}
          {(certs?.data ?? []).map((cert) => (
            <div key={cert.id} className="px-6 py-3.5 border-b border-border/50 last:border-b-0 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-text-primary">
                    {cert.domains.join(", ")}
                  </span>
                  {acmeStatusBadge(cert.status)}
                  {expiryBadge(cert.not_after)}
                </div>
                <Mono>{cert.source_uri}</Mono>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={renewCert.isPending}
                  onClick={async () => {
                    try {
                      await renewCert.mutateAsync({ id: cert.id, data: { terms_of_service_agreed: true } });
                      toast("success", "Renewal order created");
                    } catch (err) {
                      toast("error", await getApiErrorMessage(err, "Renewal failed"));
                    }
                  }}
                >
                  Renew
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      await deleteCert.mutateAsync(cert.id);
                      toast("success", "Certificate record deleted");
                    } catch (err) {
                      toast("error", await getApiErrorMessage(err, "Delete failed (referenced records return 409)"));
                    }
                  }}
                >
                  <svg className="w-4 h-4 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </Button>
              </div>
            </div>
          ))}
        </Card>
      </div>

      {/* Orders */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Orders</h3>
        <Card className="overflow-hidden p-0">
          {ordersLoading && (
            <div className="px-6 divide-y divide-border/50">
              {Array.from({ length: 2 }).map((_, i) => (
                <SkeletonRow key={i} />
              ))}
            </div>
          )}
          {!ordersLoading && (orders?.data ?? []).length === 0 && (
            <EmptyState
              title="No active orders"
              description="ACME orders and their pending challenges appear here."
            />
          )}
          {(orders?.data ?? []).map((order) => (
            <div key={order.id} className="px-6 py-3.5 border-b border-border/50 last:border-b-0">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-text-primary">
                      {order.domains.join(", ")}
                    </span>
                    {acmeStatusBadge(order.status)}
                  </div>
                  <Mono>{order.id}</Mono>
                  {order.error && <p className="text-xs text-danger mt-1">{order.error}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {(order.status === "ready" ||
                    order.status === "pending_challenges" ||
                    order.status === "processing") && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={finalizeOrder.isPending}
                      onClick={async () => {
                        try {
                          await finalizeOrder.mutateAsync({ id: order.id });
                          toast("success", "Order finalized — certificate stored");
                        } catch (err) {
                          toast("error", await getApiErrorMessage(err, "Finalize failed"));
                        }
                      }}
                    >
                      Finalize
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await deleteOrder.mutateAsync(order.id);
                        toast("success", "Order deleted");
                      } catch (err) {
                        toast("error", await getApiErrorMessage(err, "Delete failed"));
                      }
                    }}
                  >
                    <svg className="w-4 h-4 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </Button>
                </div>
              </div>
              {/* DNS-01 challenge instructions */}
              {(order.dns01_challenges ?? []).map((ch) => (
                <div key={ch.token} className="mt-2 bg-code-bg border border-border rounded-lg p-3">
                  <p className="text-xs text-text-secondary">
                    Publish TXT record{" "}
                    <span className="font-mono text-text-primary">{ch.txt_record_name}</span> ={" "}
                    <span className="font-mono text-text-primary break-all">{ch.txt_value}</span>
                  </p>
                </div>
              ))}
            </div>
          ))}
        </Card>
      </div>

      {/* Accounts */}
      {(accounts?.data ?? []).length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">Accounts</h3>
          <Card className="overflow-hidden p-0">
            {(accounts?.data ?? []).map((account) => (
              <div key={account.account_id} className="px-6 py-3 border-b border-border/50 last:border-b-0 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <Mono>{account.account_id}</Mono>
                  <p className="text-xs text-text-muted mt-0.5">
                    {account.directory_url} · {account.order_count} orders ·{" "}
                    {account.certificate_count} certs
                  </p>
                </div>
                {account.has_persisted_credentials && (
                  <Badge variant="green">credentials stored</Badge>
                )}
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* New order dialog */}
      <Dialog open={orderOpen} onOpenChange={setOrderOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogTitle>New ACME Order</DialogTitle>
          <div className="space-y-4 mt-4">
          <Input
            label="Domains"
            value={orderForm.domains}
            onChange={(e) => setOrderForm((f) => ({ ...f, domains: e.target.value }))}
            placeholder="example.com, www.example.com"
            helpText="Comma-separated domain names"
          />
          <Input
            label="Directory URL"
            value={orderForm.directory_url}
            onChange={(e) => setOrderForm((f) => ({ ...f, directory_url: e.target.value }))}
          />
          <Input
            label="Contact"
            value={orderForm.contact}
            onChange={(e) => setOrderForm((f) => ({ ...f, contact: e.target.value }))}
            placeholder="ops@example.com"
          />
          <Select
            label="Challenge Type"
            value={orderForm.challenge_type}
            onValueChange={(v) => setOrderForm((f) => ({ ...f, challenge_type: v }))}
            options={[
              { value: "http01", label: "HTTP-01 (served automatically)" },
              { value: "tls_alpn01", label: "TLS-ALPN-01 (served in-band)" },
              { value: "dns01", label: "DNS-01 (manual TXT record)" },
            ]}
          />
          <label className="inline-flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={orderForm.terms_of_service_agreed}
              onChange={(e) =>
                setOrderForm((f) => ({ ...f, terms_of_service_agreed: e.target.checked }))
              }
              className="w-4 h-4 rounded border-border bg-bg-input accent-orange cursor-pointer"
            />
            <span className="text-sm text-text-secondary">
              Agree to the CA's terms of service
            </span>
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOrderOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateOrder} loading={createOrder.isPending}>
              Create Order
            </Button>
          </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Validate tab                                                       */
/* ------------------------------------------------------------------ */

function ValidateTab() {
  const { toast } = useToast();
  const validateMaterial = useValidateTlsMaterial();
  const [certPem, setCertPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const [caPem, setCaPem] = useState("");
  const [result, setResult] = useState<{ valid: boolean; validated: Record<string, unknown> } | null>(null);

  return (
    <div className="space-y-4 max-w-3xl">
      <p className="text-text-muted text-sm">
        Validate PEM material without persisting anything — cert/key match, chain
        integrity, and expiry are checked by the gateway.
      </p>
      {(
        [
          ["Certificate (PEM)", certPem, setCertPem],
          ["Private Key (PEM)", keyPem, setKeyPem],
          ["CA Bundle (PEM)", caPem, setCaPem],
        ] as const
      ).map(([label, value, setter]) => (
        <div key={label} className="flex flex-col gap-1.5">
          <span className="text-text-secondary text-sm font-medium">{label}</span>
          <textarea
            value={value}
            onChange={(e) => setter(e.target.value)}
            rows={5}
            className="bg-code-bg border border-border rounded-lg px-3 py-2 text-text-primary text-xs font-mono placeholder:text-text-muted focus:border-orange focus:ring-1 focus:ring-orange/30 resize-y"
            spellCheck={false}
          />
        </div>
      ))}
      <Button
        loading={validateMaterial.isPending}
        onClick={async () => {
          setResult(null);
          try {
            const res = await validateMaterial.mutateAsync({
              ...(certPem.trim() && { cert_pem: certPem }),
              ...(keyPem.trim() && { key_pem: keyPem }),
              ...(caPem.trim() && { ca_bundle_pem: caPem }),
            });
            setResult(res);
          } catch (err) {
            toast("error", await getApiErrorMessage(err, "Validation request failed"));
          }
        }}
      >
        Validate
      </Button>
      {result && (
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <Badge variant={result.valid ? "green" : "red"} className="px-3 py-1">
              {result.valid ? "VALID" : "INVALID"}
            </Badge>
          </div>
          <pre className="text-xs font-mono text-text-secondary bg-code-bg rounded-lg p-3 overflow-x-auto">
            {JSON.stringify(result.validated, null, 2)}
          </pre>
        </Card>
      )}
    </div>
  );
}

/* ================================================================== */
/*  TlsPage                                                            */
/* ================================================================== */

export default function TlsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">TLS Management</h1>
        <p className="text-text-muted text-sm mt-1">
          Inventory, managed certificate stores, ACME automation, rotation, and
          validation for every TLS surface of the gateway.
        </p>
      </div>

      <Tabs defaultValue="inventory">
        <TabsList>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          {MANAGED_TABS.map((tab) => (
            <TabsTrigger key={tab.collection} value={tab.collection}>
              {tab.title}
            </TabsTrigger>
          ))}
          <TabsTrigger value="acme">ACME</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="validate">Validate</TabsTrigger>
        </TabsList>

        <TabsContent value="inventory">
          <InventoryTab />
        </TabsContent>
        {MANAGED_TABS.map((tab) => (
          <TabsContent key={tab.collection} value={tab.collection}>
            <ManagedRecordsTab config={tab} />
          </TabsContent>
        ))}
        <TabsContent value="acme">
          <AcmeTab />
        </TabsContent>
        <TabsContent value="events">
          <EventsTab />
        </TabsContent>
        <TabsContent value="validate">
          <ValidateTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
