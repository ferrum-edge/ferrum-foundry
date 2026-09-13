import { isHTTPError } from "ky";
import { afterEach, expect, it, vi } from "vitest";
import { api, getApiErrorDetail } from "@/api/client";
import { stubFetch } from "./harness";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["JSON", '{"host":"orders.api.svc","port":443}', "application/json"],
  ["YAML", "openapi: 3.1.0\n", "application/yaml"],
])("retains %s payloads after completed writes and reuses a response fixture", async (_format, body, contentType) => {
  const requests: Request[] = [];
  const receivedBodies: string[] = [];
  const accepted = { accepted: true };
  const response = Response.json(accepted);
  const fetchMock = stubFetch(async (request) => {
    requests.push(request);
    receivedBodies.push(await request.clone().text());
    return response;
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await api.post("api/fixture", {
      body, headers: { "content-type": contentType },
    }).json()).toEqual(accepted);
    expect(fetchMock).toHaveBeenCalledTimes(attempt + 1);
  }

  expect(receivedBodies).toEqual([body, body]);
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe(contentType);
    expect(request.bodyUsed).toBe(false);
    expect(await request.text()).toBe(body);
  }
  expect(response.bodyUsed).toBe(false);
});

it("preserves rejected payloads and error details across repeated response fixtures", async () => {
  const requests: Request[] = [];
  const response = Response.json({ error: "host: invalid destination" }, { status: 400 });
  const fetchMock = stubFetch((request) => {
    requests.push(request);
    return response;
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const error = await api.post("api/fixture", { json: { host: "invalid host" } })
      .json().catch((failure: unknown) => failure);
    expect(isHTTPError(error)).toBe(true);
    if (!isHTTPError(error)) throw new Error("Expected an HTTP rejection");
    expect(error.response.bodyUsed).toBe(true);
    expect(await getApiErrorDetail(error)).toBe("host: invalid destination");
    expect(fetchMock).toHaveBeenCalledTimes(attempt + 1);
  }

  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.bodyUsed).toBe(false);
    expect(await request.json()).toEqual({ host: "invalid host" });
  }
  expect(response.bodyUsed).toBe(false);
});
