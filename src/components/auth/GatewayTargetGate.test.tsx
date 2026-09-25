import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  beginGatewayRequest,
  getGatewayMetadataSnapshot,
  observeGatewayResponse,
  resetGatewayMetadata,
} from "@/api/gatewayMetadata";
import { observeGatewayTarget, resetGatewayTarget } from "@/api/gatewayTarget";
import { click, createHarness, fill } from "@/test/__tests__/harness";
import { GatewayTargetGate } from "./GatewayTargetGate";

const reload = vi.fn();
let ui: ReturnType<typeof createHarness>;
let mounts = 0;

// An editor seeded once from the cache, like every detail-page form.
function Workspace() {
  const queryClient = useQueryClient();
  const [mount] = useState(() => ++mounts);
  const [draft, setDraft] = useState(
    () => queryClient.getQueryData<string>(["proxy", "demo", "p-1"]) ?? "empty",
  );
  return (
    <input
      aria-label="Listen path"
      data-mount={mount}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

function listenPath(): HTMLInputElement | null {
  return ui.host.querySelector<HTMLInputElement>('input[aria-label="Listen path"]');
}

beforeEach(async () => {
  mounts = 0;
  resetGatewayTarget();
  resetGatewayMetadata();
  observeGatewayTarget("target-a");
  ui = createHarness();
  ui.client.setQueryData(["proxy", "demo", "p-1"], "/from-gateway-a");
  await ui.render(<GatewayTargetGate onReload={reload}><Workspace /></GatewayTargetGate>);
});

afterEach(async () => {
  await ui.dispose();
  resetGatewayTarget();
  resetGatewayMetadata();
  reload.mockReset();
});

describe("GatewayTargetGate", () => {
  it("preserves drafts and cached reads across a refresh of the same target", async () => {
    await fill(listenPath()!, "/draft");
    await act(async () => observeGatewayTarget("target-a"));
    expect(listenPath()!.value).toBe("/draft");
    expect(listenPath()!.dataset.mount).toBe("1");
    expect(ui.client.getQueryData(["proxy", "demo", "p-1"])).toBe("/from-gateway-a");
    expect(ui.host.textContent).not.toContain("Gateway target changed");
  });

  it("retires cached reads, drafts, and live-apply state when the target is replaced", async () => {
    await fill(listenPath()!, "/draft-for-a");
    const write = new Request("http://localhost/api/proxy/proxies/p-1", {
      method: "PUT",
      headers: { "X-Ferrum-Namespace": "demo" },
    });
    await observeGatewayResponse(
      write,
      new Response(null, { status: 202, headers: { "X-Ferrum-Config-Cursor": "3:9" } }),
      beginGatewayRequest(write),
    );
    expect(getGatewayMetadataSnapshot().apply.state).not.toBe("idle");

    await act(async () => observeGatewayTarget("target-b"));

    // Same principal, namespace, and id on the new gateway: nothing observed
    // or drafted against the old one survives to be shown or submitted.
    expect(listenPath()).toBeNull();
    expect(ui.host.textContent).toContain("Gateway target changed");
    expect(ui.client.getQueryCache().getAll()).toEqual([]);
    expect(getGatewayMetadataSnapshot().apply.state).toBe("idle");

    // A later observation of the original target does not bring it back.
    await act(async () => observeGatewayTarget("target-a"));
    expect(listenPath()).toBeNull();

    await click("Reload Foundry");
    expect(reload).toHaveBeenCalledOnce();
  });
});
