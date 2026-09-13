import { act } from "react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcmeAccount, AcmeCertificateRecord, AcmeCertificateRequest, AcmeOrder, AcmeOrderRequest,
  ManagedTlsRecord, TlsInventoryEntry, TlsSourceEvent, TlsValidateRequest,
} from "@/api/tls";
import { setApiErrorHandler } from "@/api/client";
import { inputByLabel } from "@/test/fields";
import {
  BasedRequest, button, click, createHarness, fill, page, panel, selectOption, selectTab, settle,
} from "@/test/__tests__/harness";
import TlsPage from "./index";

const at = "2026-09-01T00:00:00Z";
// Deliberately invalid cryptographic material: these fixtures only exercise
// form serialization. The mocked gateway owns material validation results.
const certPem = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
const keyPem = "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----";
const record: ManagedTlsRecord = {
  id: "edge-cert", name: "Edge Certificate", kind: "certificate",
  source_uri: "managed://certificates/edge-cert", subject: "CN=api.example.test",
  not_after: "2026-11-01T00:00:00Z", certificate_count: 2, created_at: at, updated_at: at,
};
const certificate: AcmeCertificateRecord = {
  id: "acme-edge", domains: ["edge.example.test"], status: "issued",
  directory_url: "https://ca.example.test/directory", source_uri: "acme://certificates/acme-edge",
  subject: "CN=edge.example.test", issuer: "Example CA", not_before: at,
  not_after: "2026-09-22T00:00:00Z", fingerprint_sha256: "fixture-fingerprint",
  created_at: at, updated_at: at,
};
const order: AcmeOrder = {
  id: "order-edge", domains: ["edge.example.test"], status: "ready",
  directory_url: "https://ca.example.test/directory", created_at: at, updated_at: at,
  dns01_challenges: [{
    identifier: "edge.example.test", token: "fixture", txt_record_name: "_acme-challenge.edge.example.test",
    txt_value: "fixture-dns-value",
  }],
};
const account: AcmeAccount = {
  account_id: "account-edge", directory_url: "https://ca.example.test/directory",
  order_count: 1, certificate_count: 1, has_persisted_credentials: true,
};

let ui: ReturnType<typeof createHarness>;
let collections: Record<string, unknown[]>;
let requests: Request[];
let readStatus: number | undefined;
const mutate = vi.fn<(request: Request) => Promise<Response>>();
const popup = vi.fn();

beforeEach(() => {
  ui = createHarness();
  collections = {
    inventory: [], events: [], certificates: [], "ca-bundles": [], crls: [], "ocsp-responses": [], jwks: [],
    "acme/certificates": [], "acme/orders": [], "acme/accounts": [],
  };
  requests = [];
  readStatus = undefined;
  mutate.mockReset();
  mutate.mockImplementation(async () => { throw new Error("Unexpected TLS mutation"); });
  popup.mockClear();
  setApiErrorHandler(popup);
  localStorage.setItem("ferrum:namespace", "tenant-a");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push(request);
    if (request.method !== "GET") return mutate(request);
    if (readStatus) return Response.json({ error: "TLS unavailable" }, { status: readStatus, headers: { "retry-after": "0" } });
    const path = new URL(request.url).pathname.replace("/api/proxy/admin/tls/", "");
    if (path === "acme/certificates/acme-edge") return Response.json(certificate);
    if (!(path in collections)) throw new Error(`Unexpected TLS read: ${path}`);
    return Response.json(page(collections[path]));
  }));
});

