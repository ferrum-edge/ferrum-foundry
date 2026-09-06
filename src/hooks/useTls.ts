/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – TanStack Query hooks for TLS management          */
/* ------------------------------------------------------------------ */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QUERY_ERROR_CONTEXT } from "@/api/client";
import * as tls from "@/api/tls";
import type { PaginationParams } from "@/api/types";

export function useTlsInventory(params: PaginationParams = {}) {
  return useQuery({
    queryKey: ["tls", "inventory", params],
    queryFn: () => tls.listInventory(params, QUERY_ERROR_CONTEXT),
  });
}

export function useTlsEvents(params: tls.TlsEventsParams = {}) {
  return useQuery({
    queryKey: ["tls", "events", params],
    queryFn: () => tls.listEvents(params, QUERY_ERROR_CONTEXT),
  });
}

export function useManagedTlsRecords(
  collection: tls.ManagedTlsCollection,
  params: PaginationParams = {},
) {
  return useQuery({
    queryKey: ["tls", "managed", collection, params],
    queryFn: () => tls.listManagedRecords(collection, params, QUERY_ERROR_CONTEXT),
  });
}

export function useAllManagedTlsRecords(collection: tls.ManagedTlsCollection) {
  return useQuery({
    queryKey: ["tls", "managed", collection, "all"],
    queryFn: () => tls.listAllManagedRecords(collection, QUERY_ERROR_CONTEXT),
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
  return useQuery({
    queryKey: ["tls", "acme", "certificates", params],
    queryFn: () => tls.listAcmeCertificates(params, QUERY_ERROR_CONTEXT),
  });
}

export function useAllAcmeCertificates() {
  return useQuery({
    queryKey: ["tls", "acme", "certificates", "all"],
    queryFn: () => tls.listAllAcmeCertificates(QUERY_ERROR_CONTEXT),
  });
}

export function useAcmeCertificate(id: string) {
  return useQuery({
    queryKey: ["tls", "acme", "certificate", id],
    queryFn: () => tls.getAcmeCertificate(id, QUERY_ERROR_CONTEXT),
    enabled: Boolean(id),
  });
}

export function useImportAcmeCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: tls.AcmeCertificateRequest) => tls.createAcmeCertificate(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tls", "acme", "certificates"] });
    },
  });
}

export function useUpdateAcmeCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: tls.AcmeCertificateRequest;
    }) => tls.updateAcmeCertificate(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tls", "acme", "certificates"] });
      qc.invalidateQueries({ queryKey: ["tls", "acme", "certificate"], exact: false });
    },
  });
}

export function useAcmeOrders(params: PaginationParams = {}) {
  return useQuery({
    queryKey: ["tls", "acme", "orders", params],
    queryFn: () => tls.listAcmeOrders(params, QUERY_ERROR_CONTEXT),
    refetchInterval: 15000,
  });
}

export function useAllAcmeOrders() {
  return useQuery({
    queryKey: ["tls", "acme", "orders", "all"],
    queryFn: () => tls.listAllAcmeOrders(QUERY_ERROR_CONTEXT),
    refetchInterval: 15000,
  });
}

export function useAcmeAccounts(params: PaginationParams = {}) {
  return useQuery({
    queryKey: ["tls", "acme", "accounts", params],
    queryFn: () => tls.listAcmeAccounts(params, QUERY_ERROR_CONTEXT),
  });
}

export function useAllAcmeAccounts() {
  return useQuery({
    queryKey: ["tls", "acme", "accounts", "all"],
    queryFn: () => tls.listAllAcmeAccounts(QUERY_ERROR_CONTEXT),
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
    retry: false,
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
