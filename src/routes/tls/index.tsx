/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TLS management page                               */
/*  Inventory, managed material stores, ACME automation, events,      */
/*  surface rotation, and material validation.                        */
/* ------------------------------------------------------------------ */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/Dialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { PaginationControls } from "@/components/shared/PaginationControls";
import { useToast } from "@/components/ui/Toast";
import { getApiErrorMessage } from "@/api/client";
import {
  useTlsInventory,
  useTlsEvents,
  useAllManagedTlsRecords,
  useCreateManagedTlsRecord,
  useDeleteManagedTlsRecord,
  useAllAcmeCertificates,
  useAllAcmeOrders,
  useAllAcmeAccounts,
  useAcmeCertificate,
  useImportAcmeCertificate,
  useUpdateAcmeCertificate,
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
  AcmeCertificateRecord,
} from "@/api/tls";
import { usePaginationParams } from "@/hooks/usePagination";
import {
  acmeCertificateToForm,
  buildAcmeCertificateRequest,
  EMPTY_ACME_CERTIFICATE_FORM,
  AcmeCertificateFormError,
  type AcmeCertificateFormState,
} from "@/lib/acmeCertificateForm";

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
  const { data, isLoading } = useAllManagedTlsRecords(config.collection);
  const createRecord = useCreateManagedTlsRecord(config.collection);
  const deleteRecord = useDeleteManagedTlsRecord(config.collection);

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ManagedTlsRecord | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});

  const records = data ?? [];

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
        description="This is a fleet-global record shared by every namespace. Records still referenced by TLS configuration cannot be deleted (the gateway returns 409)."
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
  const pagination = usePaginationParams({ defaultLimit: 50 });
  const { data, isLoading } = useTlsInventory(pagination.paginationParams);
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
      {(data?.pagination.total ?? 0) > 0 && (
        <PaginationControls
          offset={pagination.offset}
          limit={pagination.limit}
          total={data?.pagination.total ?? 0}
          onChange={pagination.setParams}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Events tab                                                         */
/* ------------------------------------------------------------------ */

function EventsTab() {
  const [outcome, setOutcome] = useState<string>("");
  const pagination = usePaginationParams({ defaultLimit: 50 });
  const { data, isLoading } = useTlsEvents({
    ...pagination.paginationParams,
    ...(outcome && { outcome: outcome as "rotated" | "load_error" | "rebuild_error" }),
  });
  const events = data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="w-56">
        <Select
          label="Outcome"
          value={outcome || "all"}
          onValueChange={(v) => {
            setOutcome(v === "all" ? "" : v);
            pagination.setParams({ offset: 0, limit: pagination.limit });
          }}
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
      {(data?.pagination.total ?? 0) > 0 && (
        <PaginationControls
          offset={pagination.offset}
          limit={pagination.limit}
          total={data?.pagination.total ?? 0}
          onChange={pagination.setParams}
        />
      )}
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

const ACME_PAGE_SIZE = 20;
const EMPTY_ACME_ORDER_FORM = {
  domains: "",
  directory_url: "https://acme-v02.api.letsencrypt.org/directory",
  contact: "",
  challenge_type: "http01",
  terms_of_service_agreed: false,
};

interface AcmeCertificateEditor {
  mode: "import" | "replace";
  target: AcmeCertificateRecord | null;
}

function AcmeTab() {
  const { toast } = useToast();
  const { data: certs, isLoading: certsLoading } = useAllAcmeCertificates();
  const { data: orders, isLoading: ordersLoading } = useAllAcmeOrders();
  const { data: accounts } = useAllAcmeAccounts();
  const importCert = useImportAcmeCertificate();
  const updateCert = useUpdateAcmeCertificate();
  const createOrder = useCreateAcmeOrder();
  const deleteOrder = useDeleteAcmeOrder();
  const finalizeOrder = useFinalizeAcmeOrder();
  const renewCert = useRenewAcmeCertificate();
  const deleteCert = useDeleteAcmeCertificate();

  const [orderOpen, setOrderOpen] = useState(false);
  const [orderForm, setOrderForm] = useState(EMPTY_ACME_ORDER_FORM);
  const [certificateEditor, setCertificateEditor] =
    useState<AcmeCertificateEditor | null>(null);
  const [certificateForm, setCertificateForm] =
    useState<AcmeCertificateFormState>(EMPTY_ACME_CERTIFICATE_FORM);
  const [detailId, setDetailId] = useState("");
  const detailQuery = useAcmeCertificate(detailId);
  const [deleteCertificateTarget, setDeleteCertificateTarget] =
    useState<AcmeCertificateRecord | null>(null);
  const [deleteOrderTarget, setDeleteOrderTarget] = useState<AcmeOrder | null>(null);
  const [certificateOffset, setCertificateOffset] = useState(0);
  const [orderOffset, setOrderOffset] = useState(0);
  const pendingKeysRef = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set());

  const closeCertificateEditor = () => {
    setCertificateEditor(null);
    setCertificateForm(EMPTY_ACME_CERTIFICATE_FORM);
  };

  useEffect(() => {
    const certificateTotal = certs?.length ?? 0;
    if (certificateOffset > 0 && certificateOffset >= certificateTotal) {
      setCertificateOffset(Math.max(0, Math.floor((certificateTotal - 1) / ACME_PAGE_SIZE) * ACME_PAGE_SIZE));
    }
  }, [certificateOffset, certs?.length]);

  useEffect(() => {
    const orderTotal = orders?.length ?? 0;
    if (orderOffset > 0 && orderOffset >= orderTotal) {
      setOrderOffset(Math.max(0, Math.floor((orderTotal - 1) / ACME_PAGE_SIZE) * ACME_PAGE_SIZE));
    }
  }, [orderOffset, orders?.length]);

  const runRowAction = async (key: string, action: () => Promise<void>) => {
    if (pendingKeysRef.current.has(key)) return;
    pendingKeysRef.current.add(key);
    setPendingKeys(new Set(pendingKeysRef.current));
    try {
      await action();
    } finally {
      pendingKeysRef.current.delete(key);
      setPendingKeys(new Set(pendingKeysRef.current));
    }
  };

  const openCertificateImport = () => {
    setCertificateForm(EMPTY_ACME_CERTIFICATE_FORM);
    setCertificateEditor({ mode: "import", target: null });
  };

  const openCertificateReplace = (target: AcmeCertificateRecord) => {
    setCertificateForm(acmeCertificateToForm(target));
    setCertificateEditor({ mode: "replace", target });
  };

  const saveCertificate = async () => {
    if (!certificateEditor) return;
    try {
      const data = {
        ...buildAcmeCertificateRequest(certificateForm),
        // Import never overwrites an existing record. Existing material must
        // be replaced through the explicit per-record Replace workflow.
        allow_overwrite: certificateEditor.mode === "replace",
      };
      if (certificateEditor.mode === "import") {
        await importCert.mutateAsync(data);
      } else if (certificateEditor.target) {
        await updateCert.mutateAsync({
          id: certificateEditor.target.id,
          data,
        });
      }
      toast(
        "success",
        certificateEditor.mode === "import"
          ? "ACME certificate imported"
          : "ACME certificate material replaced",
      );
      closeCertificateEditor();
    } catch (error) {
      if (error instanceof AcmeCertificateFormError) {
        toast("error", error.message);
        return;
      }
      toast("error", await getApiErrorMessage(error, "Certificate save failed"));
    }
  };

  const visibleCertificates = (certs ?? []).slice(
    certificateOffset,
    certificateOffset + ACME_PAGE_SIZE,
  );
  const visibleOrders = (orders ?? []).slice(orderOffset, orderOffset + ACME_PAGE_SIZE);

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
      setOrderForm(EMPTY_ACME_ORDER_FORM);
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
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={openCertificateImport}>
              Import Certificate
            </Button>
            <Button size="sm" onClick={() => setOrderOpen(true)}>
              New ACME Order
            </Button>
          </div>
        </div>
        <Card className="overflow-hidden p-0">
          {certsLoading && (
            <div className="px-6 divide-y divide-border/50">
              {Array.from({ length: 2 }).map((_, i) => (
                <SkeletonRow key={i} />
              ))}
            </div>
          )}
          {!certsLoading && (certs ?? []).length === 0 && (
            <EmptyState
              title="No ACME certificates"
              description="Create an order to obtain a certificate, or import issued material."
            />
          )}
          {visibleCertificates.map((cert) => (
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
                  variant="ghost"
                  size="sm"
                  onClick={() => setDetailId(cert.id)}
                >
                  View
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openCertificateReplace(cert)}
                >
                  Replace
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={pendingKeys.has(`renew:${cert.id}`)}
                  onClick={() =>
                    void runRowAction(`renew:${cert.id}`, async () => {
                      try {
                        await renewCert.mutateAsync({
                          id: cert.id,
                          data: { terms_of_service_agreed: true },
                        });
                        toast("success", `Renewal order created for ${cert.domains.join(", ")}`);
                      } catch (err) {
                        toast("error", await getApiErrorMessage(err, "Renewal failed"));
                      }
                    })
                  }
                >
                  Renew
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteCertificateTarget(cert)}
                  disabled={pendingKeys.has(`delete-cert:${cert.id}`)}
                  aria-label={`Delete certificate for ${cert.domains.join(", ")}`}
                >
                  <svg className="w-4 h-4 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </Button>
              </div>
            </div>
          ))}
        </Card>
        {(certs?.length ?? 0) > 0 && (
          <PaginationControls
            offset={certificateOffset}
            limit={ACME_PAGE_SIZE}
            total={certs?.length ?? 0}
            onChange={({ offset }) => setCertificateOffset(offset)}
          />
        )}
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
          {!ordersLoading && (orders ?? []).length === 0 && (
            <EmptyState
              title="No active orders"
              description="ACME orders and their pending challenges appear here."
            />
          )}
          {visibleOrders.map((order) => (
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
                      loading={pendingKeys.has(`finalize:${order.id}`)}
                      onClick={() =>
                        void runRowAction(`finalize:${order.id}`, async () => {
                          try {
                            await finalizeOrder.mutateAsync({ id: order.id });
                            toast("success", `Order finalized for ${order.domains.join(", ")}`);
                          } catch (err) {
                            toast("error", await getApiErrorMessage(err, "Finalize failed"));
                          }
                        })
                      }
                    >
                      Finalize
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteOrderTarget(order)}
                    disabled={pendingKeys.has(`delete-order:${order.id}`)}
                    aria-label={`Delete ${order.status} order for ${order.domains.join(", ")}`}
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
        {(orders?.length ?? 0) > 0 && (
          <PaginationControls
            offset={orderOffset}
            limit={ACME_PAGE_SIZE}
            total={orders?.length ?? 0}
            onChange={({ offset }) => setOrderOffset(offset)}
          />
        )}
      </div>

      {/* Accounts */}
      {(accounts ?? []).length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">Accounts</h3>
          <Card className="overflow-hidden p-0">
            {(accounts ?? []).map((account) => (
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

      {/* Import / replace certificate material. Private key bytes are kept
          only in this component state and cleared whenever the dialog closes. */}
      <Dialog
        open={!!certificateEditor}
        onOpenChange={(open) => !open && closeCertificateEditor()}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogTitle>
            {certificateEditor?.mode === "replace"
              ? `Replace certificate ${certificateEditor.target?.id ?? ""}`
              : "Import ACME certificate"}
          </DialogTitle>
          <DialogDescription className="mt-2">
            This certificate store is fleet-global: replacing material can affect TLS
            listeners in every namespace. Private keys are sent only to Ferrum Edge,
            are never returned by its API, and are cleared from this form on close.
          </DialogDescription>
          <div className="space-y-4 mt-5">
            <div className="grid sm:grid-cols-2 gap-3">
              <Input
                label="Certificate ID"
                value={certificateForm.id}
                disabled={certificateEditor?.mode === "replace"}
                onChange={(event) =>
                  setCertificateForm((current) => ({ ...current, id: event.target.value }))
                }
                placeholder="Generated when omitted"
                autoComplete="off"
              />
              <Input
                label="Expiry warning days"
                type="number"
                min={0}
                step={1}
                value={certificateForm.expiryWarningDays}
                onChange={(event) =>
                  setCertificateForm((current) => ({
                    ...current,
                    expiryWarningDays: event.target.value,
                  }))
                }
              />
            </div>
            <Input
              label="Domains"
              value={certificateForm.domains}
              onChange={(event) =>
                setCertificateForm((current) => ({ ...current, domains: event.target.value }))
              }
              placeholder="example.com, www.example.com"
              helpText="Comma-separated DNS identifiers covered by the certificate"
              autoComplete="off"
            />
            <Input
              label="ACME directory URL"
              value={certificateForm.directoryUrl}
              onChange={(event) =>
                setCertificateForm((current) => ({ ...current, directoryUrl: event.target.value }))
              }
              autoComplete="off"
            />
            <div className="grid sm:grid-cols-2 gap-3">
              <Input
                label="Account ID / URL"
                value={certificateForm.accountId}
                onChange={(event) =>
                  setCertificateForm((current) => ({ ...current, accountId: event.target.value }))
                }
                autoComplete="off"
              />
              <Input
                label="Order URL"
                value={certificateForm.orderUrl}
                onChange={(event) =>
                  setCertificateForm((current) => ({ ...current, orderUrl: event.target.value }))
                }
                autoComplete="off"
              />
            </div>
            {(
              [
                ["Leaf certificate PEM", "certPem", certificateForm.certPem, 8],
                ["Private key PEM", "keyPem", certificateForm.keyPem, 8],
                ["Intermediate chain PEM (optional)", "chainPem", certificateForm.chainPem, 6],
              ] as const
            ).map(([label, key, value, rows]) => (
              <label key={key} className="flex flex-col gap-1.5">
                <span className="text-text-secondary text-sm font-medium">{label}</span>
                <textarea
                  value={value}
                  onChange={(event) =>
                    setCertificateForm((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))
                  }
                  rows={rows}
                  className="bg-code-bg border border-border rounded-lg px-3 py-2 text-text-primary text-xs font-mono focus:border-orange focus:ring-1 focus:ring-orange/30 resize-y"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
            ))}
            <div className="flex flex-wrap gap-5">
              <label className="inline-flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={certificateForm.allowExpired}
                  onChange={(event) =>
                    setCertificateForm((current) => ({
                      ...current,
                      allowExpired: event.target.checked,
                    }))
                  }
                  className="accent-orange"
                />
                Allow expired certificate
              </label>
            </div>
            {certificateEditor?.mode === "replace" && (
              <p className="text-xs text-warning">
                Ferrum never returns the existing private key. A complete new certificate,
                matching private key, and any required chain must be supplied for replacement.
              </p>
            )}
            {certificateEditor?.mode === "import" && (
              <p className="text-xs text-text-muted">
                Import cannot overwrite an existing certificate ID. Use the explicit
                Replace action on that record so the affected domains are visible.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeCertificateEditor}>Cancel</Button>
              <Button
                onClick={() => void saveCertificate()}
                loading={importCert.isPending || updateCert.isPending}
              >
                {certificateEditor?.mode === "replace" ? "Replace material" : "Import certificate"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(detailId)} onOpenChange={(open) => !open && setDetailId("")}>
        <DialogContent>
          <DialogTitle>ACME certificate detail</DialogTitle>
          {detailQuery.isLoading && <p className="mt-4 text-sm text-text-muted">Loading…</p>}
          {detailQuery.isError && (
            <p className="mt-4 text-sm text-danger">Certificate detail could not be loaded.</p>
          )}
          {detailQuery.data && (
            <div className="mt-4 space-y-2 text-sm text-text-secondary">
              <p><span className="text-text-muted">ID:</span> <span className="font-mono">{detailQuery.data.id}</span></p>
              <p><span className="text-text-muted">Domains:</span> {detailQuery.data.domains.join(", ")}</p>
              <p><span className="text-text-muted">Status:</span> {detailQuery.data.status}</p>
              <p><span className="text-text-muted">Directory:</span> <span className="font-mono break-all">{detailQuery.data.directory_url}</span></p>
              <p><span className="text-text-muted">Subject:</span> {detailQuery.data.subject ?? "—"}</p>
              <p><span className="text-text-muted">Issuer:</span> {detailQuery.data.issuer ?? "—"}</p>
              <p><span className="text-text-muted">Valid:</span> {formatDate(detailQuery.data.not_before)} – {formatDate(detailQuery.data.not_after)}</p>
              <p><span className="text-text-muted">Fingerprint:</span> <span className="font-mono break-all">{detailQuery.data.fingerprint_sha256 ?? "—"}</span></p>
              <p className="text-xs text-text-muted">
                Private-key material is intentionally absent from all detail responses.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteCertificateTarget}
        onOpenChange={(open) => !open && setDeleteCertificateTarget(null)}
        title={`Delete certificate for ${deleteCertificateTarget?.domains.join(", ") ?? "these domains"}?`}
        description={`This permanently removes fleet-global certificate record "${deleteCertificateTarget?.id ?? ""}" and may affect TLS listeners in every namespace. TLS configurations that reference it prevent deletion with 409; Foundry will preserve the row and show that server error.`}
        confirmLabel="Delete Certificate"
        loading={Boolean(
          deleteCertificateTarget &&
            pendingKeys.has(`delete-cert:${deleteCertificateTarget.id}`),
        )}
        onConfirm={() => {
          if (!deleteCertificateTarget) return;
          const target = deleteCertificateTarget;
          void runRowAction(`delete-cert:${target.id}`, async () => {
            try {
              await deleteCert.mutateAsync(target.id);
              toast("success", `Certificate ${target.id} deleted`);
              setDeleteCertificateTarget(null);
            } catch (error) {
              toast(
                "error",
                await getApiErrorMessage(
                  error,
                  "Delete failed; remove certificate references before retrying",
                ),
              );
            }
          });
        }}
      />

      <ConfirmDialog
        open={!!deleteOrderTarget}
        onOpenChange={(open) => !open && setDeleteOrderTarget(null)}
        title={`Delete ${deleteOrderTarget?.status.replace(/_/g, " ") ?? "ACME"} order?`}
        description={`Fleet-global order "${deleteOrderTarget?.id ?? ""}" covers ${deleteOrderTarget?.domains.join(", ") ?? "the selected domains"}. Deleting an active order cancels/removes the challenge workflow for every namespace and cannot be undone.`}
        confirmLabel="Delete Order"
        loading={Boolean(
          deleteOrderTarget && pendingKeys.has(`delete-order:${deleteOrderTarget.id}`),
        )}
        onConfirm={() => {
          if (!deleteOrderTarget) return;
          const target = deleteOrderTarget;
          void runRowAction(`delete-order:${target.id}`, async () => {
            try {
              await deleteOrder.mutateAsync(target.id);
              toast("success", `Order ${target.id} deleted`);
              setDeleteOrderTarget(null);
            } catch (error) {
              toast("error", await getApiErrorMessage(error, "Order delete failed"));
            }
          });
        }}
      />

      {/* New order dialog */}
      <Dialog
        open={orderOpen}
        onOpenChange={(open) => {
          setOrderOpen(open);
          if (!open) setOrderForm(EMPTY_ACME_ORDER_FORM);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogTitle>New ACME Order</DialogTitle>
          <DialogDescription className="mt-2">
            ACME orders and issued certificate material are fleet-global and can be used
            by TLS listeners in every namespace.
          </DialogDescription>
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
            <Button
              variant="secondary"
              onClick={() => {
                setOrderOpen(false);
                setOrderForm(EMPTY_ACME_ORDER_FORM);
              }}
            >
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

      <div
        role="note"
        className="rounded-lg border border-warning/40 bg-warning/5 px-4 py-3"
      >
        <p className="text-sm font-semibold text-warning">Fleet-global TLS surface</p>
        <p className="text-xs text-text-secondary mt-1">
          Ferrum does not namespace-filter TLS inventory, managed material, ACME,
          rotation, or validation. The namespace selector does not scope these operations;
          mutations can affect every namespace and are audited under the canonical
          <span className="font-mono"> ferrum </span>namespace.
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
