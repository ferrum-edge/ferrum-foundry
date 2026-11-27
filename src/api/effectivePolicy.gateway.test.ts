// @vitest-environment node
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
 * assumed. Runs in the Pinned Gateway Contract job and against Edge `main`
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
      const page = JSON.parse(answer.text) as { data: T[]; has_more?: boolean };
      expect(page.has_more ?? false, `/${collection} fits one page`).toBe(false);
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
    } as const;
    const consumerId = (name: string) => `${PREFIX}-${name}`;
    const proxyId = (name: string) => `${PREFIX}-${name}`;
    const plugin = (name: string) => `${PREFIX}-${name}`;
    const created = { consumers: [] as string[], plugins: [] as string[], proxies: [] as string[] };

    function proxyBody(name: string, plugins: string[] = []) {
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
        auth_mode: "single",
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
          credentials: consumer.key ? { keyauth: [{ key: consumer.key }] } : {},
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
      for (const name of ["global", "scoped", "group", "external"]) {
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

      // The fixture exercises each case it claims.
      const decisions = rowsOut.join("\n");
      expect(decisions).toContain(`| scoped | ${consumerId("alice")} via shadowed X-Fx-Global-Key | denied |`);
      expect(decisions).toContain(`| group | ${consumerId("carol")} | allowed |`);
      expect(decisions).toContain(`| global | ${consumerId("carol")} | denied |`);
      expect(decisions).toContain(`| external | ${consumerId("alice")} | denied |`);

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
          const answer = await admin(`/${collection}/${encodeURIComponent(id)}`, { method: "DELETE" });
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
