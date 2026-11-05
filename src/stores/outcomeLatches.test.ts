import { afterEach, describe, expect, it, vi } from "vitest";
import { correlationId, documentHash, settledBy } from "./outcomeLatches";

afterEach(() => vi.unstubAllGlobals());

describe("documentHash", () => {
  it("is the lowercase-hex SHA-256 of the UTF-8 document, as Edge's content_hash", async () => {
    expect(await documentHash("document A")).toBe(
      "09fb3f175100d052d86fa9ae67e5dedf94d2c239d1bfec4da5f3e217585652b4",
    );
  });

  it("gives no hash where Web Crypto has no digest", async () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes });
    expect(await documentHash("document A")).toBeNull();
  });
});

describe("correlationId", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("falls back to getRandomValues outside a secure context", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff),
    });
    expect(correlationId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(correlationId()).toMatch(UUID_V4);
  });

  it("fails before anything is sent when the browser has no Web Crypto", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => correlationId()).toThrow();
  });
});

describe("api_spec_import latch", () => {
  const spec = (id: string, contentHash: string) => ({
    id, proxy_id: `proxy-${id}`, title: id, spec_version: "3.1.0", spec_format: "yaml" as const,
    info_version: null, description: null, contact_name: null, contact_email: null,
    license_name: null, license_identifier: null, tags: [], server_urls: [], operation_count: 1,
    uncompressed_size: 1, content_hash: contentHash,
    created_at: "2026-09-06T00:00:00Z", updated_at: "2026-09-06T00:00:00Z",
  });
  const latch = (knownIds: readonly string[] | null) => ({
    kind: "api_spec_import" as const, namespace: "tenant-a", message: "unknown",
    contentHash: "sent", knownIds,
  });

  it("settles only on a spec holding the sent document that a complete read did not list", () => {
    const observation = { apiSpecs: { namespace: "tenant-a", specs: [spec("old", "sent"), spec("new", "sent")] } };
    expect(settledBy(latch(["old"]), observation)).toBe(true);
    expect(settledBy(latch(["old", "new"]), observation)).toBe(false);
    // After only a partial read, a matching spec may have existed all along.
    expect(settledBy(latch(null), observation)).toBe(false);
    expect(settledBy(latch([]), { apiSpecs: { namespace: "tenant-b", specs: [spec("new", "sent")] } })).toBe(false);
  });
});

describe("api_spec_replace latch", () => {
  const observed = (contentHash: string) => ({
    apiSpecs: {
      namespace: "tenant-a",
      specs: [{
        id: "A", proxy_id: "proxy-A", title: "A", spec_version: "3.1.0", spec_format: "yaml" as const,
        info_version: null, description: null, contact_name: null, contact_email: null,
        license_name: null, license_identifier: null, tags: [], server_urls: [], operation_count: 1,
        uncompressed_size: 1, content_hash: contentHash,
        created_at: "2026-09-06T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
      }],
    },
  });
  const latch = (priorHashes: readonly string[] | null) => ({
    kind: "api_spec_replace" as const, namespace: "tenant-a", message: "unknown",
    specId: "A", contentHash: "sent", priorHashes,
  });

  it("settles only on content the target did not hold before the request", () => {
    expect(settledBy(latch(["summary", "fresh"]), observed("sent"))).toBe(true);
    expect(settledBy(latch(["summary", "fresh"]), observed("other"))).toBe(false);
    // An unchanged resubmission looks exactly like what was already stored.
    expect(settledBy(latch(["summary", "sent"]), observed("sent"))).toBe(false);
    // Without the dialog's fresh read there is no trustworthy baseline.
    expect(settledBy(latch(null), observed("sent"))).toBe(false);
  });
});
