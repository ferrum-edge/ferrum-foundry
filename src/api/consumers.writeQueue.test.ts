import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendCredential, deleteCredentialByIndex, update } from "./consumers";
import { resetGatewayMetadata } from "./gatewayMetadata";

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" && input.startsWith("/")
      ? new URL(input, "http://localhost") : input, init);
  }
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const scope = { namespace: "tenant-a" };

describe("consumer full-replace write coordination", () => {
  beforeEach(() => {
    resetGatewayMetadata();
    vi.stubGlobal("Request", BasedRequest);
  });
  afterEach(() => {
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  it.each(["append", "delete"])("reads after an in-flight %s and preserves the current credential projection", async (operation) => {
    const started = barrier();
    const finish = barrier();
    const methods: string[] = [];
    let entries = [{ key: "redacted" }];
    let submitted: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      methods.push(request.method);
      expect(request.headers.get("X-Ferrum-Namespace")).toBe("tenant-a");
      if (request.method === "POST" || request.method === "DELETE") {
        started.release();
        await finish.promise;
        entries = operation === "append" ? [entries[0], { key: "redacted" }] : [];
        return operation === "append"
          ? Response.json({ id: "alice", credentials: { keyauth: entries } })
          : new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        return Response.json({ id: "alice", credentials: { keyauth: entries } });
      }
      submitted = await request.json() as Record<string, unknown>;
      return Response.json(submitted);
    }));
    const rotation = operation === "append"
      ? appendCredential(scope, "alice", "keyauth", { key: "new-key" })
      : deleteCredentialByIndex(scope, "alice", "keyauth", 0);
    await started.promise;
    const metadata = update(scope, "alice", {
      username: "alice", acl_groups: ["new-group"],
      credentials: { keyauth: [{ key: "stale-editor-value" }] },
    });
    expect(methods).toEqual([operation === "append" ? "POST" : "DELETE"]);
    finish.release();
    await Promise.all([rotation, metadata]);
    expect(methods).toEqual([operation === "append" ? "POST" : "DELETE", "GET", "PUT"]);
    expect(submitted).toEqual({
      id: "alice", username: "alice", acl_groups: ["new-group"],
      credentials: { keyauth: entries },
    });
    expect(entries).toHaveLength(operation === "append" ? 2 : 0);
  });

  it("releases a failed write and does not block the same id in another namespace", async () => {
    const started = barrier();
    const finish = barrier();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const tenant = request.headers.get("X-Ferrum-Namespace");
      calls.push(`${tenant} ${request.method}`);
      if (request.method === "DELETE") {
        started.release();
        await finish.promise;
        return new Response("ambiguous failure", { status: 502 });
      }
      return Response.json({ id: "alice", username: "alice", credentials: {} });
    }));
    const failed = expect(deleteCredentialByIndex(scope, "alice", "keyauth", 0))
      .rejects.toMatchObject({ response: { status: 502 } });
    await started.promise;
    const queued = update(scope, "alice", { username: "alice" });
    await update({ namespace: "tenant-b" }, "alice", { username: "alice" });
    expect(calls).toEqual(["tenant-a DELETE", "tenant-b GET", "tenant-b PUT"]);
    finish.release();
    await failed;
    await queued;
    expect(calls).toEqual([
      "tenant-a DELETE", "tenant-b GET", "tenant-b PUT", "tenant-a GET", "tenant-a PUT",
    ]);
  });

  it("does not PUT if the current credential projection cannot be read", async () => {
    const fetcher = vi.fn(async () => new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(update(scope, "alice", { username: "alice" }))
      .rejects.toMatchObject({ response: { status: 404 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown as [Request])[0].method).toBe("GET");
  });
});
