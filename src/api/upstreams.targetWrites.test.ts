import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { update, updateTargets } from "./upstreams";
import { resetGatewayMetadata } from "./gatewayMetadata";
import type { Upstream } from "./types";

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
const targets = [{ host: "new.internal", port: 8443, weight: 1 }];
const settings = {
  algorithm: "round_robin" as const,
  targets: [{ host: "old.internal", port: 443, weight: 1 }],
  health_checks: { active: { probe_type: "http" as const, http_path: "/new-ready", interval_seconds: 5 } },
  service_discovery: {
    provider: "kubernetes" as const,
    kubernetes: { service_name: "payments", namespace: "prod", poll_interval_seconds: 15 },
  },
  subsets: [{ name: "v2", labels: { version: "v2" } }],
  backend_tls_sni: "payments.internal",
  backend_tls_san_allow_list: ["payments.internal"],
};

describe("upstream target writes", () => {
  beforeEach(() => {
    resetGatewayMetadata();
    vi.stubGlobal("Request", BasedRequest);
  });
  afterEach(() => {
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  it("waits for Settings and preserves its accepted policy during a target add", async () => {
    const started = barrier();
    const finish = barrier();
    const calls: string[] = [];
    const bodies: unknown[] = [];
    let current: Upstream = {
      id: "payments", namespace: "tenant-a", algorithm: "round_robin", targets: [],
      created_at: "v0", updated_at: "v0",
    };
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      expect(request.headers.get("X-Ferrum-Namespace")).toBe("tenant-a");
      calls.push(request.method);
      if (request.method === "PUT") {
        const body = await request.json() as Partial<Upstream>;
        bodies.push(body);
        if (bodies.length === 1) {
          started.release();
          await finish.promise;
        }
        current = { ...current, ...body };
      }
      return Response.json(current);
    }));
    const saving = update(scope, "payments", settings);
    await started.promise;
    const adding = updateTargets(scope, "payments", targets);
    expect(calls).toEqual(["PUT"]);
    finish.release();
    await Promise.all([saving, adding]);
    expect(calls).toEqual(["PUT", "GET", "PUT"]);
    expect(bodies[1]).toEqual({ ...settings, id: "payments", targets });
    expect(current.health_checks).toEqual(settings.health_checks);
    expect(current.targets).toEqual(targets);
  });

  it("does not submit a target PUT after a failed fresh GET", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      expect(request.method).toBe("GET");
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(updateTargets(scope, "payments", targets))
      .rejects.toMatchObject({ response: { status: 404 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("releases failed writes and keeps another namespace independent", async () => {
    const started = barrier();
    const finish = barrier();
    const calls: string[] = [];
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const tenant = request.headers.get("X-Ferrum-Namespace");
      calls.push(`${tenant} ${request.method}`);
      if (tenant === "tenant-a" && request.method === "PUT" && fail) {
        fail = false;
        started.release();
        await finish.promise;
        return new Response("ambiguous failure", { status: 502 });
      }
      return Response.json({ ...settings, id: "payments", namespace: tenant });
    }));
    const failed = expect(update(scope, "payments", settings))
      .rejects.toMatchObject({ response: { status: 502 } });
    await started.promise;
    const queued = updateTargets(scope, "payments", targets);
    await updateTargets({ namespace: "tenant-b" }, "payments", targets);
    expect(calls).toEqual(["tenant-a PUT", "tenant-b GET", "tenant-b PUT"]);
    finish.release();
    await failed;
    await queued;
    expect(calls).toEqual([
      "tenant-a PUT", "tenant-b GET", "tenant-b PUT", "tenant-a GET", "tenant-a PUT",
    ]);
  });
});
