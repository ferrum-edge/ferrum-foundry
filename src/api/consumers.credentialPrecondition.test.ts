import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CredentialListChangedError,
  CredentialSelectionUnverifiableError,
  deleteCredentialByIndex,
} from "./consumers";
import { readTagged, shareTaggedRead, validatorOf } from "./conditionalWrite";
import { resetGatewayMetadata } from "./gatewayMetadata";

class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" && input.startsWith("/")
      ? new URL(input, "http://localhost") : input, init);
  }
}

const scope = { namespace: "tenant-a" };
const DELETE_PATH = "/api/proxy/consumers/alice/credentials/keyauth/0";

/**
 * ferrum-foundry#703 / ferrum-edge#7393: a positional credential delete is
 * conditional on the consumer read the operator selected the position from.
 */
describe("indexed credential delete precondition", () => {
  beforeEach(() => {
    resetGatewayMetadata();
    vi.stubGlobal("Request", BasedRequest);
  });
  afterEach(() => {
    resetGatewayMetadata();
    vi.unstubAllGlobals();
  });

  it("sends the selected read's tag as If-Match", async () => {
    const seen: { method: string; path: string; ifMatch: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        ifMatch: request.headers.get("If-Match"),
      });
      return Response.json({ id: "alice", credentials: {} });
    }));
    await deleteCredentialByIndex(scope, "alice", "keyauth", 0, '"read-1"');
    expect(seen).toEqual([{ method: "DELETE", path: DELETE_PATH, ifMatch: '"read-1"' }]);
  });

  it("turns Edge's 412 into a list-changed refusal and does not resend", async () => {
    // The gateway's consumer moved on after the selection: its tag differs.
    const fetcher = vi.fn(async (request: Request) =>
      request.headers.get("If-Match") === '"current"'
        ? Response.json({ id: "alice", credentials: {} })
        : Response.json({ error: "Consumer 'alice' has changed" }, { status: 412 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(deleteCredentialByIndex(scope, "alice", "keyauth", 0, '"selected"'))
      .rejects.toBeInstanceOf(CredentialListChangedError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([null, "", 'W/"weak"', "unquoted", "*"])(
    "refuses before sending when the selected read has no usable tag (%s)",
    async (tag) => {
      const fetcher = vi.fn(async () => Response.json({}));
      vi.stubGlobal("fetch", fetcher);
      await expect(deleteCredentialByIndex(scope, "alice", "keyauth", 0, tag))
        .rejects.toBeInstanceOf(CredentialSelectionUnverifiableError);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});

describe("shareTaggedRead", () => {
  beforeEach(() => vi.stubGlobal("Request", BasedRequest));
  afterEach(() => vi.unstubAllGlobals());

  async function read(body: unknown, etag?: string) {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json(body, etag ? { headers: { ETag: etag } } : {})));
    return (await readTagged<object>(scope, "consumers/alice")).value;
  }

  it("keeps the newest read's tag on the object structural sharing renders", async () => {
    const first = await read({ id: "alice", credentials: { keyauth: [{ key: "x" }] } }, '"one"');
    // Equal content: the previous object is kept and takes the newer tag.
    const same = await read({ id: "alice", credentials: { keyauth: [{ key: "x" }] } }, '"two"');
    expect(shareTaggedRead(first, same)).toBe(first);
    expect(validatorOf(first)).toBe('"two"');
    // Changed content: a merged copy is rendered and carries the new read's tag.
    const changed = await read(
      { id: "alice", credentials: { keyauth: [{ key: "x" }, { key: "y" }] } }, '"three"');
    const rendered = shareTaggedRead(first, changed) as object;
    expect(validatorOf(rendered)).toBe('"three"');
  });

  it("leaves the rendered object untagged after an untagged read", async () => {
    const first = await read({ id: "alice", updated_at: "v1" }, '"one"');
    const untagged = await read({ id: "alice", updated_at: "v1" });
    expect(shareTaggedRead(first, untagged)).toBe(first);
    expect(validatorOf(first)).toBeNull();
  });
});
