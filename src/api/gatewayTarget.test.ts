import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, proxyApi, scoped, setApiErrorHandler } from "./client";
import { getGatewayMetadataSnapshot, resetGatewayMetadata } from "./gatewayMetadata";
import {
  GATEWAY_TARGET_HEADER,
  GatewayTargetChangedError,
  boundGatewayTarget,
  isGatewayTargetRetired,
  observeGatewayTarget,
  resetGatewayTarget,
} from "./gatewayTarget";
import * as proxies from "./proxies";
import { stubFetch } from "@/test/__tests__/harness";

const DEMO = { namespace: "demo" };

function answer(body: unknown, target: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set(GATEWAY_TARGET_HEADER, target);
  return Response.json(body, { ...init, headers });
}

// The BFF's refusal of a request declared against a replaced target.
function refusal(current: string): Response {
  return answer({ code: "FERRUM_BFF_GATEWAY_TARGET_CHANGED" }, current, { status: 409 });
}

async function refusedStatus(pending: Promise<unknown>): Promise<number | undefined> {
  const error: unknown = await pending.then(() => undefined, (reason: unknown) => reason);
  return (error as { response?: Response } | undefined)?.response?.status;
}

function declared(request: Request): string | null {
  return request.headers.get(GATEWAY_TARGET_HEADER);
}

beforeEach(() => {
  resetGatewayTarget();
  resetGatewayMetadata();
});

afterEach(() => {
  setApiErrorHandler(undefined);
  resetGatewayTarget();
  resetGatewayMetadata();
  vi.unstubAllGlobals();
});

describe("gateway target binding", () => {
  it("binds the first target the BFF names and declares it on every gateway-facing request", async () => {
    const seen: Request[] = [];
    stubFetch((request) => {
      seen.push(request);
      return answer({ ok: true }, "target-a");
    });
    await api.get("api/auth/session").json();
    expect(boundGatewayTarget()).toBe("target-a");
    await proxyApi.get("proxies", scoped(DEMO)).json();
    await api.get("api/settings").json();
    await api.get("api/settings/status").json();

    expect(declared(seen[0])).toBeNull();
    expect(seen.slice(1).map(declared)).toEqual(["target-a", "target-a", "target-a"]);
    expect(isGatewayTargetRetired()).toBe(false);
  });

  it("keeps the workspace when a refresh names the same target", () => {
    observeGatewayTarget("target-a");
    observeGatewayTarget("target-a");
    observeGatewayTarget(null);
    expect(isGatewayTargetRetired()).toBe(false);
    expect(boundGatewayTarget()).toBe("target-a");
  });

  it("retires on a refusal naming another target, reports no error, and sends nothing afterwards", async () => {
    const popup = vi.fn();
    setApiErrorHandler(popup);
    const fetchMock = stubFetch((request) => new URL(request.url).pathname === "/api/auth/session"
      ? answer({}, "target-a")
      : refusal("target-b"));
    await api.get("api/auth/session").json();

    expect(await refusedStatus(proxyApi.post("proxies", scoped(DEMO, { json: { id: "drafted-against-a" } })).json()))
      .toBe(409);
    expect(isGatewayTargetRetired()).toBe(true);
    expect(popup).not.toHaveBeenCalled();

    const sent = fetchMock.mock.calls.length;
    await expect(proxyApi.get("proxies", scoped(DEMO)).json()).rejects.toBeInstanceOf(GatewayTargetChangedError);
    await expect(api.put("api/settings", { json: { jwtTtl: 600 } }).json())
      .rejects.toBeInstanceOf(GatewayTargetChangedError);
    expect(fetchMock.mock.calls.length).toBe(sent);
    expect(popup).not.toHaveBeenCalled();
  });

  it("retires when the periodic session check names another target", async () => {
    let current = "target-a";
    stubFetch(() => answer({}, current));
    await api.get("api/auth/session").json();
    current = "target-b";
    await api.get("api/auth/session").json();
    expect(isGatewayTargetRetired()).toBe(true);
    expect(boundGatewayTarget()).toBe("target-a");
  });

  it("stops a paginated traversal instead of mixing pages from two gateways", async () => {
    const pages: string[] = [];
    stubFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/auth/session") return answer({}, "target-a");
      pages.push(`${url.searchParams.get("offset")}:${declared(request)}`);
      if (url.searchParams.get("offset") !== "0") return refusal("target-b");
      // Equal totals on both gateways must not let page two come from B.
      const data = Array.from({ length: 250 }, (_, index) => ({ id: `a-${index}` }));
      return answer({ data, pagination: { offset: 0, limit: 250, total: 251 } }, "target-a");
    });
    await api.get("api/auth/session").json();

    expect(await refusedStatus(proxies.listAll(DEMO))).toBe(409);
    expect(pages).toEqual(["0:target-a", "250:target-a"]);
    expect(isGatewayTargetRetired()).toBe(true);
  });

  it("discards a late answer from the replaced target instead of publishing it to the live-apply banner", async () => {
    let release!: (response: Response) => void;
    let retiring = false;
    stubFetch((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/session") return answer({}, retiring ? "target-b" : "target-a");
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    await api.get("api/auth/session").json();

    const write = proxyApi.put("proxies/p-1", scoped(DEMO, { json: { id: "p-1" } })).json();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    retiring = true;
    await api.get("api/auth/session").json();
    expect(isGatewayTargetRetired()).toBe(true);

    // Forwarded to A before the change, answered after it.
    release(answer({ id: "p-1" }, "target-a", { headers: { "X-Ferrum-Config-Cursor": "7:42" } }));
    await write;
    expect(getGatewayMetadataSnapshot().apply.state).toBe("idle");
    expect(getGatewayMetadataSnapshot().etag).toBeNull();
  });
});
