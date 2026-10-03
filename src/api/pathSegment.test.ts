import { describe, expect, it } from "vitest";
import { pathSegment } from "./pathSegment";

describe("pathSegment", () => {
  it.each([
    ["/", "%2F"],
    ["%2F", "%252F"],
    ["?", "%3F"],
    ["#", "%23"],
  ])("keeps %j inside one path segment", (id, encoded) => {
    const url = new URL(`https://example.test/api/proxies/${pathSegment(id)}`);

    expect(url.pathname).toBe(`/api/proxies/${encoded}`);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  it.each(["", ".", ".."])("rejects the dot segment %j", (id) => {
    expect(() => pathSegment(id)).toThrow(TypeError);
  });
});
