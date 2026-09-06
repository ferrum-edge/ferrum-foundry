import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, FLEET_GLOBAL, scoped } from "./client";
import {
  clearGatewayMetadata,
  getGatewayMetadataSnapshot,
  resetGatewayMetadata,
  setApplyStatusFetcher,
  type ApplyStatusResponse,
} from "./gatewayMetadata";
import { GatewayMetadataBanner } from "@/components/shared/GatewayMetadataBanner";

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" && input.startsWith("/")
      ? new URL(input, "http://localhost") : input, init);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function status(state: ApplyStatusResponse["state"], sequence = "2"): ApplyStatusResponse {
  return {
    state, topology_epoch: "1", sequence,
    accepted_topology_epoch: "1", accepted_sequence: sequence,
  };
}

function committed(code = 202, cursor = "1:2"): Response {
  return Response.json({}, { status: code, headers: { "x-ferrum-config-cursor": cursor } });
}

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

async function renderBanner() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<GatewayMetadataBanner />); });
}

const scope = { namespace: "tenant-a" };
const path = "api/proxy/proxies/p-1";

beforeEach(() => {
  resetGatewayMetadata();
  vi.stubGlobal("Request", BasedRequest);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  root = undefined;
  host = undefined;
  resetGatewayMetadata();
  vi.unstubAllGlobals();
});

