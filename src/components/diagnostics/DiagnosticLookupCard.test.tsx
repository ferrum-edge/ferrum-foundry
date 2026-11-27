import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, fill, settle, stubFetch } from "@/test/__tests__/harness";
import { inputByLabel } from "@/test/fields";
import { DiagnosticLookupCard } from "./DiagnosticLookupCard";

const auth = vi.hoisted(() => ({
  principal: { subject: "ops", displayName: "ops", role: "viewer", authMode: "trusted-proxy" } as unknown,
}));
vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: auth.principal }) }));
const active = vi.hoisted(() => ({ namespace: "tenant-a" }));
vi.mock("@/stores/namespace", () => ({ useNamespace: () => ({ scope: { namespace: active.namespace } }) }));

const REF = `fd1_${"3f9c2a7e5b1d4c8a".repeat(2)}`;
const lookup = {
  schema_version: "ferrum.diagnostic_ref.v1",
  ref: REF,
  namespace: "tenant-a",
  created_at: "2026-09-27T10:15:02.114Z",
  expires_at: "2026-09-27T10:30:02.114Z",
  protocol: "http2",
  status: 502,
  gateway_error: "connection_failure",
  detail_available: true,
  detail: {
    error_class: "dns_lookup_error",
    body_error_class: null,
    rejection_phase: null,
    route_timeout_phase: null,
    backend_dispatch: "pre_wire_failure",
    proxy_id: "orders-api",
    backend_target: "https://orders.internal:8443",
    duration_bucket: "lt_100ms",
    attempts: [{ attempt: 1, backend_dispatch: "pre_wire_failure", error_class: "dns_lookup_error" }],
  },
};

let ui: ReturnType<typeof createHarness>;
let permitted: boolean;
let answer: () => Response;
let requests: Request[];

beforeEach(() => {
  active.namespace = "tenant-a";
  ui = createHarness();
  permitted = true;
  requests = [];
  answer = () => Response.json(lookup);
  stubFetch(async (request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/diagnostics/config") return Response.json({ lookupPermitted: permitted });
    if (path === "/api/diagnostics/lookup") return answer();
    throw new Error(`Unexpected request: ${path}`);
  });
});

afterEach(async () => {
  await ui.dispose();
  vi.unstubAllGlobals();
});

function lookups() {
  return requests.filter((request) => new URL(request.url).pathname === "/api/diagnostics/lookup");
}

async function submit(value: string) {
  await fill(inputByLabel(ui.host, "Diagnostic reference"), value);
  const form = ui.host.querySelector("form")!;
  await act(async () => form.requestSubmit());
}

