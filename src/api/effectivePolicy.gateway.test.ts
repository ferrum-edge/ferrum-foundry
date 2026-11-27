// @vitest-environment node
import { SignJWT } from "jose";
import { expect, it } from "vitest";
import { signAdminJwt } from "../../shared/admin-jwt.js";
import { analyzeProxyPolicy, type AccessDecision } from "../lib/effectivePolicy";
import { toUpdatePayload as proxyUpdateBody } from "./proxies";
import type { Consumer, PluginConfig, Proxy } from "./types";

/*
 * Foundry's effective policy (`src/lib/effectivePolicy.ts`) against what the
 * gateway does. A fixture of proxies, Consumers and plugins covers a global
 * plugin, a proxy-scoped one that shadows it, a proxy-group ACL that shadows
 * a global ACL, an access_control deny and allow-list, and an ACL whose only
 * allow-list is `allowed_external_identities`. The test reads the namespace's
 * whole collections back, asks `analyzeProxyPolicy` for each fixture proxy and
 * Consumer, and sends that Consumer's request through the data plane: an
 * `allowed` Consumer must reach the backend, a `denied` one must be refused
 * with 401 or 403. Every fixture outcome is definitive, so a `conditional`
 * answer fails too. A Consumer's key sent only in a header whose key_auth
 * Foundry calls shadowed must be refused, so shadowing is observed, not
 * assumed.
 *
 * Two proxies carry the same pair of authenticators, a `key_auth` that reads
 * `Authorization` and runs first (priority 1000) and a `jwt_auth` on the same
 * header, one in `single` and one in `multi` auth mode. A Consumer whose only
 * credential is a JWT sends it the way any JWT client would: in `single` mode
 * the earlier `key_auth` rejects it and Foundry must not claim access; in
 * `multi` mode the later `jwt_auth` admits it and Foundry must say so. A TCP
 * stream proxy checks that HTTP-only authentication is not counted on a
 * stream listener: the global ACL there sees no identity and closes every
 * connection. Runs in the Pinned Gateway Contract job and against Edge `main`
 * in the Edge Main Drift workflow, after the demo seed; it removes everything
 * it created, and fails if that cleanup is refused.
 */

// The frontend project's TypeScript config has no Node types; this file runs
// under Node (see the environment pragma) and reads its environment directly.
const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const GATEWAY = env.FERRUM_EFFECTIVE_POLICY_GATEWAY_CONTRACT === "true";

const HEADER_LOCATION_PREFIX = "header:";
const PREFIX = "fx-policy";
/** Published by the gateway step for this check (ci.yml, edge-main-drift.yml). */
const STREAM_PORT = 18901;
const HTTP_STATUS_LINE_PATTERN = /^HTTP\/1\.[01] (\d{3})/;

interface NetSocket {
  on(event: "connect" | "end" | "close", listener: () => void): NetSocket;
  on(event: "data", listener: (chunk: { toString(): string }) => void): NetSocket;
  on(event: "error", listener: (error: { code?: string }) => void): NetSocket;
  write(data: string): void;
  destroy(): void;
  setTimeout(ms: number, listener: () => void): void;
}

/**
 * Send one HTTP request over a raw TCP connection to the stream listener and
 * report what came back: the relayed status, `closed` when the gateway
 * accepted the connection and closed it without relaying anything, or
 * `refused` while nothing listens yet. Retries `refused` until the listener
 * is up.
 */
