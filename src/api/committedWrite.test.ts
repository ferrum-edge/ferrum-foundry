/* ------------------------------------------------------------------ */
/*  A committed-but-not-live 503 is a committed write (#430)           */
/* ------------------------------------------------------------------ */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, Proxy } from "./types";
import {
  api,
  committedWriteMessage,
  getApiErrorMessage,
  getCommittedWrite,
  isUnobservedWrite,
  markCommittedWrite,
  scoped,
  setApiErrorHandler,
  SILENT_ERRORS,
} from "./client";
import { isStaleResourceError } from "./conditionalWrite";
import {
  classifyCommittedWrite,
  committedNotLiveAnswer,
  getGatewayMetadataSnapshot,
  resetGatewayMetadata,
  setApplyStatusFetcher,
} from "./gatewayMetadata";
import { MutationOutcomeUnknownError } from "./mutationOutcome";
import * as proxies from "./proxies";

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(
      typeof input === "string" && input.startsWith("/")
        ? new URL(input, "http://localhost")
        : input,
      init,
    );
  }
}

const scope = { namespace: "tenant-a" };
const CURSOR = { "x-ferrum-config-cursor": "1:2" };
const NOT_LIVE = { error: "reload timed out", applied: false, reason: "reload_timeout" };

function committedNotLive(headers: Record<string, string> = CURSOR, body: unknown = NOT_LIVE) {
  return Response.json(body, { status: 503, headers });
}

describe("committedNotLiveAnswer", () => {
  it("recognizes a valid cursor or an explicit applied: false on a 503", () => {
    expect(committedNotLiveAnswer(503, "1:2", undefined)).toEqual({ cursor: "1:2", reason: null });
    expect(committedNotLiveAnswer(503, null, NOT_LIVE)).toEqual({
      cursor: null,
      reason: "reload_timeout",
    });
    expect(committedNotLiveAnswer(503, "1:2", NOT_LIVE)).toEqual({
      cursor: "1:2",
      reason: "reload_timeout",
    });
  });

  it("leaves the nothing-applied family and every other status alone", () => {
    // Nothing applied: no `applied` field and never a cursor.
    expect(committedNotLiveAnswer(503, null, { error: "retry later" })).toBeNull();
    expect(committedNotLiveAnswer(503, null, { error: "x", applied: true })).toBeNull();
    expect(committedNotLiveAnswer(503, "not-a-cursor", {})).toBeNull();
    expect(committedNotLiveAnswer(502, "1:2", NOT_LIVE)).toBeNull();
    expect(committedNotLiveAnswer(500, null, NOT_LIVE)).toBeNull();
  });

  it("classifies a ky-shaped rejection from its parsed body, not its response", () => {
    const error = Object.assign(new Error("HTTP 503"), {
      response: { status: 503, headers: new Headers(CURSOR) },
      data: NOT_LIVE,
    });
    expect(classifyCommittedWrite(error)).toEqual({ cursor: "1:2", reason: "reload_timeout" });
    expect(classifyCommittedWrite(new Error("no response"))).toBeNull();
    expect(classifyCommittedWrite("not an error")).toBeNull();
  });
});

