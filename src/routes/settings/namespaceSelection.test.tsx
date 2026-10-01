import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "./index";
import { BasedRequest, click, createHarness, settle, stubFetch } from "@/test/__tests__/harness";

const { setNamespace } = vi.hoisted(() => ({ setNamespace: vi.fn() }));

vi.mock("@/stores/namespace", () => ({
  useNamespace: () => ({
    selectedNamespace: "ferrum",
    setNamespace,
    scope: { namespace: "ferrum" },
  }),
}));
vi.mock("@/components/forms/SettingsForm", () => ({ SettingsForm: () => null }));
vi.mock("@/components/forms/BackupRestoreCard", () => ({ BackupRestoreCard: () => null }));
vi.mock("@/components/forms/NamespaceManagerCard", () => ({ NamespaceManagerCard: () => null }));

let harness: ReturnType<typeof createHarness>;

beforeEach(() => {
  setNamespace.mockReset();
  vi.stubGlobal("Request", BasedRequest);
  harness = createHarness();
});

afterEach(async () => {
  await harness.dispose();
  vi.unstubAllGlobals();
});

describe("Settings namespace selection", () => {
  it("shows an unavailable retry state after a 500 instead of claiming the registry is empty", async () => {
    // Only the namespace registry read fails, and only the first time; the
    // page's other reads (e.g. the gateway connection card) are answered
    // normally so they cannot consume the failure.
    let requests = 0;
    stubFetch((request) => {
      const path = new URL(request.url).pathname;
      if (!/\/namespaces\/?$/.test(path)) {
        return Response.json({});
      }
      requests += 1;
      return requests === 1
        ? Response.json({ error: "synthetic namespace unavailable" }, { status: 500 })
        : Response.json({ data: [], pagination: { offset: 0, limit: 250, total: 0 } });
    });

    await harness.render(<SettingsPage />);
    await settle(() => expect(harness.host.textContent).toContain("Namespace registry unavailable"));

    expect(harness.host.textContent).not.toContain("no namespaces returned from server");
    expect(harness.host.textContent).toContain("The registry is unavailable");
    expect(harness.host.querySelector('[aria-label="Retry Namespace registry"]')).not.toBeNull();
    expect([...harness.host.querySelectorAll("input")]
      .some((input) => input.labels?.[0]?.textContent === "Namespace fallback")).toBe(true);
    expect(harness.host.textContent).toContain("ferrum");
    expect(setNamespace).not.toHaveBeenCalled();

    await click("Retry Namespace registry", harness.host);
    await settle(() => expect(requests).toBe(2));
    await settle(() => expect([...harness.host.querySelectorAll("input")]
      .some((input) => input.labels?.[0]?.textContent === "Namespace")).toBe(true));
    expect(harness.host.textContent).not.toContain("The registry is unavailable");
    expect(harness.host.textContent).toContain("No namespaces are currently listed");
    expect(setNamespace).not.toHaveBeenCalled();
  });
});
