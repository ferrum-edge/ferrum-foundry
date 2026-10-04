import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApiErrorMessage, setApiErrorHandler } from "@/api/client";
import {
  GATEWAY_TARGET_HEADER,
  isGatewayTargetRetired,
  observeGatewayTarget,
  resetGatewayTarget,
} from "@/api/gatewayTarget";
import { getGatewayMetadataSnapshot, resetGatewayMetadata } from "@/api/gatewayMetadata";
import { BackupRestoreCard } from "@/components/forms/BackupRestoreCard";
import {
  NAMESPACE_STORAGE_KEY,
  NamespaceProvider,
  useNamespace,
} from "@/stores/namespace";
import { click, createHarness, settle, stubFetch } from "@/test/__tests__/harness";
import { useBackup } from "./useOps";

vi.mock("@/stores/auth", () => ({ useAuth: () => ({ principal: null }) }));

const SECRET = "synthetic-backup-credential-0123456789";
const BACKUP = {
  version: "1",
  counts: { proxies: 1, consumers: 1, plugin_configs: 1, upstreams: 0, extra: SECRET },
  proxies: [{ id: "proxy-1" }],
  consumers: [{ id: "consumer-1", credentials: { keyauth: [{ key: SECRET }] } }],
  plugin_configs: [{ plugin_name: "custom", config: { value: SECRET } }],
  upstreams: [],
  api_specs: [{ spec_content: SECRET }],
};
const OBJECT_URL = "blob:http://localhost/synthetic-backup";
const createUrl = vi.fn((_blob: Blob | MediaSource) => OBJECT_URL);
const revokeUrl = vi.fn((_url: string) => undefined);
const popup = vi.fn();
const downloads: Array<{ filename: string; href: string }> = [];
let ui: ReturnType<typeof createHarness>;
let mutation: ReturnType<typeof useBackup>;
let namespace: ReturnType<typeof useNamespace>;

function Probe() {
  const backup = useBackup();
  const selection = useNamespace();
  useEffect(() => {
    mutation = backup;
    namespace = selection;
  }, [backup, selection]);
  return <p>{selection.selectedNamespace}</p>;
}

function answer(body: unknown = BACKUP, target = "target-a"): Response {
  return Response.json(body, { headers: { [GATEWAY_TARGET_HEADER]: target } });
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read fixture Blob"));
    reader.readAsText(blob);
  });
}

function assertSafeState() {
  const [stored] = ui.client.getMutationCache().getAll();
  expect(stored).toBeDefined();
  expect(stored.options.gcTime).toBe(0);
  expect(JSON.stringify(stored.state)).not.toContain(SECRET);
  expect(ui.client.getQueryCache().getAll()).toHaveLength(0);
  expect(JSON.stringify(getGatewayMetadataSnapshot())).not.toContain(SECRET);
  expect(JSON.stringify(popup.mock.calls)).not.toContain(SECRET);
  expect(ui.host.textContent).not.toContain(SECRET);
  expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
  return stored;
}

beforeEach(() => {
  resetGatewayTarget();
  resetGatewayMetadata();
  observeGatewayTarget("target-a");
  localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
  createUrl.mockClear();
  revokeUrl.mockClear();
  popup.mockClear();
  downloads.length = 0;
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      downloads.push({ filename: this.download, href: this.href });
    },
  );
  setApiErrorHandler(popup);
  stubFetch(() => answer());
  ui = createHarness();
});