describe("diagnostic reference lookup", () => {
  it("renders nothing for a role the deployment did not list", async () => {
    permitted = false;
    await ui.render(<DiagnosticLookupCard />);
    await settle(() => expect(requests).toHaveLength(1));
    expect(ui.host.querySelector("input")).toBeNull();
    expect(ui.host.textContent).not.toContain("Diagnostic reference lookup");
    expect(lookups()).toHaveLength(0);
  });

  it("renders nothing without a session", async () => {
    auth.principal = null;
    try {
      await ui.render(<DiagnosticLookupCard />);
      expect(ui.host.querySelector("input")).toBeNull();
      expect(requests).toHaveLength(0);
    } finally {
      auth.principal = { subject: "ops", displayName: "ops", role: "viewer", authMode: "trusted-proxy" };
    }
  });

  it("refuses input that is not a reference without contacting the BFF", async () => {
    await ui.render(<DiagnosticLookupCard />);
    await settle(() => expect(ui.host.textContent).toContain("Diagnostic reference lookup"));
    await submit("https://elsewhere.test/fd1_x");
    expect(ui.host.textContent).toContain("Paste the X-Ferrum-Diagnostic-Ref value");
    expect(lookups()).toHaveLength(0);
  });

  it("looks the reference up in the active namespace and shows the reviewed detail", async () => {
    await ui.render(<DiagnosticLookupCard />);
    await settle(() => expect(ui.host.textContent).toContain("namespace tenant-a"));
    await submit(`  ${REF}  `);
    await settle(() => expect(ui.host.textContent).toContain("orders-api"));
    expect(lookups()).toHaveLength(1);
    // The reference travels in a header, never in the request target.
    expect(new URL(lookups()[0].url).pathname).toBe("/api/diagnostics/lookup");
    expect(new URL(lookups()[0].url).search).toBe("");
    expect(lookups()[0].headers.get("X-Ferrum-Diagnostic-Ref")).toBe(REF);
    expect(lookups()[0].url).not.toContain(REF);
    expect(lookups()[0].headers.get("X-Ferrum-Namespace")).toBe("tenant-a");
    const text = ui.host.textContent ?? "";
    expect(text).toContain("connection_failure");
    expect(text).toContain("https://orders.internal:8443");
    expect(text).toContain("dns_lookup_error");
    expect(text).toContain("pre wire failure");
  });

  it("labels a result with its reference and drops it once the field changes", async () => {
    await ui.render(<DiagnosticLookupCard />);
    await settle(() => expect(ui.host.textContent).toContain("namespace tenant-a"));
    await submit(REF);
    await settle(() => expect(ui.host.textContent).toContain("orders-api"));
    expect(ui.host.textContent).toContain(`Reference ${REF}`);
    await fill(inputByLabel(ui.host, "Diagnostic reference"), `${REF.slice(0, -1)}x`);
    expect(ui.host.textContent).not.toContain("orders-api");
    expect(ui.host.textContent).not.toContain(`Reference ${REF}`);
  });

  it("cancels a lookup in flight when the field changes", async () => {
    const signals: AbortSignal[] = [];
    stubFetch(async (request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/api/diagnostics/config") return Response.json({ lookupPermitted: true });
      signals.push(request.signal);
      return new Promise<Response>(() => {});
    });
    await ui.render(<DiagnosticLookupCard />);
    await settle(() => expect(ui.host.textContent).toContain("namespace tenant-a"));
    await submit(REF);
    await settle(() => expect(signals).toHaveLength(1));
    await fill(inputByLabel(ui.host, "Diagnostic reference"), "fd1_");
    await settle(() => expect(signals[0].aborted).toBe(true));
  });

  it("drops the input and the answer when the namespace changes", async () => {
    await ui.render(<DiagnosticLookupCard />);
    await settle(() => expect(ui.host.textContent).toContain("namespace tenant-a"));
    await submit(REF);
    await settle(() => expect(ui.host.textContent).toContain("orders-api"));
    active.namespace = "tenant-b";
    await ui.render(<DiagnosticLookupCard />);
    await settle(() => expect(ui.host.textContent).toContain("namespace tenant-b"));
    expect(ui.host.textContent).not.toContain("orders-api");
    expect(inputByLabel(ui.host, "Diagnostic reference").value).toBe("");
  });

  it("does not show a lookup that answers after a namespace change", async () => {
    let land: (() => void) | undefined;
    answer = () => Response.json(lookup);
    stubFetch(async (request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/api/diagnostics/config") return Response.json({ lookupPermitted: true });
      return new Promise<Response>((resolve) => { land = () => resolve(answer()); });
    });
    await ui.render(<DiagnosticLookupCard />);
    await settle(() => expect(ui.host.textContent).toContain("namespace tenant-a"));
    await submit(REF);
    await settle(() => expect(land).toBeDefined());
    active.namespace = "tenant-b";
    await ui.render(<DiagnosticLookupCard />);
    await act(async () => land!());
    await settle(() => expect(ui.host.textContent).toContain("namespace tenant-b"));
    expect(ui.host.textContent).not.toContain("orders-api");
  });

  it("reports an unknown reference, naming the replica it names without claiming it exists", async () => {
    answer = () => Response.json({
      error: "No diagnostic reference matches in this namespace on this gateway process, or it expired",
      code: "FERRUM_BFF_DIAGNOSTIC_NOT_FOUND",
      owner_replica: "0a1b2c3d",
    }, { status: 404 });
    await ui.render(<DiagnosticLookupCard />);
    await settle(() => expect(ui.host.textContent).toContain("Diagnostic reference lookup"));
    await submit(REF);
    await settle(() => expect(ui.host.textContent).toContain("No diagnostic reference matches"));
    expect(ui.host.textContent).toContain("The reference names gateway replica 0a1b2c3d");
    expect(ui.host.textContent).not.toContain("minted");
  });

  it("reports a refusal with the BFF's fixed message", async () => {
    answer = () => Response.json({
      error: "Diagnostic lookup is not enabled for your role (FERRUM_DIAGNOSTICS_ROLES)",
      code: "FERRUM_BFF_DIAGNOSTICS_NOT_PERMITTED",
    }, { status: 403 });
    await ui.render(<DiagnosticLookupCard />);
    await settle(() => expect(ui.host.textContent).toContain("Diagnostic reference lookup"));
    await submit(REF);
    await settle(() => expect(ui.host.textContent).toContain("not enabled for your role"));
    expect(ui.host.textContent).not.toContain("orders-api");
  });
});
