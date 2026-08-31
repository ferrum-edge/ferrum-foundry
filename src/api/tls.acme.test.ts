import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAcmeCertificate,
  getAcmeCertificate,
  removeAcmeCertificate,
  updateAcmeCertificate,
  type AcmeCertificateRequest,
} from "./tls";

interface CapturedRequest {
  url: string;
  method: string;
  namespace: string | null;
  body: unknown;
}

describe("ACME certificate API wiring", () => {
  const captured: CapturedRequest[] = [];
  class BasedRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (typeof input === "string" && input.startsWith("/")) {
        input = new URL(input, "http://localhost").toString();
      }
      super(input, init);
    }
  }

  const request: AcmeCertificateRequest = {
    id: "edge-cert",
    domains: ["example.com"],
    directory_url: "https://ca.example/directory",
    cert_pem: "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----",
    key_pem: "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----",
  };

  beforeEach(() => {
    captured.length = 0;
    vi.stubGlobal("Request", BasedRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        const outgoing = input instanceof Request ? input : new Request(String(input));
        const text = await outgoing.clone().text();
        captured.push({
          url: outgoing.url,
          method: outgoing.method,
          namespace: outgoing.headers.get("x-ferrum-namespace"),
          body: text ? JSON.parse(text) : undefined,
        });
        return new Response(
          JSON.stringify({
            id: "edge-cert",
            domains: ["example.com"],
            directory_url: "https://ca.example/directory",
            status: "issued",
            source_uri: "acme://certificates/edge-cert",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("treats import, read, replace, and delete as fleet-global operations", async () => {
    localStorage.setItem("ferrum:namespace", "production");
    await createAcmeCertificate(request);
    await getAcmeCertificate("edge-cert");
    await updateAcmeCertificate("edge-cert", { ...request, id: "wrong-id" });
    await removeAcmeCertificate("edge-cert");

    expect(captured.map(({ method }) => method)).toEqual(["POST", "GET", "PUT", "DELETE"]);
    expect(captured.every(({ namespace }) => namespace === null)).toBe(true);
    expect(captured[0].url).toMatch(/\/admin\/tls\/acme\/certificates$/);
    expect(captured[1].url).toMatch(/\/admin\/tls\/acme\/certificates\/edge-cert$/);
    expect(captured[2].body).toMatchObject({ id: "edge-cert", key_pem: request.key_pem });
    expect(captured[3].url).toMatch(/\/admin\/tls\/acme\/certificates\/edge-cert$/);
  });
});
