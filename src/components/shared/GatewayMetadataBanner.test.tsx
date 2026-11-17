import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { observeGatewayResponse, resetGatewayMetadata } from "@/api/gatewayMetadata";
import { GatewayMetadataBanner } from "./GatewayMetadataBanner";

const UNSERVED_PATTERN = /Saved, but this gateway does not route namespace tenant-b\./;
const NEVER_APPLY_PATTERN = /will never apply it/;
const SUCCEEDED_PATTERN = /Configuration request succeeded/;
const WARNING_BORDER_PATTERN = /border-warning\/40/;

afterEach(() => resetGatewayMetadata());

function write(namespace: string): Request {
  return new Request("http://localhost/api/proxy/proxies", {
    method: "POST",
    headers: { "x-ferrum-namespace": namespace },
  });
}

describe("GatewayMetadataBanner", () => {
  it("warns that a write to an unserved namespace will not be routed (#708)", async () => {
    await observeGatewayResponse(
      write("tenant-b"),
      new Response("{}", { status: 201, headers: { "x-ferrum-namespace-unserved": "true" } }),
    );
    const html = renderToStaticMarkup(<GatewayMetadataBanner />);
    expect(html).toMatch(UNSERVED_PATTERN);
    expect(html).toMatch(NEVER_APPLY_PATTERN);
    expect(html).toMatch(WARNING_BORDER_PATTERN);
    expect(html).not.toMatch(SUCCEEDED_PATTERN);
  });

  it("keeps the plain success notice for a cursor-less write to a served namespace", async () => {
    await observeGatewayResponse(write("tenant-a"), new Response("{}", { status: 201 }));
    const html = renderToStaticMarkup(<GatewayMetadataBanner />);
    expect(html).toMatch(SUCCEEDED_PATTERN);
    expect(html).not.toMatch(UNSERVED_PATTERN);
  });
});
