import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getGatewayMetadataSnapshot,
  observeGatewayResponse,
  parseConfigCursor,
  resetGatewayMetadata,
  setApplyStatusFetcher,
  setNamespaceScopedSession,
  type ApplyStatusResponse,
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

  it.each([null, "", "1", "1:2:3", "-1:2", "1.5:2", "a:b", "18446744073709551616:1", "1:18446744073709551616"])(
    "rejects malformed cursor %j",
    (value) => expect(parseConfigCursor(value)).toBeNull(),
  );
});

describe("observeGatewayResponse", () => {
  it.each([
    { status: 200, state: "applied", cursor: "1:2", polling: false },
    { status: 400, state: "idle", cursor: null, polling: false },
    { status: 503, state: "pending", cursor: "1:2", polling: true },
    { status: 202, state: "pending", cursor: "1:2", polling: true },
  ])(
    "discards an older delayed 503 after a newer $status mutation",
    async ({ status, state, cursor, polling }) => {
      let bodyController!: ReadableStreamDefaultController<Uint8Array>;
      const olderBody = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
      });
      let resolveStatus!: (value: ApplyStatusResponse) => void;
      const fetchStatus = vi.fn(
        () =>
          new Promise<ApplyStatusResponse>((resolve) => {
            resolveStatus = resolve;
          }),
      );
      setApplyStatusFetcher(fetchStatus);
      const olderObservation = observeGatewayResponse(
        mutationRequest("older"),
        new Response(olderBody, {
          status: 503,
          headers: { "x-ferrum-config-cursor": "1:1" },
        }),
      );

      await observeGatewayResponse(
        mutationRequest("newer"),
        new Response("{}", {
          status,
          headers: { "x-ferrum-config-cursor": "1:2" },
        }),
      );
      const newerSnapshot = getGatewayMetadataSnapshot();
      expect(newerSnapshot.apply).toMatchObject({ state, cursor, polling });

      bodyController.enqueue(
        new TextEncoder().encode(JSON.stringify({ applied: false })),
      );
      bodyController.close();
      await olderObservation;

      // Discard silently: even the snapshot identity remains unchanged.
      expect(getGatewayMetadataSnapshot()).toBe(newerSnapshot);
      expect(fetchStatus).toHaveBeenCalledTimes(polling ? 1 : 0);
      if (polling) {
        expect(fetchStatus).toHaveBeenCalledWith("1", "2", 25_000, "newer");
        resolveStatus({
          topology_epoch: "1",
          sequence: "2",
          state: "applied",
          accepted_topology_epoch: "1",
          accepted_sequence: "2",
        });
        await vi.waitFor(() => {
          expect(getGatewayMetadataSnapshot().apply).toMatchObject({
            state: "applied",
            cursor: "1:2",
            polling: false,
          });
        });
      }
    },
  );

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
      .mockResolvedValueOnce({ state: "pending", topology_epoch: "5", sequence: "12", accepted_topology_epoch: "5", accepted_sequence: "11" })
      .mockResolvedValueOnce({ state: "rejected", topology_epoch: "5", sequence: "12", accepted_topology_epoch: "5", accepted_sequence: "11" });
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

  it("keeps a known commit monitor through a later pre-commit failure", async () => {
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

    expect(getGatewayMetadataSnapshot().apply).toMatchObject({ state: "applied", cursor: "6:14" });
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

  it("stops at once, unmonitored, when the poll is refused after grants changed", async () => {
    // The BFF's namespace route ceiling, and Edge v0.9.16+ for an `ns`-claim
    // JWT, refuse fleet-global apply status with 403; retrying cannot help.
    // The session was read as unscoped, so the poll was sent.
    const fetchStatus = vi.fn().mockRejectedValue(
      Object.assign(new Error("Forbidden"), { response: new Response(null, { status: 403 }) }),
    );
    setApplyStatusFetcher(fetchStatus);
    await observeGatewayResponse(
      mutationRequest("tenant-a"),
      new Response("{}", {
        status: 202,
        headers: { "x-ferrum-config-cursor": "6:3" },
      }),
    );

    await vi.waitFor(() => expect(getGatewayMetadataSnapshot().apply.polling).toBe(false));
    expect(fetchStatus).toHaveBeenCalledOnce();
    expect(getGatewayMetadataSnapshot().apply).toMatchObject({
      state: "unmonitored",
      namespace: "tenant-a",
      cursor: "6:3",
      reason: null,
    });
  });

  describe("a namespace-scoped session", () => {
    // Live-apply status is fleet-global, so a session holding namespace grants
    // never sends the poll the BFF and Edge v0.9.16+ would refuse.
    it("publishes an accepted write as unmonitored without polling", async () => {
      const fetchStatus = vi.fn();
      setApplyStatusFetcher(fetchStatus);
      setNamespaceScopedSession(true);
      await observeGatewayResponse(
        mutationRequest("tenant-a"),
        new Response("{}", { status: 202, headers: { "x-ferrum-config-cursor": "6:3" } }),
      );

      expect(getGatewayMetadataSnapshot().apply).toMatchObject({
        state: "unmonitored",
        namespace: "tenant-a",
        cursor: "6:3",
        reason: null,
        polling: false,
      });
      await Promise.resolve();
      expect(fetchStatus).not.toHaveBeenCalled();
    });

    it.each([
      [{ applied: false, reason: "reload_timeout" }, "reload_timeout"],
      [{ applied: false }, "committed_not_live"],
    ])("keeps a committed-not-live answer's reason without polling (%j)", async (body, reason) => {
      const fetchStatus = vi.fn();
      setApplyStatusFetcher(fetchStatus);
      setNamespaceScopedSession(true);
      await observeGatewayResponse(
        mutationRequest("tenant-a"),
        new Response(JSON.stringify(body), {
          status: 503,
          headers: { "x-ferrum-config-cursor": "6:3" },
        }),
      );

      expect(getGatewayMetadataSnapshot().apply).toMatchObject({
        state: "unmonitored",
        cursor: "6:3",
        reason,
        polling: false,
      });
      expect(fetchStatus).not.toHaveBeenCalled();
    });

    it("still reports a write the gateway applied synchronously as live", async () => {
      const fetchStatus = vi.fn();
      setApplyStatusFetcher(fetchStatus);
      setNamespaceScopedSession(true);
      await observeGatewayResponse(
        mutationRequest("tenant-a"),
        new Response("{}", { status: 200, headers: { "x-ferrum-config-cursor": "6:3" } }),
      );

      expect(getGatewayMetadataSnapshot().apply).toMatchObject({ state: "applied", cursor: "6:3" });
      expect(fetchStatus).not.toHaveBeenCalled();
    });

    it("polls again once the session no longer holds namespace grants", async () => {
      const fetchStatus = vi.fn().mockResolvedValue({
        topology_epoch: "6",
        sequence: "3",
        state: "applied",
        accepted_topology_epoch: "6",
        accepted_sequence: "3",
      });
      setApplyStatusFetcher(fetchStatus);
      setNamespaceScopedSession(true);
      setNamespaceScopedSession(false);
      await observeGatewayResponse(
        mutationRequest("tenant-a"),
        new Response("{}", { status: 202, headers: { "x-ferrum-config-cursor": "6:3" } }),
      );

      await vi.waitFor(() => expect(getGatewayMetadataSnapshot().apply.state).toBe("applied"));
      expect(fetchStatus).toHaveBeenCalledOnce();
    });
  });

  describe("BFF capacity refusals", () => {
    const capacityRefusal = (retryAfter = "1") =>
      Object.assign(new Error("Too Many Requests"), {
        response: new Response(null, {
          status: 429,
          headers: { "retry-after": retryAfter },
        }),
      });
    const applied = {
      topology_epoch: "6",
      sequence: "3",
      state: "applied" as const,
      accepted_topology_epoch: "6",
      accepted_sequence: "3",
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("waits as Retry-After asks, backing off, without counting refusals as failures", async () => {
      vi.useFakeTimers();
      const fetchStatus = vi
        .fn()
        .mockRejectedValueOnce(capacityRefusal())
        .mockRejectedValueOnce(capacityRefusal())
        .mockRejectedValueOnce(capacityRefusal())
        .mockResolvedValueOnce(applied);
      setApplyStatusFetcher(fetchStatus);
      await observeGatewayResponse(
        mutationRequest(),
        new Response("{}", {
          status: 202,
          headers: { "x-ferrum-config-cursor": "6:3" },
        }),
      );

      // 1 s, then 2 s, then 4 s between attempts; never an immediate re-poll.
      await vi.advanceTimersByTimeAsync(900);
      expect(fetchStatus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(fetchStatus).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_700);
      expect(fetchStatus).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(300);
      expect(fetchStatus).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(3_700);
      expect(fetchStatus).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(300);
      expect(fetchStatus).toHaveBeenCalledTimes(4);
      // Three refusals in a row used to exhaust the poll's failure budget.
      expect(getGatewayMetadataSnapshot().apply).toMatchObject({
        state: "applied",
        cursor: "6:3",
        polling: false,
      });
    });

    it("gives up as unavailable once refusals outlast the bounded waits", async () => {
      vi.useFakeTimers();
      const fetchStatus = vi.fn().mockRejectedValue(capacityRefusal("30"));
      setApplyStatusFetcher(fetchStatus);
      await observeGatewayResponse(
        mutationRequest(),
        new Response("{}", {
          status: 202,
          headers: { "x-ferrum-config-cursor": "6:3" },
        }),
      );

      // Four waits capped at 8 s each, then the ordinary three attempts.
      await vi.advanceTimersByTimeAsync(4 * 8_000 + 100);
      expect(fetchStatus).toHaveBeenCalledTimes(4 + 3);
      expect(getGatewayMetadataSnapshot().apply).toMatchObject({
        state: "unverifiable",
        reason: "apply_status_unavailable",
        polling: false,
      });
    });
  });
});
