import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiErrorHandler } from "@/api/client";
import { resolveCapabilities, type CapabilityFacts } from "@/lib/capabilities";
import { createHarness, panel, selectTab, settle, stubFetch } from "@/test/__tests__/harness";
import { meshResponses } from "@/test/__tests__/meshFixtures";
import MeshPage from "./index";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ selectedNamespace: "tenant-a", scope: { namespace: "tenant-a" } }),
}));

// An unrestricted administrator on a gateway whose /health established its mode.
let facts: CapabilityFacts;
vi.mock("@/stores/capabilities", () => ({
  useCapabilities: () => ({ capabilities: resolveCapabilities(facts), facts }),
}));

let ui: ReturnType<typeof createHarness>;
const popup = vi.fn();

let cpEgressResponse: () => Response = () =>
  Response.json(
    { error: "No proxy state available" },
    { status: 503, headers: { "retry-after": "0" } },
  );

beforeEach(() => {
  ui = createHarness();
  popup.mockClear();
  setApiErrorHandler(popup);
  cpEgressResponse = () =>
    Response.json(
      { error: "No proxy state available" },
      { status: 503, headers: { "retry-after": "0" } },
    );
  stubFetch(async (request) => {
    const path = new URL(request.url).pathname.replace("/api/proxy/", "");
    // Edge answers the egress read on a gateway without proxy state with the
    // same typed 503 as the dry-run (#759 review F7).
    if (path === "mesh/egress-scope" && facts.mode === "cp") {
      return cpEgressResponse();
    }
    if (path in meshResponses) return Response.json(meshResponses[path]);
    return Response.json({ error: "Not Found" }, { status: 404, headers: { "retry-after": "0" } });
  });
});
afterEach(async () => {
  await ui.dispose();
  setApiErrorHandler(undefined);
  vi.unstubAllGlobals();
});

describe("the egress tab on a gateway without proxy state", () => {
  it("explains why instead of a bare unavailable state", async () => {
    facts = { role: "admin", namespaceScoped: false, mode: "cp", adminWritesEnabled: true, status: "ok" };
    await ui.render(<MeshPage />);
    await selectTab("Egress");
    await settle(() => expect(panel().textContent).toContain("holds no proxy state"));
    expect(panel().querySelector('[data-capability-blocked="gateway-unavailable"]')).not.toBeNull();
    expect(panel().textContent).toContain("Run them against a data plane");
  });

  it("keeps the ordinary read failure where the mode does not explain it", async () => {
    facts = { role: "admin", namespaceScoped: false, mode: "database", adminWritesEnabled: true, status: "ok" };
    await ui.render(<MeshPage />);
    await selectTab("Egress");
    await settle(() => expect(panel().textContent).toContain("Known Destinations"));
    expect(panel().querySelector('[data-capability-blocked="gateway-unavailable"]')).toBeNull();
  });

  it("preserves a 403 authorization denial on a control plane instead of masking it as mode-unavailable", async () => {
    facts = { role: "admin", namespaceScoped: false, mode: "cp", adminWritesEnabled: true, status: "ok" };
    cpEgressResponse = () =>
      Response.json({ error: "Forbidden" }, { status: 403, headers: { "retry-after": "0" } });
    await ui.render(<MeshPage />);
    await selectTab("Egress");
    await settle(() => expect(panel().querySelector("[data-read-denied]")).not.toBeNull());
    expect(panel().querySelector('[data-capability-blocked="gateway-unavailable"]')).toBeNull();
  });

  it("preserves a 500 server error with retry on a control plane", async () => {
    facts = { role: "admin", namespaceScoped: false, mode: "cp", adminWritesEnabled: true, status: "ok" };
    cpEgressResponse = () =>
      Response.json({ error: "Internal Server Error" }, { status: 500, headers: { "retry-after": "0" } });
    await ui.render(<MeshPage />);
    await selectTab("Egress");
    await settle(() => expect(panel().textContent).toContain("Egress scope unavailable"));
    expect(panel().querySelector('[data-capability-blocked="gateway-unavailable"]')).toBeNull();
    expect(panel().textContent).toContain("Retry");
  });
});
