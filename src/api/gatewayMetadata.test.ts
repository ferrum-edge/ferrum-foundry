import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getGatewayMetadataSnapshot,
  observeGatewayResponse,
  parseConfigCursor,
  resetGatewayMetadata,
  setApplyStatusFetcher,
} from "./gatewayMetadata";

function mutationRequest(namespace?: string): Request {
  return new Request("http://localhost/api/proxy/proxies/p-1", {
    method: "PUT",
    ...(namespace && { headers: { "x-ferrum-namespace": namespace } }),
  });
}

afterEach(() => resetGatewayMetadata());

describe("parseConfigCursor", () => {
  it("preserves uint64-sized cursor components as strings", () => {
    expect(parseConfigCursor("18446744073709551615:9007199254740993")).toEqual({
      raw: "18446744073709551615:9007199254740993",
      epoch: "18446744073709551615",
      sequence: "9007199254740993",
    });
  });

  it.each([null, "", "1", "1:2:3", "-1:2", "1.5:2", "a:b"])(
    "rejects malformed cursor %j",
    (value) => expect(parseConfigCursor(value)).toBeNull(),
  );
});

describe("observeGatewayResponse", () => {
  it("retains cached-response and safe HTTP metadata", async () => {
    await observeGatewayResponse(
      new Request("http://localhost/api/proxy/backup"),
      new Response("{}", {
        headers: {
          "x-data-source": "cached",
          etag: '"revision-4"',
          "cache-control": "private, max-age=5",
          "content-disposition": 'attachment; filename="backup.json"',
        },
      }),
    );

    expect(getGatewayMetadataSnapshot()).toMatchObject({
      cachedResponse: { url: "http://localhost/api/proxy/backup" },
      etag: '"revision-4"',
      cacheControl: "private, max-age=5",
      contentDisposition: 'attachment; filename="backup.json"',
    });
  });

  it("classifies a pre-commit 503 without polling or replay", async () => {
    const fetchStatus = vi.fn();
    setApplyStatusFetcher(fetchStatus);
    await observeGatewayResponse(
      mutationRequest(),
      new Response(JSON.stringify({ error: "temporarily unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "3" },
      }),
    );

    expect(fetchStatus).not.toHaveBeenCalled();
    expect(getGatewayMetadataSnapshot().apply).toMatchObject({
      state: "nothing_applied",
      cursor: null,
      retryAfter: "3",
      polling: false,
    });
  });

  it("polls a committed-not-live cursor until it is applied", async () => {
    const fetchStatus = vi.fn().mockResolvedValue({
      topology_epoch: "4",
      sequence: "9",
      state: "applied",
      accepted_topology_epoch: "4",
      accepted_sequence: "9",
    });
    setApplyStatusFetcher(fetchStatus);
    await observeGatewayResponse(
      mutationRequest(),
      new Response(
        JSON.stringify({
          error: "reload timed out",
          applied: false,
          reason: "reload_timeout",
        }),
        {
          status: 503,
          headers: {
            "content-type": "application/json",
            "x-ferrum-config-cursor": "4:9",
          },
        },
      ),
    );

    await vi.waitFor(() => {
      expect(getGatewayMetadataSnapshot().apply.state).toBe("applied");
    });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    // A fleet-global mutation carried no namespace, so neither does its poll.
    expect(fetchStatus).toHaveBeenCalledWith("4", "9", 25_000, null);
  });

  it("polls under the namespace the originating mutation was bound to", async () => {
    const fetchStatus = vi.fn().mockResolvedValue({
      topology_epoch: "4",
      sequence: "9",
      state: "applied",
      accepted_topology_epoch: "4",
      accepted_sequence: "9",
    });
    setApplyStatusFetcher(fetchStatus);
    await observeGatewayResponse(
      mutationRequest("tenant-a"),
      new Response(JSON.stringify({ id: "p-1" }), {
        status: 202,
        headers: {
          "content-type": "application/json",
          "x-ferrum-config-cursor": "4:9",
        },
      }),
    );

    await vi.waitFor(() => {
      expect(getGatewayMetadataSnapshot().apply.state).toBe("applied");
    });
    // The poll is a follow-up of the mutation and inherits its binding; it
    // must not pick up whatever namespace the tab has switched to since.
    expect(fetchStatus).toHaveBeenCalledWith("4", "9", 25_000, "tenant-a");
  });

  it("does not claim liveness when committed response has no cursor", async () => {
    await observeGatewayResponse(
      mutationRequest(),
      new Response(
        JSON.stringify({ applied: false, reason: "sequence_unavailable" }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    );

    expect(getGatewayMetadataSnapshot().apply).toMatchObject({
      state: "unverifiable",
      reason: "sequence_unavailable",
      polling: false,
    });
  });

  it("continues a deferred cursor through pending to rejection", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({ state: "pending" })
      .mockResolvedValueOnce({ state: "rejected" });
    setApplyStatusFetcher(fetchStatus);
    await observeGatewayResponse(
      mutationRequest(),
      new Response("{}", {
        status: 202,
        headers: { "x-ferrum-config-cursor": "5:12" },
      }),
    );

    await vi.waitFor(() => {
      expect(getGatewayMetadataSnapshot().apply.state).toBe("rejected");
    });
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("does not let an older poll overwrite a newer mutation result", async () => {
    let resolveStatus!: (value: {
      topology_epoch: string;
      sequence: string;
      state: "applied";
      accepted_topology_epoch: string;
      accepted_sequence: string;
    }) => void;
    setApplyStatusFetcher(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    await observeGatewayResponse(
      mutationRequest(),
      new Response("{}", {
        status: 202,
        headers: { "x-ferrum-config-cursor": "6:14" },
      }),
    );
    await observeGatewayResponse(
      mutationRequest(),
      new Response(JSON.stringify({ error: "write gate unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    resolveStatus({
      topology_epoch: "6",
      sequence: "14",
      state: "applied",
      accepted_topology_epoch: "6",
      accepted_sequence: "14",
    });
    await Promise.resolve();

    expect(getGatewayMetadataSnapshot().apply.state).toBe("nothing_applied");
  });

  it("retires an older poll when a later success has no apply cursor", async () => {
    let resolveStatus!: (value: {
      topology_epoch: string;
      sequence: string;
      state: "applied";
      accepted_topology_epoch: string;
      accepted_sequence: string;
    }) => void;
    setApplyStatusFetcher(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    await observeGatewayResponse(
      mutationRequest(),
      new Response("{}", {
        status: 202,
        headers: { "x-ferrum-config-cursor": "7:21" },
      }),
    );

    await observeGatewayResponse(
      mutationRequest(),
      new Response(null, { status: 204 }),
    );
    expect(getGatewayMetadataSnapshot().apply).toMatchObject({
      state: "succeeded",
      cursor: null,
      polling: false,
    });

    resolveStatus({
      topology_epoch: "7",
      sequence: "21",
      state: "applied",
      accepted_topology_epoch: "7",
      accepted_sequence: "21",
    });
    await Promise.resolve();

    expect(getGatewayMetadataSnapshot().apply.state).toBe("succeeded");
  });
});
