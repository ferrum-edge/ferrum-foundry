import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, fill, settle, stubFetch } from "@/test/__tests__/harness";
import { inputByLabel } from "@/test/fields";
import { DiagnosticLookupCard } from "./DiagnosticLookupCard";

const auth = vi.hoisted(() => ({
  principal: { subject: "ops", displayName: "ops", role: "viewer", authMode: "trusted-proxy" } as unknown,
}));
vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: auth.principal }) }));
vi.mock("@/stores/namespace", () => ({ useNamespace: () => ({ scope: { namespace: "tenant-a" } }) }));

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
  ui = createHarness();
  permitted = true;
  requests = [];
  answer = () => Response.json(lookup);
  stubFetch(async (request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/diagnostics/config") return Response.json({ lookupPermitted: permitted });
    if (path.startsWith("/api/diagnostics/refs/")) return answer();
    throw new Error(`Unexpected request: ${path}`);
  });
});

afterEach(async () => {
  await ui.dispose();
  vi.unstubAllGlobals();
});

function lookups() {
  return requests.filter((request) => new URL(request.url).pathname.startsWith("/api/diagnostics/refs/"));
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
    expect(new URL(lookups()[0].url).pathname).toBe(`/api/diagnostics/refs/${REF}`);
    expect(new URL(lookups()[0].url).search).toBe("");
    expect(lookups()[0].headers.get("X-Ferrum-Namespace")).toBe("tenant-a");
    const text = ui.host.textContent ?? "";
    expect(text).toContain("connection_failure");
    expect(text).toContain("https://orders.internal:8443");
    expect(text).toContain("dns_lookup_error");
    expect(text).toContain("pre wire failure");
  });

  it("reports an unknown reference, naming the replica that minted it", async () => {
    answer = () => Response.json({
      error: "No diagnostic reference matches in this namespace on this gateway process, or it expired",
      code: "FERRUM_BFF_DIAGNOSTIC_NOT_FOUND",
      owner_replica: "0a1b2c3d",
    }, { status: 404 });
    await ui.render(<DiagnosticLookupCard />);
    await settle(() => expect(ui.host.textContent).toContain("Diagnostic reference lookup"));
    await submit(REF);
    await settle(() => expect(ui.host.textContent).toContain("No diagnostic reference matches"));
    expect(ui.host.textContent).toContain("0a1b2c3d");
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