afterEach(async () => {
  await ui.dispose();
  setApiErrorHandler(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function mount(tab = "Inventory") {
  const parent = createRootRoute();
  const route = createRoute({ getParentRoute: () => parent, path: "/tls", component: TlsPage });
  const router = createRouter({
    routeTree: parent.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/tls"] }),
  });
  await router.load();
  await ui.render(<RouterProvider router={router} />);
  if (tab !== "Inventory") await selectTab(tab);
}

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(element).not.toBeNull();
  return element!;
}

function writes() {
  return requests.filter((request) => request.method !== "GET");
}

describe("TLS inventory and events", () => {
  it("renders loaded, invalid, unavailable and expiring inventory with source and usage", async () => {
    const entries: TlsInventoryEntry[] = [
      { id: "loaded", material_kind: "certificate", state: "loaded", subject: "CN=api.example.test",
        source: { kind: "managed", identifier: record.source_uri, refreshable: true },
        used_by: [{ surface: "proxy_https", role: "server", resource_type: "proxy", resource_id: "orders", field: "tls" }],
        not_after: "2026-11-01T00:00:00Z" },
      { id: "expired", material_kind: "certificate", state: "invalid", used_by: [],
        source: { kind: "file", identifier: "expired.pem", refreshable: true },
        error: "certificate expired", not_after: "2026-08-01T00:00:00Z" },
      { id: "soon", material_kind: "certificate", state: "loaded", used_by: [],
        source: { kind: "managed", identifier: "soon", refreshable: true }, not_after: "2026-09-08T00:00:00Z" },
      { id: "missing", material_kind: "private_key", state: "unavailable", used_by: [],
        source: { kind: "file", identifier: "missing.pem", refreshable: false } },
    ];
    collections.inventory = entries;
    await mount();
    await settle(() => expect(panel().textContent).toContain("CN=api.example.test"));
    for (const label of ["used by proxy_https", "managed://certificates/edge-cert", "expired",
      "certificate expired", "7d left", "61d left", "missing.pem", "unavailable"]) {
      expect(panel().textContent).toContain(label);
    }
    expect(ui.host.textContent).toContain("Fleet-global TLS surface");
    expect(requests.every((request) => !request.headers.has("X-Ferrum-Namespace"))).toBe(true);
  });

  it.each([undefined, 404, 503])("renders empty stores after an empty or unavailable response (%s)", async (status) => {
    readStatus = status;
    await mount();
    await settle(() => expect(panel().textContent).toContain("No TLS material found"));
    for (const [tab, message] of [
      ["Certificates", "No certificates yet"], ["CA Bundles", "No CA bundles yet"],
      ["CRLs", "No CRLs yet"], ["OCSP", "No OCSP responses yet"], ["JWKS", "No JWKS documents yet"],
      ["ACME", "No ACME certificates"], ["Events", "No TLS events"],
    ]) {
      await selectTab(tab);
      await settle(() => expect(panel().textContent).toContain(message));
    }
    expect(writes()).toHaveLength(0);
    expect(requests.every((request) => !request.headers.has("X-Ferrum-Namespace"))).toBe(true);
  });

  it("rotates the selected surface and reports acceptance and failure", async () => {
    mutate.mockResolvedValueOnce(Response.json({ accepted: true, requested_surface: "backend_tls" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ error: "surface not configured" }, { status: 400 }));
    await mount();
    await selectOption("Rotate surface", "Backend TLS");
    await click("Rotate Now", panel());
    await settle(() => expect(document.body.textContent).toContain("Rotation enqueued for backend_tls"));
    expect(new URL(writes()[0].url).pathname).toBe("/api/proxy/admin/tls/rotate/backend_tls");
    expect(await writes()[0].text()).toBe("");
    await click("Rotate Now", panel());
    await settle(() => expect(document.body.textContent).toContain("surface not configured"));
    expect(writes()).toHaveLength(2);
  });

  it("renders event revisions and errors and applies the selected outcome filter", async () => {
    const events: TlsSourceEvent[] = [{
      id: 1, at, surface: "proxy_https", outcome: "rotated", revision: 7,
      sources: [{ label: "leaf", cert_id: "edge", source_id: "managed://certificates/edge", scheme: "managed", kind: "certificate" }],
    }, { id: 2, at, surface: "backend_tls", outcome: "load_error", error: "issuer unavailable", sources: [] }];
    collections.events = events;
    await mount("Events");
    await settle(() => expect(panel().textContent).toContain("rev 7"));
    expect(panel().textContent).toContain("leaf: managed://certificates/edge");
    expect(panel().textContent).toContain("issuer unavailable");
    await selectOption("Outcome", "Load error");
    await settle(() => expect(requests.some((request) => new URL(request.url).searchParams.get("outcome") === "load_error")).toBe(true));
    await selectOption("Outcome", "All outcomes");
    await settle(() => expect(panel().querySelector('[role="combobox"]')?.textContent).toBe("All outcomes"));
  });
});

describe("managed TLS material", () => {
  it.each([
    ["Certificates", "certificates", "certificate", "Add Certificate", "cert_pem", "Certificate (PEM)"],
    ["CA Bundles", "ca-bundles", "ca_bundle", "Add CA Bundle", "ca_bundle_pem", "CA Bundle (PEM)"],
    ["CRLs", "crls", "crl", "Add CRL", "crl_pem", "CRL (PEM)"],
    ["OCSP", "ocsp-responses", "ocsp_response", "Add OCSP", "ocsp_der_base64", "OCSP Response (base64 DER)"],
    ["JWKS", "jwks", "jwks", "Add JWKS", "jwks_json", "JWKS Document (JSON)"],
  ] as const)("creates and deletes %s through its fleet-global collection", async (tab, collection, kind, add, field, requiredLabel) => {
    const created: ManagedTlsRecord = { ...record, kind, source_uri: `managed://${collection}/edge-cert` };
    mutate.mockImplementation(async (request) => {
      if (request.method === "POST") {
        collections[collection] = [created];
        return Response.json(created);
      }
      collections[collection] = [];
      return new Response(null, { status: 204 });
    });
    await mount(tab);
    await click(add, panel());
    await click("Create", dialog());
    await settle(() => expect(document.body.textContent).toContain(`${requiredLabel} is required`));
    expect(writes()).toHaveLength(0);
    await fill(inputByLabel(dialog(), "ID"), " edge-cert ");
    await fill(inputByLabel(dialog(), "Name"), " Edge Certificate ");
    const areas = dialog().querySelectorAll("textarea");
    await fill(areas[0], "  fixture material  ");
    if (collection === "certificates") {
      await fill(areas[1], keyPem);
      await fill(areas[2], certPem);
    }
    await click("Create", dialog());
    await settle(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await settle(() => expect(panel().textContent).toContain(created.source_uri));
    const payload = { id: "edge-cert", name: "Edge Certificate", [field]: "  fixture material  ",
      ...(collection === "certificates" && { key_pem: keyPem, chain_pem: certPem }) };
    expect(await writes()[0].json()).toEqual(payload);
    expect(new URL(writes()[0].url).pathname).toBe(`/api/proxy/admin/tls/${collection}`);
    expect(panel().textContent).toContain("2 certs");
    const remove = [...panel().querySelectorAll<HTMLButtonElement>("button")]
      .find((entry) => entry.textContent?.trim() === "")!;
    await act(async () => remove.click());
    expect(dialog().textContent).toContain("fleet-global record shared by every namespace");
    await click("Cancel", dialog());
    expect(writes()).toHaveLength(1);
    await act(async () => remove.click());
    await click("Delete", dialog());
    await settle(() => expect(panel().textContent).not.toContain(created.source_uri));
    expect(writes()[1].method).toBe("DELETE");
    expect(new URL(writes()[1].url).pathname).toBe(`/api/proxy/admin/tls/${collection}/edge-cert`);
    expect(writes().every((request) => !request.headers.has("X-Ferrum-Namespace"))).toBe(true);
  });

  it("shows material errors inline, clears them on edit, and keeps referenced records on delete conflict", async () => {
    collections.certificates = [record];
    mutate.mockImplementation(async (request) => Response.json(
      { error: request.method === "DELETE" ? "certificate is still referenced" : "cert_pem: no PEM certificates found" },
      { status: request.method === "DELETE" ? 409 : 400 },
    ));
    await mount("Certificates");
    await click("Add Certificate", panel());
    await fill(dialog().querySelectorAll("textarea")[0], "bad cert");
    await fill(dialog().querySelectorAll("textarea")[1], "bad key");
    await click("Create", dialog());
    await settle(() => expect(dialog().textContent).toContain("no PEM certificates found"));
    expect(dialog().querySelector("textarea")?.getAttribute("aria-invalid")).toBe("true");
    expect(popup).not.toHaveBeenCalled();
    await fill(dialog().querySelector("textarea")!, certPem);
    expect(dialog().textContent).not.toContain("no PEM certificates found");
    await click("Cancel", dialog());
    const remove = [...panel().querySelectorAll<HTMLButtonElement>("button")]
      .find((entry) => entry.textContent?.trim() === "")!;
    await act(async () => remove.click());
    await click("Delete", dialog());
    await settle(() => expect(document.body.textContent).toContain("certificate is still referenced"));
    expect(panel().textContent).toContain("Edge Certificate");
    expect(writes()).toHaveLength(2);
  });
});

describe("TLS validation", () => {
  it("sends only populated fields and renders the gateway validation result", async () => {
    mutate.mockResolvedValueOnce(Response.json({ valid: true, validated: { certificate_count: 1 } }))
      .mockResolvedValueOnce(Response.json({ valid: false, validated: { key_match: false } }));
    await mount("Validate");
    const areas = panel().querySelectorAll("textarea");
    await fill(areas[0], certPem);
    await fill(areas[1], keyPem);
    await fill(areas[2], "   ");
    await click("Validate", panel());
    await settle(() => expect(panel().textContent).toContain("VALID"));
    expect(panel().textContent).toContain('"certificate_count": 1');
    const expected: TlsValidateRequest = { cert_pem: certPem, key_pem: keyPem };
    expect(await writes()[0].json()).toEqual(expected);
    expect(new URL(writes()[0].url).pathname).toBe("/api/proxy/admin/tls/validate");
    await fill(areas[2], certPem);
    await click("Validate", panel());
    await settle(() => expect(panel().textContent).toContain("INVALID"));
    expect(await writes()[1].json()).toEqual({ ...expected, ca_bundle_pem: certPem });
    expect(writes().every((request) => !request.headers.has("X-Ferrum-Namespace"))).toBe(true);
  });

  it.each(["cert_pem: no certificates", "crl_pem: no revocations", "validation unavailable"])(
    "renders %s without losing the gateway detail", async (error) => {
      mutate.mockResolvedValue(Response.json({ error }, { status: 400 }));
      await mount("Validate");
      await click("Validate", panel());
      await settle(() => expect(document.body.textContent).toContain(error.replace(/^(cert_pem|crl_pem): /, "")));
      expect(popup).not.toHaveBeenCalled();
      if (error.startsWith("cert_pem")) {
        expect(panel().querySelector("textarea")?.getAttribute("aria-invalid")).toBe("true");
        await fill(panel().querySelector("textarea")!, certPem);
        expect(panel().querySelector("textarea")?.hasAttribute("aria-invalid")).toBe(false);
        expect(panel().textContent).not.toContain("no certificates");
      } else {
        expect(panel().querySelector('[aria-invalid="true"]')).toBeNull();
      }
    },
  );
});

describe("ACME workflows", () => {
  beforeEach(() => {
    collections["acme/certificates"] = [certificate];
    collections["acme/orders"] = [order];
    collections["acme/accounts"] = [account];
  });

  it("renders accounts and DNS instructions and reads certificate detail without private material", async () => {
    await mount("ACME");
    await settle(() => expect(panel().textContent).toContain("account-edge"));
    expect(panel().textContent).toContain("credentials stored");
    expect(panel().textContent).toContain("_acme-challenge.edge.example.test");
    expect(panel().textContent).toContain("fixture-dns-value");
    expect(panel().textContent).toContain("21d left");
    await click("View", panel());
    await settle(() => expect(dialog().textContent).toContain("fixture-fingerprint"));
    for (const value of ["acme-edge", "Example CA", "CN=edge.example.test", "Private-key material is intentionally absent"]) {
      expect(dialog().textContent).toContain(value);
    }
    expect(dialog().querySelector("textarea")).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it("validates and submits a new order with normalized contacts and the selected challenge", async () => {
    mutate.mockResolvedValue(Response.json(order));
    await mount("ACME");
    await click("New ACME Order", panel());
    await click("Create Order", dialog());
    await settle(() => expect(document.body.textContent).toContain("At least one domain is required"));
    expect(writes()).toHaveLength(0);
    await fill(inputByLabel(dialog(), "Domains"), " edge.example.test, www.example.test, ");
    await fill(inputByLabel(dialog(), "Contact"), " ops@example.test, mailto:admin@example.test, ");
    await fill(inputByLabel(dialog(), "Directory URL"), "https://ca.example.test/directory");
    await selectOption("Challenge Type", "DNS-01 (manual TXT record)");
    await act(async () => dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click("Create Order", dialog());
    await settle(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    const expected: AcmeOrderRequest = {
      domains: ["edge.example.test", "www.example.test"], directory_url: "https://ca.example.test/directory",
      contact: ["mailto:ops@example.test", "mailto:admin@example.test"], challenge_type: "dns01", terms_of_service_agreed: true,
    };
    expect(await writes()[0].json()).toEqual(expected);
    expect(new URL(writes()[0].url).pathname).toBe("/api/proxy/admin/tls/acme/orders");
    await click("New ACME Order", panel());
    expect(inputByLabel(dialog(), "Domains").value).toBe("");
    await click("Cancel", dialog());
  });

  it.each(["import", "replace"] as const)("%s sends complete certificate material and clears its draft on close", async (mode) => {
    mutate.mockResolvedValue(Response.json(certificate));
    await mount("ACME");
    await settle(() => expect(panel().textContent).toContain("acme://certificates/acme-edge"));
    await click(mode === "import" ? "Import Certificate" : "Replace", panel());
    const save = mode === "import" ? "Import certificate" : "Replace material";
    await click(save, dialog());
    await settle(() => expect(document.body.textContent).toContain(mode === "import"
      ? "At least one certificate domain is required" : "Leaf certificate must be complete"));
    expect(writes()).toHaveLength(0);
    expect(inputByLabel(dialog(), "Certificate ID").disabled).toBe(mode === "replace");
    if (mode === "import") {
      await fill(inputByLabel(dialog(), "Certificate ID"), " acme-edge ");
      await fill(inputByLabel(dialog(), "Domains"), "edge.example.test, edge.example.test");
    }
    await fill(inputByLabel(dialog(), "ACME directory URL"), "https://ca.example.test/directory");
    await fill(inputByLabel(dialog(), "Account ID / URL"), " account-edge ");
    await fill(inputByLabel(dialog(), "Order URL"), "https://ca.example.test/orders/1");
    await fill(inputByLabel(dialog(), "Expiry warning days"), "14");
    const areas = dialog().querySelectorAll("textarea");
    await fill(areas[0], certPem);
    await fill(areas[1], keyPem);
    await fill(areas[2], certPem);
    await act(async () => dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click(save, dialog());
    await settle(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    const expected: AcmeCertificateRequest = {
      id: "acme-edge", domains: ["edge.example.test"], directory_url: "https://ca.example.test/directory",
      account_id: "account-edge", order_url: "https://ca.example.test/orders/1",
      cert_pem: certPem, key_pem: keyPem, chain_pem: certPem,
      allow_expired: true, allow_overwrite: mode === "replace", cert_expiry_warning_days: 14,
    };
    expect(await writes()[0].json()).toEqual(expected);
    expect(writes()[0].method).toBe(mode === "import" ? "POST" : "PUT");
    expect(new URL(writes()[0].url).pathname).toBe(`/api/proxy/admin/tls/acme/certificates${mode === "replace" ? "/acme-edge" : ""}`);
    await click(mode === "import" ? "Import Certificate" : "Replace", panel());
    expect([...dialog().querySelectorAll("textarea")].every((area) => area.value === "")).toBe(true);
    await click("Cancel", dialog());
  });

  it("finalizes and renews without replaying actions", async () => {
    mutate.mockImplementation(async (request) => {
      if (request.url.endsWith("/finalize")) {
        collections["acme/orders"] = [{ ...order, status: "valid" }];
        return Response.json({ order: { ...order, status: "valid" }, certificate });
      }
      return Response.json(order);
    });
    await mount("ACME");
    await settle(() => expect(panel().textContent).toContain("Finalize"));
    await click("Finalize", panel());
    await settle(() => expect(panel().textContent).not.toContain("Finalize"));
    expect(await writes()[0].json()).toEqual({ poll_timeout_seconds: 60 });
    await click("Renew", panel());
    await settle(() => expect(document.body.textContent).toContain("Renewal order created for edge.example.test"));
    expect(await writes()[1].json()).toEqual({ terms_of_service_agreed: true });
    expect(new URL(writes()[1].url).pathname).toBe("/api/proxy/admin/tls/acme/renew/acme-edge");
    expect(writes()).toHaveLength(2);
  });

  it.each(["certificate", "order"] as const)("preserves a %s on conflict, then deletes after explicit confirmation", async (kind) => {
    const collection = kind === "certificate" ? "acme/certificates" : "acme/orders";
    mutate.mockResolvedValueOnce(Response.json({ error: "resource still referenced" }, { status: 409 }))
      .mockImplementationOnce(async () => {
        collections[collection] = [];
        return new Response(null, { status: 204 });
      });
    await mount("ACME");
    await settle(() => expect(panel().textContent).toContain("order-edge"));
    await click(kind === "certificate" ? "Delete certificate for edge.example.test" : "Delete ready order for edge.example.test", panel());
    expect(dialog().textContent?.toLowerCase()).toContain("fleet-global");
    const confirm = kind === "certificate" ? "Delete Certificate" : "Delete Order";
    expect(writes()).toHaveLength(0);
    await click(confirm, dialog());
    await settle(() => expect(document.body.textContent).toContain("resource still referenced"));
    expect(dialog()).toBeTruthy();
    await settle(() => expect(button(confirm, dialog()).disabled).toBe(false));
    await click(confirm, dialog());
    await settle(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await settle(() => expect(panel().textContent).toContain(kind === "certificate" ? "No ACME certificates" : "No active orders"));
    expect(writes()).toHaveLength(2);
    expect(writes().every((request) => request.method === "DELETE" && !request.headers.has("X-Ferrum-Namespace"))).toBe(true);
  });
});
