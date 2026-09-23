import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError } from "./types";
import {
  api,
  getApiErrorMessage,
  isUnobservedWrite,
  scoped,
  setApiErrorHandler,
  SILENT_ERRORS,
  UNOBSERVED_WRITE_MESSAGE,
} from "./client";
import {
  getGatewayMetadataSnapshot,
  resetGatewayMetadata,
  setApplyStatusFetcher,
} from "./gatewayMetadata";
import { MutationOutcomeUnknownError } from "./mutationOutcome";
import { GatewayMetadataBanner } from "@/components/shared/GatewayMetadataBanner";

// An ordinary write whose answer never arrived may have committed. It is
// reported as an unknown outcome — never as "not committed" — and never sent
// again to find out.

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" && input.startsWith("/")
      ? new URL(input, "http://localhost") : input, init);
  }
}

const scope = { namespace: "ferrum" };
const UPSTREAM_FAILURE = { error: "Bad Gateway", code: "FERRUM_BFF_UPSTREAM_FAILURE" };

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

async function renderBanner(): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<GatewayMetadataBanner />));
  return host;
}

describe("a write whose outcome was not observed", () => {
  const sent: Request[] = [];
  const reported: ApiError[] = [];
  let respond: (request: Request) => Response | Promise<Response>;

  beforeEach(() => {
    sent.length = 0;
    reported.length = 0;
    resetGatewayMetadata();
    setApiErrorHandler((error) => reported.push(error));
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      sent.push(request);
      return respond(request);
    }));
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    setApiErrorHandler(undefined);
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  it("reports a 502 FERRUM_BFF_UPSTREAM_FAILURE as unknown, once, without replay", async () => {
    respond = () => Response.json(UPSTREAM_FAILURE, { status: 502 });
    const banner = await renderBanner();

    let rejection: unknown;
    await act(async () => {
      rejection = await api
        .post("api/proxy/upstreams", scoped(scope, { json: { name: "orders" } }))
        .catch((error: unknown) => error);
    });

    expect(sent).toHaveLength(1);
    expect(isUnobservedWrite(rejection)).toBe(true);
    expect(getGatewayMetadataSnapshot().apply).toMatchObject({
      state: "outcome_unknown",
      namespace: "ferrum",
      reason: "upstream_failure",
      requestUrl: "http://localhost/api/proxy/upstreams",
      polling: false,
    });
    expect(reported).toEqual([
      expect.objectContaining({
        statusCode: 502,
        outcome: { reason: "upstream_failure", detail: "Bad Gateway" },
      }),
    ]);
    // Forms that toast their own error say the same thing, not "failed".
    expect(await getApiErrorMessage(rejection, "Failed to create upstream")).toBe(
      `${UNOBSERVED_WRITE_MESSAGE}\nBad Gateway\nFERRUM_BFF_UPSTREAM_FAILURE`,
    );
    expect(banner.textContent).toContain("Outcome unknown");
    expect(banner.textContent).toContain("was not replayed");
    expect(banner.textContent).not.toContain("not committed");
  });

  it("reports a response-phase 504 as unknown but an upload-phase 504 as a definite failure", async () => {
    respond = () => Response.json(
      { error: "Gateway Timeout", code: "FERRUM_BFF_TIMEOUT", phase: "response" },
      { status: 504 },
    );
    await api.put("api/proxy/proxies/orders", scoped(scope, { json: {} })).catch(() => undefined);
    expect(getGatewayMetadataSnapshot().apply).toMatchObject({
      state: "outcome_unknown",
      reason: "gateway_timeout",
    });

    respond = () => Response.json(
      { error: "Gateway Timeout", code: "FERRUM_BFF_TIMEOUT", phase: "upload", reason: "idle" },
      { status: 504 },
    );
    const rejection = await api
      .put("api/proxy/proxies/orders", scoped(scope, { json: {} }))
      .catch((error: unknown) => error);
    expect(isUnobservedWrite(rejection)).toBe(false);
    expect(getGatewayMetadataSnapshot().apply.state).toBe("idle");
    expect(reported.at(-1)).not.toHaveProperty("outcome");
    expect(sent).toHaveLength(2);
  });

  it("reports a dropped connection on a DELETE as unknown without replay", async () => {
    respond = () => { throw new TypeError("Failed to fetch"); };

    const rejection = await api
      .delete("api/proxy/consumers/alice", scoped(scope))
      .catch((error: unknown) => error);

    expect(sent).toHaveLength(1);
    expect(isUnobservedWrite(rejection)).toBe(true);
    expect(getGatewayMetadataSnapshot().apply).toMatchObject({
      state: "outcome_unknown",
      reason: "transport",
    });
    expect(reported.at(-1)).toMatchObject({ statusCode: 0, outcome: { reason: "transport" } });
  });

  it("recognizes the lost write through a caller's wrapper, and still classifies a silent call", async () => {
    respond = () => Response.json(UPSTREAM_FAILURE, { status: 502 });

    const rejection = await api
      .post("api/proxy/upstreams", scoped(scope, { json: {}, context: { [SILENT_ERRORS]: true } }))
      .catch((error: unknown) => error);

    expect(reported).toEqual([]);
    expect(getGatewayMetadataSnapshot().apply.state).toBe("outcome_unknown");
    expect(isUnobservedWrite(new MutationOutcomeUnknownError("Import", rejection))).toBe(true);
  });

  it("leaves reads and definite gateway answers to the ordinary error surface", async () => {
    respond = () => Response.json(UPSTREAM_FAILURE, { status: 502 });
    const read = await api
      .get("api/proxy/upstreams", scoped(scope, { retry: 0 }))
      .catch((error: unknown) => error);
    expect(isUnobservedWrite(read)).toBe(false);
    expect(getGatewayMetadataSnapshot().apply.state).toBe("idle");
    expect(reported.at(-1)).not.toHaveProperty("outcome");

    respond = () => Response.json({ error: "name taken" }, { status: 409 });
    const conflict = await api
      .post("api/proxy/upstreams", scoped(scope, { json: {} }))
      .catch((error: unknown) => error);
    expect(isUnobservedWrite(conflict)).toBe(false);
    expect(await getApiErrorMessage(conflict, "Failed")).not.toContain("Outcome unknown");
    expect(getGatewayMetadataSnapshot().apply.state).toBe("idle");

    // A 503 without a cursor keeps its own "not committed" classification.
    respond = () => Response.json({ error: "database unavailable" }, { status: 503 });
    await api.post("api/proxy/upstreams", scoped(scope, { json: {} })).catch(() => undefined);
    expect(getGatewayMetadataSnapshot().apply.state).toBe("nothing_applied");
  });

  it("clears at the next write and never displaces a commit that still needs inspection", async () => {
    respond = () => Response.json(UPSTREAM_FAILURE, { status: 502 });
    await api.post("api/proxy/upstreams", scoped(scope, { json: {} })).catch(() => undefined);
    expect(getGatewayMetadataSnapshot().apply.state).toBe("outcome_unknown");

    // The next write retires the unknown report, like any terminal statement.
    let answered!: () => void;
    setApplyStatusFetcher(() => new Promise(() => { answered(); }));
    const polled = new Promise<void>((done) => { answered = done; });
    respond = () => Response.json({}, { status: 202, headers: { "x-ferrum-config-cursor": "1:2" } });
    await api.post("api/proxy/upstreams", scoped(scope, { json: {} }));
    await polled;
    expect(getGatewayMetadataSnapshot().apply).toMatchObject({ state: "pending", cursor: "1:2" });

    // A later lost answer does not hide the known commit's monitor.
    respond = () => Response.json(UPSTREAM_FAILURE, { status: 502 });
    const rejection = await api
      .post("api/proxy/upstreams", scoped(scope, { json: {} }))
      .catch((error: unknown) => error);
    expect(isUnobservedWrite(rejection)).toBe(true);
    expect(getGatewayMetadataSnapshot().apply).toMatchObject({ state: "pending", cursor: "1:2" });
    expect(reported.at(-1)).toMatchObject({ outcome: { reason: "upstream_failure" } });
  });
});
