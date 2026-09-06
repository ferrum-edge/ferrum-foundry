import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NamespaceProvider, NAMESPACE_STORAGE_KEY } from "@/stores/namespace";
import { ToastProvider } from "@/components/ui/Toast";
import { ErrorPopupProvider } from "@/stores/error";
import { GatewayMetadataBanner } from "@/components/shared/GatewayMetadataBanner";
import { clearGatewayMetadata, getGatewayMetadataSnapshot } from "@/api/gatewayMetadata";
import { BackupRestoreCard } from "./BackupRestoreCard";

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: null }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}
let root: Root;
let host: HTMLDivElement;
let qc: QueryClient;
let responses: Response[];
const requests: Request[] = [];

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  expect(button, label).toBeTruthy();
  await act(async () => { button!.click(); });
}
async function chooseBackup() {
  const file = Object.assign(new File(["{}"], "synthetic-backup.json", { type: "application/json" }), {
    text: async () => "{}",
  });
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function settle(check: () => void) {
  await act(async () => { await vi.waitFor(check); });
}
function committed(body: unknown = { applied: false }, cursor: string | null = "1:2") {
  return Response.json(body, { status: 503, headers: {
    ...(cursor && { "x-ferrum-config-cursor": cursor }), "retry-after": "0",
  } });
}

beforeEach(async () => {
  clearGatewayMetadata();
  requests.length = 0;
  responses = [];
  localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push(request.clone());
    if (request.method === "POST") return responses.shift()!;
    expect(new URL(request.url).pathname).toBe("/api/proxy/config/apply-status");
    expect(request.headers.get("x-ferrum-namespace")).toBe("tenant-a");
    return Response.json({
      state: "applied", topology_epoch: "1", sequence: "2",
      accepted_topology_epoch: "1", accepted_sequence: "2",
    });
  }));
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["consumer", "tenant-a", "old"], { username: "old" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><NamespaceProvider><ToastProvider><ErrorPopupProvider>
      <GatewayMetadataBanner /><BackupRestoreCard />
    </ErrorPopupProvider></ToastProvider></NamespaceProvider></QueryClientProvider>);
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  qc.clear();
  host.remove();
  clearGatewayMetadata();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("restore recovery presentation", () => {
  it.each([false, true])("reports a committed restore and monitors its cursor after second confirmation=%s", async (confirmSpecs) => {
    if (confirmSpecs) responses.push(Response.json({
      error: "restore would delete API specs", api_specs_at_risk: 2,
      confirmation_required: "confirm_api_spec_deletion=true",
    }, { status: 409 }));
    // Header alone is authoritative even when the body omits applied:false.
    responses.push(committed({}));
    await chooseBackup();
    await click("Restore");
    if (confirmSpecs) {
      await settle(() => expect(document.body.textContent).toContain("Confirm API spec deletion"));
      await act(async () => {
        const input = document.querySelector<HTMLInputElement>('input[placeholder="DELETE 2 API SPECS IN tenant-a"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "DELETE 2 API SPECS IN tenant-a");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Delete specs and restore");
    }
    await settle(() => expect(document.body.textContent).toContain('Restore committed in namespace "tenant-a"'));
    await settle(() => expect(getGatewayMetadataSnapshot().apply.state).toBe("applied"));
    expect(document.body.textContent).not.toContain("Restore failed");
    expect(document.body.textContent).not.toContain("API Error");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(confirmSpecs ? 2 : 1);
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(1);
    const lastWrite = requests.filter((request) => request.method === "POST").at(-1)!;
    expect(new URL(lastWrite.url).searchParams.get("confirm_api_spec_deletion")).toBe(confirmSpecs ? "true" : null);
    expect(qc.getQueryState(["consumer", "tenant-a", "old"])?.isInvalidated).toBe(true);
  });

  it("retains committed-but-unverifiable copy without inventing a cursor or repeating restore", async () => {
    responses.push(committed({ applied: false, reason: "sequence_unavailable" }, null));
    await chooseBackup();
    await click("Restore");
    await settle(() => expect(document.body.textContent).toContain("No valid apply cursor was provided"));
    expect(document.body.textContent).toContain("Committed state cannot be verified as live.");
    expect(document.body.textContent).not.toContain("Restore failed");
    expect(requests).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows structured pre-commit connectivity details without invalidating accepted data", async () => {
    responses.push(Response.json({ error: "database unreachable", failure_class: "connectivity", restore_errors: ["snapshot failed"] }, { status: 503 }));
    await chooseBackup();
    await click("Restore");
    await settle(() => expect(document.body.textContent).toContain("Restore blocked by a connectivity failure"));
    expect(document.body.textContent).toContain("snapshot failed");
    expect(document.body.textContent).not.toContain("Rollback outcome:");
    expect(document.body.textContent).not.toContain("Restore committed in namespace");
    expect(requests).toHaveLength(1);
    expect(qc.getQueryState(["consumer", "tenant-a", "old"])?.isInvalidated).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("preserves a canonical 500 incomplete-rollback recovery panel", async () => {
    responses.push(Response.json({
      error: "restore import failed", rollback: "incomplete", restore_errors: ["proxy import failed"],
      rollback_errors: ["spec replay failed"], api_specs_not_restored: 2,
    }, { status: 500 }));
    await chooseBackup();
    await click("Restore");
    await settle(() => expect(document.body.textContent).toContain("manual recovery required"));
    expect(document.body.textContent).toContain("spec replay failed");
    expect(document.body.textContent).toContain("2 API specs may still be missing");
    expect(requests).toHaveLength(1);
  });
});