async function streamExchange(port: number): Promise<string> {
  // The frontend project's TypeScript config has no Node types.
  const netModule = "node:net";
  const net = (await import(/* @vite-ignore */ netModule)) as {
    createConnection(options: { host: string; port: number }): NetSocket;
  };
  const attempt = () => new Promise<string>((resolve) => {
    let connected = false;
    let received = "";
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const settle = (answer: string) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(10_000, () => settle(received ? received.slice(0, 40) : "timeout"));
    socket.on("connect", () => {
      connected = true;
      socket.write(`GET / HTTP/1.1\r\nHost: ${PREFIX}.stream\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      received += chunk.toString();
    });
    const finish = () => {
      const status = HTTP_STATUS_LINE_PATTERN.exec(received)?.[1];
      settle(status ?? (connected ? "closed" : "refused"));
    };
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", (error) => settle(connected ? "closed" : error.code === "ECONNREFUSED" ? "refused" : String(error.code)));
  });
  let answer = "refused";
  for (let tries = 0; tries < 60 && answer === "refused"; tries += 1) {
    answer = await attempt();
    if (answer === "refused") await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return answer;
}

it.runIf(GATEWAY)(
  "the gateway admits and refuses exactly the Consumers effective policy says",
  async () => {
    const adminUrl = env.FERRUM_ADMIN_URL!;
    const proxyUrl = env.FERRUM_DEMO_PROXY_URL ?? "http://127.0.0.1:8000";
    const namespace = env.FERRUM_NAMESPACE!;
    const backendHost = env.FERRUM_DEMO_BACKEND_HOST ?? "host.docker.internal";
    const token = await signAdminJwt({
      secret: env.FERRUM_JWT_SECRET!,
      issuer: env.FERRUM_JWT_ISSUER ?? "ferrum-edge",
      subject: "foundry-effective-policy-contract",
      role: "admin",
      namespaces: [namespace],
      audience: env.FERRUM_JWT_AUDIENCE,
      ttlSeconds: 600,
    });
    async function admin(path: string, init: { method?: string; body?: unknown } = {}) {
      const response = await fetch(new URL(path, adminUrl), {
        method: init.method ?? "GET",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-ferrum-namespace": namespace,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      return { status: response.status, text: await response.text() };
    }
    async function write(path: string, method: string, body: unknown) {
      const answer = await admin(path, { method, body });
      expect([200, 201], `${method} ${path}: ${answer.text.slice(0, 500)}`).toContain(answer.status);
      return answer;
    }
    async function rows<T>(collection: string): Promise<T[]> {
      const answer = await admin(`/${collection}?offset=0&limit=1000`);
      expect(answer.status, `GET /${collection}: ${answer.text.slice(0, 500)}`).toBe(200);
      const page = JSON.parse(answer.text) as { data: T[]; pagination?: { total?: number } };
      // A conclusion drawn from part of a collection is wrong: the one page
      // must be the whole collection.
      expect(page.data.length, `/${collection} returned the whole collection`).toBe(page.pagination?.total);
      return page.data;
    }

    const run = crypto.randomUUID().slice(0, 8);
    const keyOf = (name: string) => `${PREFIX}-${name}-key-${run}-${crypto.randomUUID()}`;
    const consumers = {
      alice: { groups: ["fx-operators"], key: keyOf("alice") },
      bob: { groups: [], key: keyOf("bob") },
      carol: { groups: ["fx-operators"], key: keyOf("carol") },
      mallory: { groups: ["fx-suspended"], key: keyOf("mallory") },
      nokey: { groups: [], key: null },
      dave: { groups: [], key: null },
    } as const;
    // Dave holds only a JWT credential, for the auth-mode pair.
    const daveSecret = `${PREFIX}-dave-jwt-secret-${run}-${crypto.randomUUID()}`;
    const consumerId = (name: string) => `${PREFIX}-${name}`;
    const proxyId = (name: string) => `${PREFIX}-${name}`;
    const plugin = (name: string) => `${PREFIX}-${name}`;
    const created = { consumers: [] as string[], plugins: [] as string[], proxies: [] as string[] };

    function proxyBody(name: string, plugins: string[] = [], authMode: "single" | "multi" = "single") {
      return {
        id: proxyId(name),
        name: `${PREFIX} ${name}`,
        listen_path: `/${PREFIX}/${name}`,
        hosts: [],
        backend_scheme: "http",
        backend_host: backendHost,
        backend_port: 9101,
        strip_listen_path: true,
        preserve_host_header: false,
        backend_connect_timeout_ms: 1500,
        backend_read_timeout_ms: 5000,
        backend_write_timeout_ms: 5000,
        backend_tls_verify_server_cert: true,
        auth_mode: authMode,
        plugins: plugins.map((id) => ({ plugin_config_id: id })),
        frontend_tls: false,
        passthrough: false,
        udp_idle_timeout_seconds: 60,
        allowed_ws_origins: [],
        response_body_mode: "stream",
      };
    }

    try {
      for (const [name, consumer] of Object.entries(consumers)) {
        await write("/consumers", "POST", {
          id: consumerId(name),
          username: consumerId(name),
          acl_groups: consumer.groups,
          credentials: consumer.key
            ? { keyauth: [{ key: consumer.key }] }
            : name === "dave" ? { jwt: [{ secret: daveSecret }] } : {},
        });
        created.consumers.push(consumerId(name));
      }
      // Global policy: every proxy in the namespace needs a key in
      // X-Fx-Global-Key, and Carol and Mallory are refused.
      for (const config of [
        {
          id: plugin("global-key"), plugin_name: "key_auth", scope: "global",
          config: { key_location: "header:X-Fx-Global-Key" },
        },
        {
          id: plugin("global-acl"), plugin_name: "access_control", scope: "global",
          config: { disallowed_consumers: [consumerId("carol"), consumerId("mallory")] },
        },
        {
          // Attached to `group`: replaces the global ACL there.
          id: plugin("group-acl"), plugin_name: "access_control", scope: "proxy_group",
          config: { allowed_groups: ["fx-operators"] },
        },
        {
          // The auth-mode pair, attached to `order-single` and `order-multi`.
          // It replaces the global key_auth there and runs before jwt_auth.
          id: plugin("order-key"), plugin_name: "key_auth", scope: "proxy_group",
          config: { key_location: "header:Authorization" }, priority_override: 1000,
        },
        {
          id: plugin("order-jwt"), plugin_name: "jwt_auth", scope: "proxy_group",
          config: { token_lookup: "header:Authorization", consumer_claim_field: "sub" },
        },
      ]) {
        await write("/plugins/config", "POST", { ...config, enabled: true });
        created.plugins.push(config.id);
      }

      // global: the global key_auth and ACL only.
      // scoped: a proxy-scoped key_auth reading X-Fx-Proxy-Key replaces the
      //   global one.
      // group: the proxy-group ACL replaces the global ACL, so Carol is
      //   admitted and only fx-operators pass.
      // external: a proxy-scoped ACL whose only allow-list names an external
      //   identity, which refuses every Consumer.
      for (const [name, plugins] of [["global", []], ["scoped", []], ["group", [plugin("group-acl")]], ["external", []]] as const) {
        await write("/proxies", "POST", proxyBody(name, [...plugins]));
        created.proxies.push(proxyId(name));
      }
      for (const mode of ["single", "multi"] as const) {
        await write("/proxies", "POST", proxyBody(`order-${mode}`, [plugin("order-key"), plugin("order-jwt")], mode));
        created.proxies.push(proxyId(`order-${mode}`));
      }
      // A TCP stream listener in front of the same backend.
      const { listen_path: _unusedPath, ...httpShape } = proxyBody("stream");
      await write("/proxies", "POST", {
        ...httpShape,
        backend_scheme: "tcp",
        listen_port: STREAM_PORT,
        strip_listen_path: false,
      });
      created.proxies.push(proxyId("stream"));
      for (const [proxy, config] of [
        ["scoped", { id: plugin("scoped-key"), plugin_name: "key_auth", config: { key_location: "header:X-Fx-Proxy-Key" } }],
        ["external", {
          id: plugin("external-acl"), plugin_name: "access_control",
          config: { allowed_external_identities: [{ identity: `spiffe://${PREFIX}.test/ns/${run}/sa/service` }] },
        }],
      ] as const) {
        await write("/plugins/config", "POST", { ...config, scope: "proxy", proxy_id: proxyId(proxy), enabled: true });
        created.plugins.push(config.id);
        // `proxy_id` records intent; the proxy's own list attaches it.
        const live = JSON.parse((await admin(`/proxies/${proxyId(proxy)}`)).text) as Proxy;
        await write(`/proxies/${proxyId(proxy)}`, "PUT", {
          ...proxyUpdateBody(live),
          plugins: [{ plugin_config_id: config.id }],
        });
      }

      const allPlugins = await rows<PluginConfig>("plugins/config");
      const allConsumers = await rows<Consumer>("consumers");
      const allProxies = await rows<Proxy>("proxies");
      // Every fixture row is in what Foundry analyses.
      for (const name of Object.keys(consumers)) {
        expect(allConsumers.some((consumer) => consumer.id === consumerId(name)), `${consumerId(name)} read back`).toBe(true);
      }
      for (const id of created.proxies) {
        expect(allProxies.some((proxy) => proxy.id === id), `${id} read back`).toBe(true);
      }
      for (const id of created.plugins) {
        expect(allPlugins.some((config) => config.id === id), `${id} read back`).toBe(true);
      }

      async function send(path: string, headers: Record<string, string>) {
        // The demo seed's global bot_detection admits this client.
        const response = await fetch(new URL(path, proxyUrl), {
          signal: AbortSignal.timeout(15_000),
          headers: { "user-agent": "FerrumDemoClient/effective-policy-contract", ...headers },
        });
        await response.arrayBuffer();
        return response.status;
      }

      // Wait until every fixture route is live on the data plane: a route the
      // router does not know answers 404.
      for (const name of ["global", "scoped", "group", "external", "order-single", "order-multi"]) {
        let status = 404;
        for (let attempt = 0; attempt < 60 && status === 404; attempt += 1) {
          status = await send(`/${PREFIX}/${name}/`, {});
          if (status === 404) await new Promise((resolve) => setTimeout(resolve, 500));
        }
        expect(status, `/${PREFIX}/${name} never became routable`).not.toBe(404);
      }

      const rowsOut: string[] = [];
      const disagreements: string[] = [];
      const keyHeaders = (configs: PluginConfig[]) =>
        configs
          .filter((config) => config.plugin_name === "key_auth")
          .map((config) => String(config.config?.key_location ?? "header:X-API-Key"))
          .filter((location) => location.startsWith(HEADER_LOCATION_PREFIX))
          .map((location) => location.slice(HEADER_LOCATION_PREFIX.length));

      for (const name of ["global", "scoped", "group", "external"]) {
        const proxy = allProxies.find((candidate) => candidate.id === proxyId(name));
        expect(proxy, `${proxyId(name)} was read back`).toBeDefined();
        const fixtureConsumers = allConsumers.filter((consumer) => consumer.id.startsWith(`${PREFIX}-`));
        const analysis = analyzeProxyPolicy(proxy!, allPlugins, fixtureConsumers);
        const effectiveHeaders = keyHeaders(analysis.authPlugins);
        const shadowedHeaders = keyHeaders(
          allPlugins.filter((config) => config.enabled && config.scope === "global"),
        ).filter((header) => !effectiveHeaders.includes(header));

        for (const result of analysis.consumers) {
          const fixture = consumers[result.consumer.id.slice(PREFIX.length + 1) as keyof typeof consumers];
          const key: string | null = fixture.key;
          const headers: Record<string, string> = key
            ? Object.fromEntries(effectiveHeaders.map((header) => [header, key]))
            : {};
          const status = await send(`/${PREFIX}/${name}/`, headers);
          const observed: AccessDecision = status >= 200 && status < 300
            ? "allowed"
            : status === 401 || status === 403 ? "denied" : "conditional";
          rowsOut.push(`| ${name} | ${result.consumer.username} | ${result.decision} | ${status} |`);
          if (result.decision === "conditional" || observed !== result.decision) {
            disagreements.push(
              `${name} / ${result.consumer.username}: Foundry says ${result.decision} ` +
                `(${result.reasons.join("; ")}), the gateway answered ${status}`,
            );
          }
          // A key in a header whose key_auth Foundry calls shadowed is never read.
          if (key && result.decision === "allowed") {
            for (const header of shadowedHeaders) {
              const shadowStatus = await send(`/${PREFIX}/${name}/`, { [header]: key });
              rowsOut.push(`| ${name} | ${result.consumer.username} via shadowed ${header} | denied | ${shadowStatus} |`);
              if (shadowStatus !== 401) {
                disagreements.push(
                  `${name} / ${result.consumer.username}: a key in ${header}, whose key_auth Foundry calls shadowed, answered ${shadowStatus}`,
                );
              }
            }
          }
        }
      }

      // The auth-mode pair, with each Consumer presenting its own credential
      // as its client would: a key as the Authorization value, a JWT as a
      // Bearer token. The requests do not depend on Foundry's chain.
      const now = Math.floor(Date.now() / 1000);
      const daveToken = await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(consumerId("dave"))
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(new TextEncoder().encode(daveSecret));
      const expectedDave = { single: { decision: "conditional", status: 401 }, multi: { decision: "allowed", status: 200 } } as const;
      for (const mode of ["single", "multi"] as const) {
        const name = `order-${mode}`;
        const proxy = allProxies.find((candidate) => candidate.id === proxyId(name))!;
        const fixtureConsumers = allConsumers.filter((consumer) => consumer.id.startsWith(`${PREFIX}-`));
        const analysis = analyzeProxyPolicy(proxy, allPlugins, fixtureConsumers);
        expect(analysis.authPlugins.map((entry) => entry.plugin_name), `${name} chain`).toEqual(["key_auth", "jwt_auth"]);
        for (const result of analysis.consumers) {
          const short = result.consumer.id.slice(PREFIX.length + 1) as keyof typeof consumers;
          const key: string | null = consumers[short].key;
          const headers: Record<string, string> = short === "dave"
            ? { authorization: `Bearer ${daveToken}` }
            : key ? { authorization: key } : {};
          const status = await send(`/${PREFIX}/${name}/`, headers);
          rowsOut.push(`| ${name} | ${result.consumer.username} | ${result.decision} | ${status} |`);
          if (short === "dave") {
            const expected = expectedDave[mode];
            if (result.decision !== expected.decision || status !== expected.status) {
              disagreements.push(
                `${name} / dave: expected Foundry ${expected.decision} and ${expected.status}, ` +
                  `got Foundry ${result.decision} (${result.reasons.join("; ")}) and ${status}`,
              );
            }
            continue;
          }
          const observed: AccessDecision = status >= 200 && status < 300
            ? "allowed"
            : status === 401 || status === 403 ? "denied" : "conditional";
          if (result.decision === "conditional" || observed !== result.decision) {
            disagreements.push(
              `${name} / ${result.consumer.username}: Foundry says ${result.decision} ` +
                `(${result.reasons.join("; ")}), the gateway answered ${status}`,
            );
          }
        }
      }

      // The stream listener: HTTP-only key_auth is not counted, so the global
      // ACL sees no identity, Foundry refuses everyone, and the gateway
      // accepts the connection and closes it without relaying anything.
      const streamProxy = allProxies.find((candidate) => candidate.id === proxyId("stream"))!;
      const streamAnalysis = analyzeProxyPolicy(streamProxy, allPlugins, allConsumers.filter((consumer) => consumer.id.startsWith(`${PREFIX}-`)));
      const streamAnswer = await streamExchange(STREAM_PORT);
      rowsOut.push(`| stream | (every Consumer) | ${[...new Set(streamAnalysis.consumers.map((result) => result.decision))].join(", ")} | ${streamAnswer} |`);
      if (streamAnalysis.authPlugins.length !== 0 || streamAnalysis.consumers.some((result) => result.decision !== "denied")) {
        disagreements.push(`stream: Foundry should count no authentication and refuse every Consumer (${JSON.stringify(streamAnalysis.consumers.map((result) => result.decision))})`);
      }
      if (streamAnswer !== "closed") {
        disagreements.push(`stream: the gateway answered ${streamAnswer}, not a closed connection`);
      }

      // The fixture exercises each case it claims.
      const decisions = rowsOut.join("\n");
      expect(decisions).toContain(`| scoped | ${consumerId("alice")} via shadowed X-Fx-Global-Key | denied |`);
      expect(decisions).toContain(`| group | ${consumerId("carol")} | allowed |`);
      expect(decisions).toContain(`| global | ${consumerId("carol")} | denied |`);
      expect(decisions).toContain(`| external | ${consumerId("alice")} | denied |`);
      expect(decisions).toContain(`| order-single | ${consumerId("dave")} | conditional | 401 |`);
      expect(decisions).toContain(`| order-multi | ${consumerId("dave")} | allowed | 200 |`);
      expect(decisions).toContain("| stream | (every Consumer) | denied | closed |");

      const report = [
        "### Effective policy against the gateway",
        "",
        "| Proxy | Consumer | Foundry | Gateway status |",
        "| --- | --- | --- | ---: |",
        ...rowsOut,
        "",
      ].join("\n");
      console.log(report);
      expect(disagreements, disagreements.join("\n")).toEqual([]);
    } finally {
      const refused: string[] = [];
      for (const [collection, ids] of [
        ["proxies", created.proxies],
        ["plugins/config", created.plugins],
        ["consumers", created.consumers],
      ] as const) {
        for (const id of [...ids].reverse()) {
          // The proxies go first, so no plugin configuration is still
          // referenced; Edge requires saying so (`expected_proxy_ids=`).
          const query = collection === "plugins/config" ? "?expected_proxy_ids=" : "";
          const answer = await admin(`/${collection}/${encodeURIComponent(id)}${query}`, { method: "DELETE" });
          if (![200, 204, 404].includes(answer.status)) {
            refused.push(`DELETE /${collection}/${id} -> ${answer.status}: ${answer.text.slice(0, 300)}`);
          }
        }
      }
      expect(refused, "fixture cleanup the gateway refused").toEqual([]);
    }
  },
  180_000,
);
