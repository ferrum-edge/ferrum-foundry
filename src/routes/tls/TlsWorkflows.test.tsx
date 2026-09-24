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
  button, click, createHarness, fill, page, panel, selectOption, selectTab, settle, stubFetch,
} from "@/test/__tests__/harness";
import TlsPage from "./index";

const at = "2026-09-01T00:00:00Z";
// Deliberately invalid cryptographic material: these fixtures only exercise
// form serialization. The mocked gateway owns material validation results.
const certPem = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
const keyPem = "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----";
const crlPem = "-----BEGIN X509 CRL-----\nfixture\n-----END X509 CRL-----";
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
  stubFetch(async (request) => {
    requests.push(request);
    if (request.method !== "GET") return mutate(request);
    if (readStatus) return Response.json({ error: "TLS unavailable" }, { status: readStatus, headers: { "retry-after": "0" } });
    const path = new URL(request.url).pathname.replace("/api/proxy/admin/tls/", "");
    if (path === "acme/certificates/acme-edge") return Response.json(certificate);
    if (!(path in collections)) throw new Error(`Unexpected TLS read: ${path}`);
    return Response.json(page(collections[path]));
  });
});

afterEach(async () => {
  await ui.dispose();
  setApiErrorHandler(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function mount(tab = "Inventory", entry = "/tls") {
  const parent = createRootRoute();
  const route = createRoute({ getParentRoute: () => parent, path: "/tls", component: TlsPage });
  const router = createRouter({
    routeTree: parent.addChildren([route]), history: createMemoryHistory({ initialEntries: [entry] }),
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

type NativeRoleElements = {
  textbox: HTMLTextAreaElement;
  button: HTMLButtonElement;
  checkbox: HTMLInputElement;
  spinbutton: HTMLInputElement;
};

// Native controls used by this DOM harness. Resolve actual label associations
// and ARIA names, never adjacent spans or the control's position in the page.
function getByRole<Role extends keyof NativeRoleElements>(
  root: ParentNode,
  role: Role,
  { name }: { name: string },
): NativeRoleElements[Role] {
  const selectors = {
    textbox: "textarea",
    button: "button",
    checkbox: 'input[type="checkbox"]',
    spinbutton: 'input[type="number"]',
  };
  const matches = [...root.querySelectorAll<NativeRoleElements[Role]>(selectors[role])]
    .filter((control) => {
      const referencedName = control.getAttribute("aria-labelledby")?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      const labelName = Array.from(control.labels ?? [], (label) => label.textContent).join(" ");
      const accessibleName = referencedName ?? control.getAttribute("aria-label")
        ?? (labelName || (role === "button" ? control.textContent : "")) ?? "";
      return accessibleName.replace(/\s+/g, " ").trim() === name;
    });
  expect(matches, `${role} named ${name}`).toHaveLength(1);
  return matches[0];
}

function describedText(control: Element) {
  const ids = control.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
  expect(ids.length).toBeGreaterThan(0);
  return ids.map((id) => {
    const description = document.getElementById(id);
    expect(description).not.toBeNull();
    return description!.textContent;
  }).join(" ");
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

  it("presents a refused read as a denial, never as an empty store", async () => {
    // Edge requires operator for every TLS read. A viewer's 403 is an answer
    // about the session: claiming "no TLS material" would be a false fact.
    readStatus = 403;
    await mount();
    await settle(() => expect(panel().textContent).toContain("TLS inventory: read not permitted for this session"));
    expect(panel().textContent).not.toContain("No TLS material found");
    for (const [tab, label, empty] of [
      ["Certificates", "Managed Certificates", "No certificates yet"],
      ["CA Bundles", "Managed CA Bundles", "No CA bundles yet"],
      ["CRLs", "Managed CRLs", "No CRLs yet"],
      ["OCSP", "Managed OCSP", "No OCSP responses yet"],
      ["JWKS", "Managed JWKS", "No JWKS documents yet"],
      ["Events", "TLS events", "No TLS events"],
      // Last, so the orders list below is read from the ACME panel.
      ["ACME", "ACME certificates", "No ACME certificates"],
    ]) {
      await selectTab(tab);
      await settle(() => expect(panel().textContent).toContain(`${label}: read not permitted for this session`));
      expect(panel().textContent).not.toContain(empty);
      expect(panel().querySelector("[data-read-denied]")).not.toBeNull();
    }
    await settle(() => expect(panel().textContent).toContain("ACME orders: read not permitted for this session"));
    expect(panel().textContent).not.toContain("No active orders");
    expect(writes()).toHaveLength(0);
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
    ["Certificates", "certificates", "certificate", "Add Certificate", "cert_pem", "Certificate (PEM)", "certificate"],
    ["CA Bundles", "ca-bundles", "ca_bundle", "Add CA Bundle", "ca_bundle_pem", "CA Bundle (PEM)", "CA bundle"],
    ["CRLs", "crls", "crl", "Add CRL", "crl_pem", "CRL (PEM)", "CRL"],
    ["OCSP", "ocsp-responses", "ocsp_response", "Add OCSP", "ocsp_der_base64", "OCSP Response (base64 DER)", "OCSP response"],
    ["JWKS", "jwks", "jwks", "Add JWKS", "jwks_json", "JWKS Document (JSON)", "JWKS document"],
  ] as const)("creates and deletes %s through its fleet-global collection", async (tab, collection, kind, add, field, requiredLabel, recordLabel) => {
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
    await fill(getByRole(dialog(), "textbox", { name: requiredLabel }), "  fixture material  ");
    if (collection === "certificates") {
      await fill(getByRole(dialog(), "textbox", { name: "Private Key (PEM)" }), keyPem);
      await fill(getByRole(dialog(), "textbox", { name: "Chain (PEM, optional)" }), certPem);
    }
    await click("Create", dialog());
    await settle(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await settle(() => expect(panel().textContent).toContain(created.source_uri));
    const payload = { id: "edge-cert", name: "Edge Certificate", [field]: "  fixture material  ",
      ...(collection === "certificates" && { key_pem: keyPem, chain_pem: certPem }) };
    expect(await writes()[0].json()).toEqual(payload);
    expect(new URL(writes()[0].url).pathname).toBe(`/api/proxy/admin/tls/${collection}`);
    expect(panel().textContent).toContain("2 certs");
    const removeName = `Delete ${recordLabel} Edge Certificate`;
    const remove = getByRole(panel(), "button", { name: removeName });
    expect(remove.title).toBe(removeName);
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
    const cert = getByRole(dialog(), "textbox", { name: "Certificate (PEM)" });
    await fill(cert, "bad cert");
    await fill(getByRole(dialog(), "textbox", { name: "Private Key (PEM)" }), "bad key");
    await click("Create", dialog());
    await settle(() => expect(dialog().textContent).toContain("No PEM certificates found"));
    expect(cert.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(cert)).toBe("No PEM certificates found");
    expect(popup).not.toHaveBeenCalled();
    await fill(cert, certPem);
    expect(cert.hasAttribute("aria-describedby")).toBe(false);
    expect(dialog().textContent).not.toContain("No PEM certificates found");
    await click("Cancel", dialog());
    const remove = getByRole(panel(), "button", { name: "Delete certificate Edge Certificate" });
    await act(async () => remove.click());
    await click("Delete", dialog());
    await settle(() => expect(document.body.textContent).toContain("certificate is still referenced"));
    expect(panel().textContent).toContain("Edge Certificate");
    expect(writes()).toHaveLength(2);
  });

  it("names delete actions with the record ID when no friendly name exists", async () => {
    collections.certificates = [{ ...record, name: "" }];
    await mount("Certificates");
    await settle(() => expect(panel().textContent).toContain(record.source_uri));
    const remove = getByRole(panel(), "button", { name: "Delete certificate edge-cert" });
    expect(remove.title).toBe("Delete certificate edge-cert");
  });
});

describe("TLS validation", () => {
  it.each([
    ["certificate and key", { cert_pem: certPem, key_pem: keyPem }],
    ["CA only", { ca_bundle_pem: certPem }],
    ["CRL only", { crl_pem: crlPem }],
    ["combined material", { cert_pem: certPem, key_pem: keyPem, ca_bundle_pem: certPem, crl_pem: crlPem }],
    ["custom warning threshold", { cert_pem: certPem, key_pem: keyPem, cert_expiry_warning_days: 14 }],
    ["zero warning threshold", { ca_bundle_pem: certPem, cert_expiry_warning_days: 0 }],
  ] satisfies [string, TlsValidateRequest][])("sends only populated fields for %s", async (_scenario, expected: TlsValidateRequest) => {
    mutate.mockResolvedValue(Response.json({ valid: true, validated: {} }));
    await mount("Validate");
    const fields = [
      ["cert_pem", "Certificate (PEM)"], ["key_pem", "Private Key (PEM)"],
      ["ca_bundle_pem", "CA Bundle (PEM)"], ["crl_pem", "CRL (PEM)"],
    ] as const;
    for (const [field, name] of fields) {
      await fill(getByRole(panel(), "textbox", { name }), expected[field] ?? "   ");
    }
    const threshold = getByRole(panel(), "spinbutton", { name: "Certificate expiry warning (days)" });
    expect(threshold.placeholder).toBe("30");
    expect(threshold.value).toBe("");
    expect(threshold.min).toBe("0");
    expect(threshold.step).toBe("1");
    expect(describedText(threshold)).toContain("default of 30 days");
    const allowExpired = getByRole(panel(), "checkbox", { name: "Allow expired certificates" });
    expect(allowExpired.checked).toBe(false);
    expect(describedText(allowExpired)).toContain("CRL checks always apply");
    if (expected.cert_expiry_warning_days !== undefined) {
      await fill(threshold, String(expected.cert_expiry_warning_days));
    }
    await click("Validate", panel());
    await settle(() => expect(panel().textContent).toContain("VALID"));
    expect(writes()).toHaveLength(1);
    expect(await writes()[0].json()).toEqual(expected);
    expect(new URL(writes()[0].url).pathname).toBe("/api/proxy/admin/tls/validate");
    expect(writes()[0].headers.has("X-Ferrum-Namespace")).toBe(false);
  });

  it("opts into relaxed certificate validity without relaxing CRL checks", async () => {
    mutate.mockResolvedValueOnce(Response.json({ error: "cert_pem: certificate has expired" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ valid: true, validated: { cert_key_pair: { valid: true, certificate_count: 1 } } }))
      .mockResolvedValueOnce(Response.json({ error: "crl_pem: nextUpdate has been reached" }, { status: 400 }));
    await mount("Validate");
    await fill(getByRole(panel(), "textbox", { name: "Certificate (PEM)" }), certPem);
    await fill(getByRole(panel(), "textbox", { name: "Private Key (PEM)" }), keyPem);
    await click("Validate", panel());
    await settle(() => expect(panel().textContent).toContain("Certificate has expired"));
    await act(async () => getByRole(panel(), "checkbox", { name: "Allow expired certificates" }).click());
    await click("Validate", panel());
    await settle(() => expect(panel().textContent).toContain("VALID"));
    const expected = { cert_pem: certPem, key_pem: keyPem, allow_expired: true };
    expect(await writes()[0].json()).toEqual({ cert_pem: certPem, key_pem: keyPem });
    expect(await writes()[1].json()).toEqual(expected);
    expect(panel().textContent).toContain("CRL checks always apply");
    const crl = getByRole(panel(), "textbox", { name: "CRL (PEM)" });
    await fill(crl, crlPem);
    await click("Validate", panel());
    await settle(() => expect(panel().textContent).toContain("NextUpdate has been reached"));
    expect(crl.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(crl)).toBe("NextUpdate has been reached");
    expect(await writes()[2].json()).toEqual({ ...expected, crl_pem: crlPem });
    expect(panel().querySelector("pre")).toBeNull();
  });

  it("omits a cleared warning threshold and unchecked allow-expired option", async () => {
    mutate.mockResolvedValue(Response.json({ valid: true, validated: {} }));
    await mount("Validate");
    await fill(getByRole(panel(), "textbox", { name: "CRL (PEM)" }), `  ${crlPem}  `);
    const threshold = getByRole(panel(), "spinbutton", { name: "Certificate expiry warning (days)" });
    await fill(threshold, "7");
    await fill(threshold, "");
    const allowExpired = getByRole(panel(), "checkbox", { name: "Allow expired certificates" });
    await act(async () => allowExpired.click());
    await act(async () => allowExpired.click());
    await click("Validate", panel());
    await settle(() => expect(writes()).toHaveLength(1));
    expect(await writes()[0].json()).toEqual({ crl_pem: `  ${crlPem}  ` });
  });

  it.each(["-1", "1.5", "9007199254740992"])("rejects warning threshold %s inline before sending a request", async (value) => {
    mutate.mockResolvedValue(Response.json({ valid: true, validated: {} }));
    await mount("Validate");
    await fill(getByRole(panel(), "textbox", { name: "CA Bundle (PEM)" }), certPem);
    const threshold = getByRole(panel(), "spinbutton", { name: "Certificate expiry warning (days)" });
    await fill(threshold, value);
    await click("Validate", panel());
    expect(panel().textContent).toContain("Enter a non-negative whole number of days");
    expect(threshold.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(threshold)).toContain("Enter a non-negative whole number of days");
    expect(writes()).toHaveLength(0);
    expect(popup).not.toHaveBeenCalled();
    await fill(threshold, "14");
    expect(threshold.hasAttribute("aria-invalid")).toBe(false);
    expect(describedText(threshold)).toContain("default of 30 days");
    expect(panel().textContent).not.toContain("Enter a non-negative whole number of days");
    await click("Validate", panel());
    await settle(() => expect(writes()).toHaveLength(1));
    expect(await writes()[0].json()).toEqual({ ca_bundle_pem: certPem, cert_expiry_warning_days: 14 });
  });

  it("renders CRL summaries and any expiry-warning details returned by the gateway", async () => {
    // `validated` is an open object upstream. Keep even optional/new warning
    // details visible; the current gateway need not return these warning keys.
    const validated = {
      cert_key_pair: { valid: true, certificate_count: 1, warnings: ["Certificate expires in 7 days"] },
      ca_bundle: { valid: true, certificate_count: 2 },
      crl: { valid: true, crl_count: 3 },
      cert_expiry_warning_days: 14,
    };
    mutate.mockResolvedValueOnce(Response.json({ valid: true, validated }))
      .mockResolvedValueOnce(Response.json({ valid: false, validated: { crl: { valid: false } } }));
    await mount("Validate");
    await fill(getByRole(panel(), "textbox", { name: "CRL (PEM)" }), crlPem);
    await click("Validate", panel());
    await settle(() => expect(panel().querySelector("pre")?.textContent).toBe(JSON.stringify(validated, null, 2)));
    await click("Validate", panel());
    await settle(() => expect(panel().textContent).toContain("INVALID"));
    expect(panel().querySelector("pre")?.textContent).toBe(JSON.stringify({ crl: { valid: false } }, null, 2));
  });

  it("sends only populated fields and renders the gateway validation result", async () => {
    mutate.mockResolvedValueOnce(Response.json({ valid: true, validated: { certificate_count: 1 } }))
      .mockResolvedValueOnce(Response.json({ valid: false, validated: { key_match: false } }));
    await mount("Validate");
    await fill(getByRole(panel(), "textbox", { name: "Certificate (PEM)" }), certPem);
    await fill(getByRole(panel(), "textbox", { name: "Private Key (PEM)" }), keyPem);
    const caBundle = getByRole(panel(), "textbox", { name: "CA Bundle (PEM)" });
    await fill(caBundle, "   ");
    await click("Validate", panel());
    await settle(() => expect(panel().textContent).toContain("VALID"));
    expect(panel().textContent).toContain('"certificate_count": 1');
    const expected: TlsValidateRequest = { cert_pem: certPem, key_pem: keyPem };
    expect(await writes()[0].json()).toEqual(expected);
    expect(new URL(writes()[0].url).pathname).toBe("/api/proxy/admin/tls/validate");
    await fill(caBundle, certPem);
    await click("Validate", panel());
    await settle(() => expect(panel().textContent).toContain("INVALID"));
    expect(await writes()[1].json()).toEqual({ ...expected, ca_bundle_pem: certPem });
    expect(writes().every((request) => !request.headers.has("X-Ferrum-Namespace"))).toBe(true);
  });

  it.each([
    ["cert_pem", "textbox", "Certificate (PEM)"],
    ["key_pem", "textbox", "Private Key (PEM)"],
    ["ca_bundle_pem", "textbox", "CA Bundle (PEM)"],
    ["crl_pem", "textbox", "CRL (PEM)"],
    ["allow_expired", "checkbox", "Allow expired certificates"],
    ["cert_expiry_warning_days", "spinbutton", "Certificate expiry warning (days)"],
  ] as const)(
    "associates %s gateway errors with the named control and clears them on edit", async (field, role, name) => {
      const error = `${field}: rejected by gateway`;
      const message = "Rejected by gateway";
      mutate.mockResolvedValue(Response.json({ error }, { status: 400 }));
      await mount("Validate");
      await click("Validate", panel());
      await settle(() => expect(document.body.textContent).toContain(message));
      expect(popup).not.toHaveBeenCalled();
      const control = getByRole(panel(), role, { name });
      expect(control.getAttribute("aria-invalid")).toBe("true");
      expect(describedText(control)).toContain(message);
      if (role === "checkbox") {
        await act(async () => control.click());
      } else {
        await fill(control, role === "spinbutton" ? "14" : certPem);
      }
      expect(control.hasAttribute("aria-invalid")).toBe(false);
      expect(panel().textContent).not.toContain(message);
      if (role === "textbox") expect(control.hasAttribute("aria-describedby")).toBe(false);
    },
  );

  it("keeps non-field gateway failures readable", async () => {
    mutate.mockResolvedValue(Response.json({ error: "validation unavailable" }, { status: 400 }));
    await mount("Validate");
    await click("Validate", panel());
    await settle(() => expect(document.body.textContent).toContain("validation unavailable"));
    expect(popup).not.toHaveBeenCalled();
    expect(panel().querySelector('[aria-invalid="true"]')).toBeNull();
  });
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
    await fill(getByRole(dialog(), "textbox", { name: "Leaf certificate PEM" }), certPem);
    await fill(getByRole(dialog(), "textbox", { name: "Private key PEM" }), keyPem);
    await fill(getByRole(dialog(), "textbox", { name: "Intermediate chain PEM (optional)" }), certPem);
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
    const name = kind === "certificate" ? "Delete certificate for edge.example.test" : "Delete ready order for edge.example.test";
    const remove = getByRole(panel(), "button", { name });
    expect(remove.title).toBe(name);
    await act(async () => remove.click());
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

describe("TLS list pagination", () => {
  it("opens Events at its first page, not at Inventory's offset", async () => {
    await mount("Inventory", "/tls?offset=100&limit=100");
    await settle(() => expect(requests.some((r) => r.url.includes("/admin/tls/inventory"))).toBe(true));
    const inventory = requests.find((r) => r.url.includes("/admin/tls/inventory"))!;
    expect(new URL(inventory.url).searchParams.get("offset")).toBe("100");

    await selectTab("Events");
    await settle(() => expect(requests.some((r) => r.url.includes("/admin/tls/events"))).toBe(true));
    const events = requests.filter((r) => r.url.includes("/admin/tls/events"));
    expect(events.map((r) => new URL(r.url).searchParams.get("offset") ?? "0")).toEqual(["0"]);
    // Nor does Events inherit Inventory's page size.
    expect(events.map((r) => new URL(r.url).searchParams.get("limit"))).toEqual(["50"]);
  });
});