describe("configured client apply ownership", () => {
  it.each([200, 503])("discards delayed older headers after the newer %s result with reused options", async (newerCode) => {
    const olderHeaders = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(olderHeaders.promise)
      .mockResolvedValueOnce(newerCode === 200 ? committed(200) : Response.json({}, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const options = scoped(scope, { context: { callerValue: "preserved" } });
    const older = api.put(path, options);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await api.put(path, options).catch(() => undefined);
    const latest = getGatewayMetadataSnapshot();
    expect(latest.apply).toMatchObject({
      state: newerCode === 200 ? "applied" : "nothing_applied",
      cursor: newerCode === 200 ? "1:2" : null,
    });
    olderHeaders.resolve(committed(200, "1:1"));
    await older;
    expect(getGatewayMetadataSnapshot()).toBe(latest);
    expect(options.context).toEqual({ callerValue: "preserved" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("clears an older success while a newly dispatched write waits for headers", async () => {
    const headers = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(committed(200)).mockReturnValueOnce(headers.promise);
    vi.stubGlobal("fetch", fetcher);
    await api.put(path, scoped(scope));
    expect(getGatewayMetadataSnapshot().apply.state).toBe("applied");
    const newer = api.put(path, scoped(scope));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(getGatewayMetadataSnapshot().apply.state).toBe("idle");
    headers.resolve(committed(200, "1:3"));
    await newer;
    expect(getGatewayMetadataSnapshot().apply.cursor).toBe("1:3");
  });

  it.each([400, 404, 409, 500, 503])("keeps the committed cursor through a later non-committing %s", async (code) => {
    const poll = deferred<ApplyStatusResponse>();
    const fetchStatus = vi.fn(() => poll.promise);
    setApplyStatusFetcher(fetchStatus);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(committed()).mockResolvedValueOnce(Response.json({}, { status: code })));
    await api.put(path, scoped(scope));
    await expect(api.post("api/proxy/consumers", scoped({ namespace: "tenant-b" }))).rejects.toThrow();
    expect(getGatewayMetadataSnapshot().apply).toMatchObject({
      state: "pending", cursor: "1:2", namespace: "tenant-a", polling: true,
    });
    poll.resolve(status("applied"));
    await vi.waitFor(() => expect(getGatewayMetadataSnapshot().apply.state).toBe("applied"));
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(fetchStatus).toHaveBeenCalledWith("1", "2", 25_000, "tenant-a");
  });

  it.each([200, 202, 503])("replaces a committed monitor with a newer committed %s", async (code) => {
    const olderPoll = deferred<ApplyStatusResponse>();
    const newerPoll = deferred<ApplyStatusResponse>();
    const fetchStatus = vi.fn().mockReturnValueOnce(olderPoll.promise).mockReturnValueOnce(newerPoll.promise);
    setApplyStatusFetcher(fetchStatus);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(committed()).mockResolvedValueOnce(committed(code, "1:3")));
    await api.put(path, scoped(scope));
    await api.put(path, scoped({ namespace: "tenant-b" })).catch(() => undefined);
    olderPoll.resolve(status("rejected"));
    await Promise.resolve();
    expect(getGatewayMetadataSnapshot().apply).toMatchObject({
      cursor: "1:3", namespace: "tenant-b", state: code === 200 ? "applied" : "pending",
    });
    if (code !== 200) {
      newerPoll.resolve(status("applied", "3"));
      await vi.waitFor(() => expect(getGatewayMetadataSnapshot().apply.state).toBe("applied"));
    }
  });

  it.each(["not JSON", "{}", '{"applied":"false"}', ""])("monitors a cursor-bearing 503 with body %j without replay", async (body) => {
    const fetchStatus = vi.fn().mockResolvedValue(status("applied"));
    setApplyStatusFetcher(fetchStatus);
    const fetcher = vi.fn(async () => new Response(body, {
      status: 503, headers: { "x-ferrum-config-cursor": "1:2", "retry-after": "0" },
    }));
    vi.stubGlobal("fetch", fetcher);
    await expect(api.put(path, scoped(scope))).rejects.toThrow();
    await vi.waitFor(() => expect(getGatewayMetadataSnapshot().apply.state).toBe("applied"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it.each(["not JSON", "{}", '{"applied":"false"}', ""])("does not retry a read with a commit cursor and body %j", async (body) => {
    const fetcher = vi.fn(async () => new Response(body, {
      status: 503, headers: { "x-ferrum-config-cursor": "1:2", "retry-after": "0" },
    }));
    vi.stubGlobal("fetch", fetcher);
    await expect(api.get(path, scoped(scope))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, null, { ...status("applied"), state: "unknown" },
    { ...status("applied"), state: ["applied"] },
    { ...status("applied"), sequence: "3" },
    { ...status("applied"), accepted_sequence: "1" },
    { ...status("applied"), accepted_topology_epoch: "2" },
    { ...status("applied"), sequence: 9007199254740992 },
    { ...status("applied"), accepted_sequence: "18446744073709551616" },
  ])("renders an explicit unverifiable result for invalid status %j", async (envelope) => {
    setApplyStatusFetcher(vi.fn().mockResolvedValue(envelope));
    vi.stubGlobal("fetch", vi.fn(async () => committed()));
    await renderBanner();
    await act(async () => { await api.put(path, scoped(scope)); });
    expect(host!.textContent).toContain("Committed state cannot be verified as live.");
    expect(host!.textContent).toContain("invalid_apply_status");
    expect(host!.textContent).toContain("Namespace: tenant-a");
    expect(getGatewayMetadataSnapshot().apply.polling).toBe(false);
  });

  it.each(["tenant-a", null])("labels the originating scope %s and keeps bounded pending status visible", async (namespace) => {
    const fetchStatus = vi.fn().mockResolvedValue(status("pending"));
    setApplyStatusFetcher(fetchStatus);
    vi.stubGlobal("fetch", vi.fn(async () => committed()));
    await renderBanner();
    await act(async () => {
      await api.put(path, namespace === null ? { context: { [FLEET_GLOBAL]: true } } : scoped({ namespace }));
    });
    // Selecting another namespace must not relabel this global monitor.
    await act(async () => {
      root!.render(<div><span>Selected namespace: tenant-b</span><GatewayMetadataBanner /></div>);
    });
    expect(host!.textContent).toContain(namespace === null ? "Fleet-global" : "Namespace: tenant-a");
    expect(host!.textContent).toContain("Monitoring ended for");
    expect(fetchStatus).toHaveBeenCalledTimes(8);
    expect(getGatewayMetadataSnapshot().apply).toMatchObject({ state: "pending", polling: false, namespace });
  });

  it("accepts full uint64 cursor strings without rounding", async () => {
    const epoch = "18446744073709551615";
    const sequence = "9007199254740993";
    setApplyStatusFetcher(vi.fn().mockResolvedValue({
      state: "applied", topology_epoch: epoch, sequence,
      accepted_topology_epoch: epoch, accepted_sequence: sequence,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => committed(202, `${epoch}:${sequence}`)));
    await api.put(path, scoped(scope));
    await vi.waitFor(() => expect(getGatewayMetadataSnapshot().apply.state).toBe("applied"));
    expect(getGatewayMetadataSnapshot().apply.cursor).toBe(`${epoch}:${sequence}`);
  });

  it("retires old reads, mutation headers and polls at a session boundary while retaining the transport", async () => {
    const oldPoll = deferred<ApplyStatusResponse>();
    const oldRead = deferred<Response>();
    const oldWrite = deferred<Response>();
    const fetchStatus = vi.fn().mockReturnValueOnce(oldPoll.promise).mockResolvedValue(status("applied", "4"));
    setApplyStatusFetcher(fetchStatus);
    const fetcher = vi.fn().mockResolvedValueOnce(committed()).mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(oldWrite.promise).mockResolvedValueOnce(committed(202, "1:4"));
    vi.stubGlobal("fetch", fetcher);
    await api.put(path, scoped(scope));
    const read = api.get(path, scoped(scope));
    const write = api.put(path, scoped(scope));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    clearGatewayMetadata();
    oldPoll.resolve(status("applied"));
    oldRead.resolve(Response.json({}, { headers: { "x-data-source": "cached" } }));
    oldWrite.resolve(committed(200, "1:3"));
    await Promise.all([read, write]);
    expect(getGatewayMetadataSnapshot()).toMatchObject({ cachedResponse: null, apply: { state: "idle" } });
    await api.put(path, scoped({ namespace: "tenant-b" }));
    await vi.waitFor(() => expect(getGatewayMetadataSnapshot().apply.state).toBe("applied"));
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });
});
