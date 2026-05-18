import { describe, expect, it } from "vitest";
import { extractApiErrorDetail, getApiErrorMessage } from "./client";

describe("extractApiErrorDetail", () => {
  it("returns empty string for empty body", () => {
    expect(extractApiErrorDetail("")).toBe("");
  });

  it("returns empty string for whitespace-only body", () => {
    expect(extractApiErrorDetail("   \n\t ")).toBe("");
  });

  it("extracts `error` field from JSON body", () => {
    expect(
      extractApiErrorDetail(JSON.stringify({ error: "proxy not found" })),
    ).toBe("proxy not found");
  });

  it("extracts `message` field from JSON body", () => {
    expect(
      extractApiErrorDetail(JSON.stringify({ message: "invalid payload" })),
    ).toBe("invalid payload");
  });

  it("extracts `detail` field from JSON body", () => {
    expect(
      extractApiErrorDetail(JSON.stringify({ detail: "rate limit exceeded" })),
    ).toBe("rate limit exceeded");
  });

  it("prefers `error` over `message` and `detail`", () => {
    expect(
      extractApiErrorDetail(
        JSON.stringify({ error: "e", message: "m", detail: "d" }),
      ),
    ).toBe("e");
  });

  it("prefers `message` over `detail` when `error` is absent", () => {
    expect(
      extractApiErrorDetail(JSON.stringify({ message: "m", detail: "d" })),
    ).toBe("m");
  });

  it("falls back to raw body when JSON has no recognized field", () => {
    const body = JSON.stringify({ status: "fail" });
    expect(extractApiErrorDetail(body)).toBe(body);
  });

  it("falls back to raw body when JSON value of recognized field is not a string", () => {
    const body = JSON.stringify({ error: { code: 42 } });
    expect(extractApiErrorDetail(body)).toBe(body);
  });

  it("returns plain-text bodies unchanged", () => {
    expect(extractApiErrorDetail("Internal Server Error")).toBe(
      "Internal Server Error",
    );
  });

  it("returns body unchanged for malformed JSON", () => {
    expect(extractApiErrorDetail("{not valid json")).toBe("{not valid json");
  });

  it("returns body unchanged when JSON parses to null", () => {
    expect(extractApiErrorDetail("null")).toBe("null");
  });
});

describe("getApiErrorMessage", () => {
  it("returns fallback when input is not an Error", async () => {
    expect(await getApiErrorMessage("oops", "fallback")).toBe("fallback");
    expect(await getApiErrorMessage(undefined, "fallback")).toBe("fallback");
    expect(await getApiErrorMessage(null, "fallback")).toBe("fallback");
    expect(await getApiErrorMessage({ message: "x" }, "fallback")).toBe(
      "fallback",
    );
  });

  it("returns the Error message when there is no `response`", async () => {
    const err = new Error("network down");
    expect(await getApiErrorMessage(err, "fallback")).toBe("network down");
  });

  it("appends server detail when `response` has a JSON error body", async () => {
    const response = new Response(
      JSON.stringify({ error: "duplicate name" }),
      { status: 409 },
    );
    const err = Object.assign(new Error("HTTP 409"), { response });

    expect(await getApiErrorMessage(err, "fallback")).toBe(
      "HTTP 409: duplicate name",
    );
  });

  it("appends server detail when `response` has a plain-text body", async () => {
    const response = new Response("upstream unreachable", { status: 502 });
    const err = Object.assign(new Error("Bad Gateway"), { response });

    expect(await getApiErrorMessage(err, "fallback")).toBe(
      "Bad Gateway: upstream unreachable",
    );
  });

  it("returns just the Error message when `response` body is empty", async () => {
    const response = new Response("", { status: 500 });
    const err = Object.assign(new Error("Server Error"), { response });

    expect(await getApiErrorMessage(err, "fallback")).toBe("Server Error");
  });

  it("does not consume the original response body (uses clone)", async () => {
    const response = new Response(JSON.stringify({ message: "boom" }), {
      status: 400,
    });
    const err = Object.assign(new Error("Bad Request"), { response });

    await getApiErrorMessage(err, "fallback");

    // The caller should still be able to read the body afterwards.
    expect(response.bodyUsed).toBe(false);
    await expect(response.json()).resolves.toEqual({ message: "boom" });
  });
});