describe("a configuration write answered with the committed-but-not-live 503", () => {
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

  afterEach(() => {
    setApiErrorHandler(undefined);
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  it("is marked committed, raises no popup, is not replayed, and keeps the banner", async () => {
    setApplyStatusFetcher(() => new Promise(() => {}));
    respond = () => committedNotLive();

    const rejection = await api
      .put("api/proxy/proxies/checkout", scoped(scope, { json: {} }))
      .catch((error: unknown) => error);

    expect(sent).toHaveLength(1);
    expect(getCommittedWrite(rejection)).toEqual({ cursor: "1:2", reason: "reload_timeout" });
    expect(isUnobservedWrite(rejection)).toBe(false);
    // The live-apply banner owns the report; the generic "API Error 503"
    // popup is not raised on top of it.
    expect(reported).toEqual([]);
    expect(getGatewayMetadataSnapshot().apply).toMatchObject({
      state: "pending",
      cursor: "1:2",
      namespace: "tenant-a",
    });
  });

  it("is marked committed without a cursor, and on a DELETE", async () => {
    respond = () => committedNotLive({});

    const rejection = await api
      .delete("api/proxy/consumers/alice", scoped(scope))
      .catch((error: unknown) => error);

    expect(sent).toHaveLength(1);
    expect(getCommittedWrite(rejection)).toEqual({ cursor: null, reason: "reload_timeout" });
    expect(reported).toEqual([]);
    expect(getGatewayMetadataSnapshot().apply.state).toBe("unverifiable");
  });

  it("is phrased as saved and not yet live, never as a failure", async () => {
    respond = () => committedNotLive();
    const rejection = await api
      .put("api/proxy/upstreams/orders", scoped(scope, { json: {} }))
      .catch((error: unknown) => error);

    const message = await getApiErrorMessage(rejection, "Failed to update upstream");
    expect(message).toBe(
      "The change was saved: committed, not yet proven live. Reason: reload_timeout. " +
        "See the live-apply banner for cursor 1:2 and runtime status.",
    );
    expect(message).not.toContain("Failed");
    expect(committedWriteMessage("Proxy saved", { cursor: null, reason: null })).toBe(
      "Proxy saved: committed, not yet proven live. " +
        "No valid apply cursor was provided; verify the live gateway configuration.",
    );
  });

  it("is recognized through a wrapper and on a replacement error, and for a silent caller", async () => {
    respond = () => committedNotLive();
    const rejection = await api
      .put(
        "api/proxy/proxies/checkout",
        scoped(scope, { json: {}, context: { [SILENT_ERRORS]: true } }),
      )
      .catch((error: unknown) => error);

    expect(getCommittedWrite(new MutationOutcomeUnknownError("Import", rejection))).toEqual({
      cursor: "1:2",
      reason: "reload_timeout",
    });
    const replacement = markCommittedWrite(new Error("redacted"), { cursor: "3:4", reason: null });
    expect(getCommittedWrite(replacement)).toEqual({ cursor: "3:4", reason: null });
    expect(getCommittedWrite(new Error("unrelated"))).toBeNull();
  });

  it("leaves the nothing-applied 503 and reads to the ordinary error surface", async () => {
    respond = () =>
      Response.json({ error: "retry later" }, { status: 503, headers: { "Retry-After": "1" } });
    const refused = await api
      .put("api/proxy/proxies/checkout", scoped(scope, { json: {} }))
      .catch((error: unknown) => error);
    expect(getCommittedWrite(refused)).toBeNull();
    expect(reported).toEqual([expect.objectContaining({ statusCode: 503 })]);
    expect(getGatewayMetadataSnapshot().apply.state).toBe("nothing_applied");

    // A read is never a committed write, whatever it carries.
    respond = () => committedNotLive();
    const read = await api
      .get("api/proxy/proxies/checkout", scoped(scope, { retry: 0 }))
      .catch((error: unknown) => error);
    expect(getCommittedWrite(read)).toBeNull();
    expect(reported).toHaveLength(2);
  });
});

function proxyFixture(): Proxy {
  return {
    id: "checkout",
    namespace: "tenant-a",
    name: "checkout",
    hosts: ["checkout.example.com"],
    backend_scheme: "https",
    backend_host: "backend-a.internal",
    backend_port: 8443,
    strip_listen_path: true,
    preserve_host_header: false,
    backend_connect_timeout_ms: 2_000,
    backend_read_timeout_ms: 5_000,
    backend_write_timeout_ms: 5_000,
    backend_tls_verify_server_cert: true,
    auth_mode: "single",
    plugins: [],
    frontend_tls: true,
    passthrough: false,
    udp_idle_timeout_seconds: 30,
    allowed_ws_origins: [],
    response_body_mode: "stream",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("saving twice after a committed-but-not-live save (#430)", () => {
  const reported: ApiError[] = [];
  let stored: Proxy;
  let wire: string[];
  let committedPuts: number;

  beforeEach(() => {
    reported.length = 0;
    stored = proxyFixture();
    wire = [];
    committedPuts = 1;
    resetGatewayMetadata();
    setApiErrorHandler((error) => reported.push(error));
    vi.stubGlobal("Request", BasedRequest);
    // Edge commits every PUT. The first one's reload does not go live, so it
    // is answered with the committed-but-not-live 503.
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      wire.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.method === "PUT") {
        const body = (await request.json()) as Partial<Proxy>;
        stored = { ...stored, ...body, updated_at: `rev-${wire.length}` };
        if (committedPuts > 0) {
          committedPuts -= 1;
          return committedNotLive();
        }
      }
      return Response.json(stored);
    }));
  });

  afterEach(() => {
    setApiErrorHandler(undefined);
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  const draft = () => ({
    ...proxies.toUpdatePayload(proxyFixture()),
    backend_read_timeout_ms: 30_000,
  });

  it("refuses the operator's own commit when the baseline is not moved", async () => {
    const opened = proxies.proxyWriteGuard(proxyFixture());
    const first = await proxies
      .update(scope, "checkout", draft(), opened)
      .catch((error: unknown) => error);

    expect(getCommittedWrite(first)).toEqual({ cursor: "1:2", reason: "reload_timeout" });
    expect(stored.backend_read_timeout_ms).toBe(30_000);
    expect(reported).toEqual([]);

    // This is the failure mode #430 describes: the guard finds the operator's
    // own committed change and reports it as a concurrent edit.
    const second = await proxies
      .update(scope, "checkout", draft(), opened)
      .catch((error: unknown) => error);
    expect(isStaleResourceError(second)).toBe(true);
    expect(isStaleResourceError(second) && second.detail.current.backend_read_timeout_ms).toBe(
      30_000,
    );
  });

  it("accepts the same draft again once the editor reseeds from a fresh read", async () => {
    const opened = proxies.proxyWriteGuard(proxyFixture());
    const first = await proxies
      .update(scope, "checkout", draft(), opened)
      .catch((error: unknown) => error);
    expect(getCommittedWrite(first)).not.toBeNull();

    // What `reseedAfterCommit` does: one read seeds both form and baseline.
    const reread = await proxies.get(scope, "checkout");
    const reseeded = proxies.proxyWriteGuard(reread);
    const saved = await proxies.update(
      scope,
      "checkout",
      { ...proxies.toUpdatePayload(reread) },
      reseeded,
    );

    expect(saved.backend_read_timeout_ms).toBe(30_000);
    expect(wire).toEqual([
      "GET /api/proxy/proxies/checkout", // verify
      "PUT /api/proxy/proxies/checkout", // committed, not yet live — never replayed
      "GET /api/proxy/proxies/checkout", // reseed
      "GET /api/proxy/proxies/checkout", // verify against the reseeded baseline
      "PUT /api/proxy/proxies/checkout", // accepted
    ]);
    expect(reported).toEqual([]);
  });
});
