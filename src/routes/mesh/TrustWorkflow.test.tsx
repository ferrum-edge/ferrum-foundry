import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayTrustBundle, GatewayTrustBundleCreate, GatewayTrustStatus } from "@/api/trust";
import { inputByLabel } from "@/test/fields";
import { click, createHarness, fill, page, panel, selectTab, settle, stubFetch } from "@/test/__tests__/harness";
import { meshResponses } from "@/test/__tests__/meshFixtures";
import MeshPage from "./index";

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({ selectedNamespace: "tenant-a", scope: { namespace: "tenant-a" } }),
}));
let ui: ReturnType<typeof createHarness>;
let bundle: GatewayTrustBundle | undefined;
let conflict: boolean;
let failure: boolean;
let writes: Request[];
const original: GatewayTrustBundle = {
  id: "trust-a", namespace: "tenant-a", trust_domain: "local.example.test", revision: 3,
  bundle: { local: { trust_domain: "local.example.test", x509_authorities: ["YQ=="] } },
};

beforeEach(() => {
  ui = createHarness();
  bundle = undefined;
  conflict = false;
  failure = false;
  writes = [];
  stubFetch(async (request) => {
    const path = new URL(request.url).pathname.replace("/api/proxy/", "");
    if (request.method !== "GET") {
      writes.push(request);
      if (failure) return Response.json({ error: "trust update rejected" }, { status: 400 });
      if (conflict) return Response.json({ error: "Revision conflict", expected_revision: 3, current_revision: 4 }, { status: 409 });
      if (request.method === "DELETE") {
        bundle = undefined;
        return new Response(null, { status: 204 });
      }
      const body = await request.clone().json() as GatewayTrustBundleCreate;
      bundle = { ...original, ...body, revision: (bundle?.revision ?? 0) + 1 };
      return Response.json(bundle);
    }
    if (path in meshResponses) return Response.json(meshResponses[path]);
    if (path === "health") return Response.json({ status: "ok", ready: true, mode: "mesh" });
    if (path === "gateway-trust-bundles") return Response.json(page(bundle ? [bundle] : []));
    if (path === "gateway-trust/status") {
      const status: GatewayTrustStatus = {
        namespace: "tenant-a", configured: Boolean(bundle), authority_unresolved: false, generation: "test-generation",
        process: { published_generations_total: 3, load_rejections_total: 0, ambiguous_authority_total: 0,
          last_published_unix_seconds: 1788220800, last_failure_reason: "none" },
      };
      return Response.json(status);
    }
    throw new Error(`Unexpected trust request: ${path}`);
  });
});
afterEach(async () => {
  await ui.dispose();
  vi.unstubAllGlobals();
});

function dialog() {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(element).not.toBeNull();
  return element!;
}

async function mount() {
  await ui.render(<MeshPage />);
  await selectTab("Trust");
  await settle(() => expect(panel().textContent).toContain(bundle ? "revision 3" : "Create Trust Bundle"));
}

it("creates, rotates and revokes namespace trust with complete public material", async () => {
  await mount();
  expect(panel().textContent).toContain("Create one to establish mesh identity");
  await click("Create Trust Bundle", panel());
  await click("Create bundle", dialog());
  await settle(() => expect(document.body.textContent).toContain("Trust domain is required"));
  expect(writes).toHaveLength(0);
  await fill(inputByLabel(dialog(), "Resource ID"), "trust-a");
  await fill(inputByLabel(dialog(), "Trust domain"), "local.example.test");
  await fill(inputByLabel(dialog(), "Refresh hint (seconds)"), "60");
  const areas = dialog().querySelectorAll("textarea");
  await fill(areas[0], "YQ==");
  const authorities = [{ key_id: "public-fixture", public_key_pem: '{"kty":"RSA","n":"AQ","e":"AQAB"}' }];
  await fill(areas[1], JSON.stringify(authorities));
  const federated = [{ trust_domain: "remote.example.test", x509_authorities: ["Yg=="] }];
  await fill(areas[2], JSON.stringify(federated));
  await click("Create bundle", dialog());
  await settle(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await settle(() => expect(panel().textContent).toContain("revision 1"));
  const expected: GatewayTrustBundleCreate = {
    id: "trust-a", trust_domain: "local.example.test",
    bundle: { local: { trust_domain: "local.example.test", x509_authorities: ["YQ=="],
      jwt_authorities: authorities, refresh_hint_seconds: 60 }, federated },
  };
  expect(await writes[0].json()).toEqual(expected);
  expect(panel().textContent).toContain("1 X.509 · 1 JWT · 1 federated");
  await click("Edit / Rotate", panel());
  expect(inputByLabel(dialog(), "Resource ID").disabled).toBe(true);
  expect(dialog().textContent).toContain("exact revision you loaded: 1");
  await fill(inputByLabel(dialog(), "Refresh hint (seconds)"), "120");
  await click("Save rotation", dialog());
  await settle(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await settle(() => expect(panel().textContent).toContain("revision 2"));
  expect(await writes[1].json()).toEqual({ ...expected, revision: 1,
    bundle: { ...expected.bundle, local: { ...expected.bundle.local, refresh_hint_seconds: 120 } } });
  await click("Delete", panel());
  expect(dialog().textContent).toContain('revokes namespace "tenant-a"');
  await click("Cancel", dialog());
  expect(writes).toHaveLength(2);
  await click("Delete", panel());
  await click("Revoke Trust Bundle", dialog());
  await settle(() => expect(panel().textContent).toContain("Create Trust Bundle"));
  expect(writes.map((request) => request.method)).toEqual(["POST", "PUT", "DELETE"]);
  expect(new URL(writes[2].url).pathname).toBe("/api/proxy/gateway-trust-bundles/trust-a");
  expect(writes.every((request) => request.headers.get("X-Ferrum-Namespace") === "tenant-a")).toBe(true);
});

it("keeps stale rotation edits on conflict, then reloads without an unchecked overwrite", async () => {
  bundle = original;
  conflict = true;
  await mount();
  await click("Edit / Rotate", panel());
  await fill(inputByLabel(dialog(), "Refresh hint (seconds)"), "90");
  await click("Save rotation", dialog());
  await settle(() => expect(dialog().textContent).toContain("Trust bundle changed concurrently"));
  expect(dialog().textContent).toContain("expected revision 3");
  await click("Keep unsaved edits", dialog());
  expect(inputByLabel(dialog(), "Refresh hint (seconds)").value).toBe("90");
  await click("Save rotation", dialog());
  await settle(() => expect(dialog().textContent).toContain("Trust bundle changed concurrently"));
  bundle = { ...original, revision: 4 };
  await click("Reload current bundle", dialog());
  await settle(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(panel().textContent).toContain("revision 4");
  expect(writes).toHaveLength(2);
  for (const request of writes) expect(await request.json()).toMatchObject({ revision: 3 });
});

it("keeps an editor and the published bundle on ordinary save and revoke failures", async () => {
  bundle = original;
  failure = true;
  await mount();
  await click("Edit / Rotate", panel());
  await click("Save rotation", dialog());
  await settle(() => expect(document.body.textContent).toContain("trust update rejected"));
  expect(dialog().textContent).toContain("Edit / rotate trust bundle");
  await click("Cancel", dialog());
  await click("Delete", panel());
  await click("Revoke Trust Bundle", dialog());
  await settle(() => expect(writes).toHaveLength(2));
  expect(panel().textContent).toContain("revision 3");
  await act(async () => { await Promise.resolve(); });
  expect(dialog().textContent).toContain("Delete trust for local.example.test");
});
