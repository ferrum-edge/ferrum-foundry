/* ------------------------------------------------------------------ */
/*  Deterministic failure injection for the critical-journey suite     */
/* ------------------------------------------------------------------ */

/**
 * A transparent forwarder that sits between the Foundry BFF and the gateway
 * admin API and can be told, precisely, to fail the next N requests matching a
 * method and path.
 *
 * It exists so the journeys that matter most — a transient read that must
 * recover without leaving a stale error modal, an unavailable read that must
 * not render as a healthy empty result, a mutation interrupted after it may
 * already have committed — are *arranged*, not waited for. A suite that
 * retries until a flake goes green proves nothing; a suite that arms exactly
 * one failure and asserts the UI's response proves the behaviour.
 *
 * Arming is explicit and consumed:
 *
 *   POST /__fault   {"method":"GET","path":"/proxies","times":1,"status":503}
 *   GET  /__fault   -> { armed: [...], served: n }
 *   DELETE /__fault -> disarm everything
 *
 * The control surface requires `x-fault-token` to equal `FAULT_TOKEN`, and the
 * path is one the admin API does not use. This is a test fixture: it is never
 * part of the starter stack or any published image.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? "9500");
const UPSTREAM = process.env.FAULT_UPSTREAM ?? "http://127.0.0.1:9000";
const TOKEN = process.env.FAULT_TOKEN ?? "";
const CONTROL_PATH = "/__fault";

if (!TOKEN) {
  console.error("FAULT_TOKEN is required; refusing to expose an unauthenticated control surface");
  process.exit(1);
}

/** @type {{ method: string, path: string, status: number, remaining: number, body: string }[]} */
let armed = [];
let served = 0;
/** Requests the upstream never saw because a fault consumed them. */
let blocked = 0;

function matches(rule, method, pathname, namespace) {
  return (
    (rule.method === "*" || rule.method === method.toUpperCase()) &&
    pathname.startsWith(rule.path) &&
    // Without a namespace, a rule would also match the same path read under
    // another tenant — which is exactly the request a namespace-isolation
    // journey needs to leave alone.
    (rule.namespace === null || rule.namespace === namespace)
  );
}

function takeFault(method, pathname, namespace) {
  const rule = armed.find(
    (entry) => entry.remaining > 0 && matches(entry, method, pathname, namespace),
  );
  if (!rule) return null;
  rule.remaining -= 1;
  blocked += 1;
  armed = armed.filter((entry) => entry.remaining > 0);
  return rule;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function control(request, response, url) {
  if (request.headers["x-fault-token"] !== TOKEN) {
    return json(response, 403, { error: "fault control requires x-fault-token" });
  }
  if (request.method === "GET") {
    return json(response, 200, { armed, served, blocked });
  }
  if (request.method === "DELETE") {
    armed = [];
    return json(response, 200, { armed, served, blocked });
  }
  if (request.method === "POST") {
    let rule;
    try {
      rule = JSON.parse((await readBody(request)).toString("utf8"));
    } catch {
      return json(response, 400, { error: "invalid JSON" });
    }
    const times = Number(rule.times ?? 1);
    if (!Number.isSafeInteger(times) || times < 1) {
      return json(response, 400, { error: "times must be a positive integer" });
    }
    armed.push({
      method: String(rule.method ?? "*").toUpperCase(),
      path: String(rule.path ?? "/"),
      status: Number(rule.status ?? 503),
      body: String(rule.body ?? JSON.stringify({ error: "injected fault" })),
      remaining: times,
      // Two ways to lose a request, and they are not the same thing.
      // `drop` discards it before the gateway sees it. `dropAfterForward`
      // lets it commit and then destroys the connection, which is the
      // genuinely ambiguous case: the write happened, the client cannot know.
      drop: rule.drop === true,
      dropAfterForward: rule.dropAfterForward === true,
      // Hold the request, then forward it normally: a late answer, which is
      // how a response for a previous tenant arrives after a switch.
      delayMs: Number.isSafeInteger(rule.delayMs) && rule.delayMs > 0 ? rule.delayMs : 0,
      namespace: typeof rule.namespace === "string" ? rule.namespace : null,
    });
    void url;
    return json(response, 200, { armed, served, blocked });
  }
  return json(response, 405, { error: "method not allowed" });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://fault-proxy");

  if (url.pathname === CONTROL_PATH) {
    return control(request, response, url);
  }

  const fault = takeFault(
    request.method ?? "GET",
    url.pathname,
    request.headers["x-ferrum-namespace"] ?? null,
  );
  if (fault?.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
  }
  if (fault && !fault.dropAfterForward && !fault.delayMs) {
    if (fault.drop) {
      // The request reached this forwarder and was discarded without an
      // answer. From the BFF's side the outcome is genuinely unknown, which
      // is exactly the state the UI has to report honestly.
      request.socket.destroy();
      return;
    }
    return json(response, fault.status, JSON.parse(fault.body));
  }

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await readBody(request);

  const headers = { ...request.headers };
  delete headers.host;
  delete headers["content-length"];

  try {
    const upstream = await fetch(`${UPSTREAM}${request.url}`, {
      method: request.method,
      headers,
      body,
      signal: AbortSignal.timeout(60_000),
    });
    served += 1;
    const payload = Buffer.from(await upstream.arrayBuffer());
    const outgoing = {};
    upstream.headers.forEach((value, key) => {
      if (key !== "content-encoding" && key !== "content-length" && key !== "transfer-encoding") {
        outgoing[key] = value;
      }
    });
    if (fault?.dropAfterForward) {
      // The gateway committed. The answer never arrives.
      request.socket.destroy();
      return;
    }
    outgoing["content-length"] = String(payload.byteLength);
    response.writeHead(upstream.status, outgoing);
    response.end(payload);
  } catch (error) {
    json(response, 502, { error: `fault proxy could not reach upstream: ${error.message}` });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`fault proxy forwarding to ${UPSTREAM} on :${PORT}`);
});
