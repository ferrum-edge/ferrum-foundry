import http from "node:http";
import { randomUUID } from "node:crypto";

const backends = [
  { port: 9101, name: "catalog-core", zone: "az-a" },
  { port: 9102, name: "orders-core", zone: "az-b" },
  { port: 9103, name: "identity-core", zone: "az-c" },
  { port: 9104, name: "billing-core", zone: "az-a" },
  { port: 9105, name: "analytics-core", zone: "az-b" },
];

const servers = [];

function sendJson(response, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  response.end(payload);
}

for (const backend of backends) {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (requestUrl.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        service: backend.name,
        zone: backend.zone,
        checked_at: new Date().toISOString(),
      });
      return;
    }

    const shouldFail = requestUrl.searchParams.get("fail") === "true";
    const statusCode = shouldFail ? 503 : 200;
    const latencyMs = 10 + Math.floor(Math.random() * 40);

    setTimeout(() => {
      sendJson(
        response,
        statusCode,
        {
          service: backend.name,
          zone: backend.zone,
          method: request.method,
          path: requestUrl.pathname,
          query: Object.fromEntries(requestUrl.searchParams.entries()),
          request_id: request.headers["x-correlation-id"] ?? randomUUID(),
          generated_at: new Date().toISOString(),
          sample: {
            status: shouldFail ? "degraded" : "ok",
            units: Math.floor(Math.random() * 900) + 100,
            latency_ms: latencyMs,
          },
        },
        { "x-demo-backend": backend.name },
      );
    }, latencyMs);
  });

  server.listen(backend.port, "127.0.0.1", () => {
    console.log(`${backend.name} listening on http://127.0.0.1:${backend.port}`);
  });
  servers.push(server);
}

function shutdown() {
  for (const server of servers) {
    server.close();
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