afterEach(async () => {
  await ui.dispose();
  setApiErrorHandler(undefined);
  resetGatewayTarget();
  resetGatewayMetadata();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("backup download through the real mutation and card", () => {
  it("downloads unredacted JSON and keeps only counts until mutation disposal", async () => {
    const requests: Request[] = [];
    stubFetch((request) => {
      requests.push(request);
      return answer();
    });
    await ui.render(
      <NamespaceProvider>
        <Probe />
      </NamespaceProvider>,
    );
    const observedData: unknown[] = [];
    const unsubscribe = ui.client.getMutationCache().subscribe((event) => {
      if (event.mutation) observedData.push(event.mutation.state.data);
    });
    let result: unknown;
    let completion: unknown;
    await act(async () => {
      result = await mutation.mutateAsync(
        { namespace: namespace.scope.namespace, resources: ["consumers"] },
        {
          onSuccess: (data) => {
            completion = data;
          },
        },
      );
    });
    expect(result).toEqual({ proxies: 1, consumers: 1 });
    expect(completion).toEqual(result);
    await settle(() => expect(mutation.data).toEqual(result));
    expect(observedData.filter((data) => data !== undefined).length).toBeGreaterThan(0);
    for (const data of observedData) {
      if (data !== undefined) expect(data).toEqual(result);
    }
    expect(JSON.stringify(observedData)).not.toContain(SECRET);
    unsubscribe();
    const stored = assertSafeState();
    expect(stored.state.data).toEqual(result);
    expect(stored.state.variables).toEqual({ namespace: "tenant-a", resources: ["consumers"] });
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("x-ferrum-namespace")).toBe("tenant-a");
    expect(requests[0].headers.get(GATEWAY_TARGET_HEADER)).toBe("target-a");
    expect(new URL(requests[0].url).searchParams.get("resources")).toBe("consumers");
    expect(createUrl).toHaveBeenCalledTimes(1);
    const blob = createUrl.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("application/json");
    expect(JSON.parse(await blobText(blob))).toEqual(BACKUP);
    expect(downloads).toEqual([
      {
        filename: `ferrum-backup-tenant-a-${new Date().toISOString().slice(0, 10)}.json`,
        href: OBJECT_URL,
      },
    ]);
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    await ui.render(<p>elsewhere</p>);
    await settle(() => expect(ui.client.getMutationCache().getAll()).toHaveLength(0));
  });

  it("binds the card's request and download across a namespace switch", async () => {
    let release!: (response: Response) => void;
    const requests: Request[] = [];
    stubFetch((request) => {
      requests.push(request);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    await ui.render(
      <NamespaceProvider>
        <Probe />
        <BackupRestoreCard />
      </NamespaceProvider>,
    );
    await click("Download Backup", ui.host);
    await settle(() => expect(requests).toHaveLength(1));
    await act(async () => {
      namespace.setNamespace("tenant-b");
    });
    await act(async () => {
      release(answer());
    });
    await settle(() => {
      expect(ui.host.textContent).toContain(
        'Backup exported for namespace "tenant-a" (1 proxies, 1 consumers)',
      );
    });
    expect(namespace.selectedNamespace).toBe("tenant-b");
    expect(requests[0].headers.get("x-ferrum-namespace")).toBe("tenant-a");
    expect(requests[0].headers.get(GATEWAY_TARGET_HEADER)).toBe("target-a");
    expect(downloads[0].filename).toMatch(/^ferrum-backup-tenant-a-/);
    expect(ui.host.textContent).toContain("Credentials are UNREDACTED — store securely.");
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    expect(assertSafeState().state.data).toEqual({ proxies: 1, consumers: 1 });
  });

  it("captures the namespace before Query can defer the mutation function", async () => {
    const requests: Request[] = [];
    stubFetch((request) => {
      requests.push(request);
      return answer();
    });
    await ui.render(
      <NamespaceProvider>
        <Probe />
      </NamespaceProvider>,
    );
    let pending!: ReturnType<typeof mutation.mutateAsync>;
    await act(async () => {
      pending = mutation.mutateAsync({ namespace: namespace.scope.namespace });
      namespace.setNamespace("tenant-b");
      await pending;
    });
    expect(requests[0].headers.get("x-ferrum-namespace")).toBe("tenant-a");
    expect(downloads[0].filename).toMatch(/^ferrum-backup-tenant-a-/);
    expect(assertSafeState().state.variables).toEqual({ namespace: "tenant-a" });
  });

  it.each(["setup", "click"])("revokes the object URL when anchor %s throws", async (phase) => {
    await ui.render(
      <NamespaceProvider>
        <Probe />
      </NamespaceProvider>,
    );
    const failure = () => {
      throw Object.assign(new Error(`download failed: ${SECRET}`), { data: BACKUP });
    };
    if (phase === "click") {
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(failure);
    } else {
      const original = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
        if (tag === "a") return failure();
        return original(tag, options);
      });
    }
    let error: unknown;
    await act(async () => {
      error = await mutation
        .mutateAsync({ namespace: "tenant-a" })
        .catch((reason: unknown) => reason);
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Backup download failed. Try the download again.");
    expect((error as Error).stack).not.toContain(SECRET);
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    expect(downloads).toHaveLength(0);
    const stored = assertSafeState();
    expect(stored.state.status).toBe("error");
    expect(stored.state.data).toBeUndefined();
    expect(popup).not.toHaveBeenCalled();
  });

  const failures = ["json", "text", "parse", "network", "timeout"];
  it.each(failures)("sanitizes %s failures before card diagnostics", async (kind) => {
    const fetchMock = stubFetch(() => {
      if (kind === "network" || kind === "timeout") {
        throw Object.assign(new Error(SECRET), {
          name: kind === "timeout" ? "TimeoutError" : "Error",
          data: BACKUP,
          cause: BACKUP,
        });
      }
      if (kind === "parse") {
        return new Response(`{"key":"${SECRET}" invalid`, {
          headers: { "content-type": "application/json" },
        });
      }
      if (kind === "text") return new Response(`backup failed: ${SECRET}`, { status: 502 });
      return Response.json(
        { error: `backup failed: ${SECRET}`, backup: BACKUP },
        { status: 500, headers: { "x-sensitive-error": SECRET } },
      );
    });
    await ui.render(
      <NamespaceProvider>
        <Probe />
        <BackupRestoreCard />
      </NamespaceProvider>,
    );
    await click("Download Backup", ui.host);
    const diagnostic =
      kind === "timeout"
        ? "Backup export timed out"
        : kind === "parse" || kind === "network"
          ? "Backup download failed"
          : "Backup export failed";
    await settle(() => expect(ui.host.textContent).toContain(diagnostic));
    const stored = assertSafeState();
    expect(stored.state.status).toBe("error");
    expect(stored.state.data).toBeUndefined();
    const error = stored.state.error as Error & {
      response?: Response;
      data?: unknown;
      request?: unknown;
      options?: unknown;
      cause?: unknown;
    };
    expect(error.message).not.toContain(SECRET);
    expect(error.stack).not.toContain(SECRET);
    expect(error.data).toBeUndefined();
    expect(error.request).toBeUndefined();
    expect(error.options).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(await getApiErrorMessage(error, "Backup failed")).not.toContain(SECRET);
    if (kind === "json" || kind === "text") {
      expect(error.response?.status).toBe(kind === "json" ? 500 : 502);
      expect(await error.response!.text()).toBe("");
      expect(error.response!.headers.has("x-sensitive-error")).toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createUrl).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
  });

  const invalidCounts = [SECRET, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
  it.each(invalidCounts)("refuses an unsafe count %#", async (count) => {
    stubFetch(() => answer({ ...BACKUP, counts: { ...BACKUP.counts, consumers: count } }));
    await ui.render(
      <NamespaceProvider>
        <Probe />
      </NamespaceProvider>,
    );
    await act(async () => {
      await expect(mutation.mutateAsync({ namespace: "tenant-a" })).rejects.toThrow(
        "Backup download failed",
      );
    });
    expect(createUrl).not.toHaveBeenCalled();
    expect(assertSafeState().state.data).toBeUndefined();
  });

  it.each(["response", "session"])("refuses a %s target change", async (source) => {
    let release!: (response: Response) => void;
    const requests: Request[] = [];
    stubFetch((request) => {
      requests.push(request);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    await ui.render(
      <NamespaceProvider>
        <Probe />
      </NamespaceProvider>,
    );
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = mutation
        .mutateAsync({ namespace: "tenant-a" })
        .catch((error: unknown) => error);
    });
    await settle(() => expect(requests).toHaveLength(1));
    await act(async () => {
      if (source === "session") observeGatewayTarget("target-b");
      release(answer(BACKUP, source === "response" ? "target-b" : "target-a"));
      const error = await pending;
      expect(error).toMatchObject({ name: "GatewayTargetChangedError" });
    });
    expect(requests[0].headers.get(GATEWAY_TARGET_HEADER)).toBe("target-a");
    expect(isGatewayTargetRetired()).toBe(true);
    expect(createUrl).not.toHaveBeenCalled();
    expect(revokeUrl).not.toHaveBeenCalled();
    expect(assertSafeState().state.data).toBeUndefined();
  });

  it("sends no request after the captured page target is retired", async () => {
    const fetchMock = stubFetch(() => answer());
    await ui.render(
      <NamespaceProvider>
        <Probe />
      </NamespaceProvider>,
    );
    observeGatewayTarget("target-b");
    await act(async () => {
      await expect(mutation.mutateAsync({ namespace: "tenant-a" })).rejects.toMatchObject({
        name: "GatewayTargetChangedError",
      });
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
    assertSafeState();
  });
});
