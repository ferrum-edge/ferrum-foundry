/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for TLS management          */
/* ------------------------------------------------------------------ */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as tls from "@/api/tls";
import type { PaginationParams } from "@/api/types";
import { useNamespace } from "@/stores/namespace";

export function useTlsInventory(params: PaginationParams = {}) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["tls", "inventory", ns, params],
    queryFn: () => tls.listInventory(params),
  });
}

export function useTlsEvents(params: tls.TlsEventsParams = {}) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["tls", "events", ns, params],
    queryFn: () => tls.listEvents(params),
  });
}

export function useManagedTlsRecords(
  collection: tls.ManagedTlsCollection,
  params: PaginationParams = {},
) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["tls", "managed", collection, ns, params],
    queryFn: () => tls.listManagedRecords(collection, params),
  });
}

export function useAllManagedTlsRecords(collection: tls.ManagedTlsCollection) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["tls", "managed", collection, ns, "all"],
    queryFn: () => tls.listAllManagedRecords(collection),
  });
}

export function useCreateManagedTlsRecord(collection: tls.ManagedTlsCollection) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: tls.ManagedTlsRequest) =>
      tls.createManagedRecord(collection, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tls"] });
    },
  });
}

export function useUpdateManagedTlsRecord(collection: tls.ManagedTlsCollection) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: tls.ManagedTlsRequest }) =>
      tls.updateManagedRecord(collection, id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tls"] });
    },
  });
}

export function useDeleteManagedTlsRecord(collection: tls.ManagedTlsCollection) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tls.removeManagedRecord(collection, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tls"] });
    },
  });
}

/* ---------- ACME ---------- */

export function useAcmeCertificates(params: PaginationParams = {}) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["tls", "acme", "certificates", ns, params],
    queryFn: () => tls.listAcmeCertificates(params),
  });
}

export function useAllAcmeCertificates() {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["tls", "acme", "certificates", ns, "all"],
    queryFn: () => tls.listAllAcmeCertificates(),
  });
}

export function useAcmeOrders(params: PaginationParams = {}) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["tls", "acme", "orders", ns, params],
    queryFn: () => tls.listAcmeOrders(params),
    refetchInterval: 15000,
  });
}

export function useAllAcmeOrders() {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["tls", "acme", "orders", ns, "all"],
    queryFn: () => tls.listAllAcmeOrders(),
    refetchInterval: 15000,
  });
}

export function useAcmeAccounts(params: PaginationParams = {}) {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["tls", "acme", "accounts", ns, params],
    queryFn: () => tls.listAcmeAccounts(params),
  });
}

export function useAllAcmeAccounts() {
  const { selectedNamespace: ns } = useNamespace();
  return useQuery({
    queryKey: ["tls", "acme", "accounts", ns, "all"],
    queryFn: () => tls.listAllAcmeAccounts(),
  });
}

export function useCreateAcmeOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: tls.AcmeOrderRequest) => tls.createAcmeOrder(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tls", "acme"] });
    },
  });
}

export function useDeleteAcmeOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tls.removeAcmeOrder(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tls", "acme"] });
    },
  });
}

export function useFinalizeAcmeOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data?: tls.AcmeOrderFinalizeRequest;
    }) => tls.finalizeAcmeOrder(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tls"] });
    },
  });
}

export function useRenewAcmeCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data?: tls.AcmeRenewRequest }) =>
      tls.renewAcmeCertificate(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tls", "acme"] });
    },
  });
}

export function useDeleteAcmeCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tls.removeAcmeCertificate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tls", "acme"] });
    },
  });
}

/* ---------- Rotate / validate ---------- */

export function useRotateTlsSurface() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (surface: tls.TlsRotateSurface) => tls.rotateSurface(surface),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tls", "events"] });
    },
  });
}

export function useValidateTlsMaterial() {
  return useMutation({
    mutationFn: (data: tls.TlsValidateRequest) => tls.validateMaterial(data),
  });
}
