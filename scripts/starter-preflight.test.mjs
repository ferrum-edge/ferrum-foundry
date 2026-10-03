import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { mayCarrySecret as e2eMayCarrySecret } from "../e2e/support/may-carry-secret.mjs";
import { isLoopbackAdminOrigin, mayCarrySecret } from "../shared/admin-origin.js";
import {
  FAIL,
  PASS,
  UNKNOWN,
  checkAdminCredentials,
  checkAdminUrl,
  checkGatewayReachable,
  checkSecrets,
  checkTlsTrust,
  checkTrustBoundary,
  parseEnvFile,
  runPreflight,
} from "./starter-preflight.mjs";

const STARTER = new URL("../deploy/starter/", import.meta.url);

function statFor(overrides = {}) {
  return {
    stat: async () => ({ isFile: () => true, size: 2048, ...overrides }),
  };
}

const workingEnv = {
  FERRUM_JWT_SECRET: "a".repeat(48),
  FERRUM_TRUSTED_PROXY_SECRET: "b".repeat(48),
  FERRUM_ADMIN_URL: "https://ferrum-admin.internal:9000",
  FERRUM_NAMESPACE: "production",
  FERRUM_JWT_AUDIENCE: "ferrum-admin",
};

/* ---------------- .env parsing ---------------- */

test("parses a compose-style env file without interpolating", () => {
  const parsed = parseEnvFile(
    [
      "# a comment",
      "",
      "FERRUM_JWT_SECRET=plain-value",
      'QUOTED="has spaces"',
      "SINGLE='single'",
      "EMPTY=",
      "LITERAL=$NOT_EXPANDED",
      "not a pair",
    ].join("\n"),
  );
  assert.deepEqual(parsed, {
    FERRUM_JWT_SECRET: "plain-value",
    QUOTED: "has spaces",
    SINGLE: "single",
    EMPTY: "",
    LITERAL: "$NOT_EXPANDED",
  });
});

/* ---------------- secrets ---------------- */

test("a missing, short, or placeholder secret fails", () => {
  const statuses = checkSecrets({
    FERRUM_JWT_SECRET: "too-short",
    FERRUM_TRUSTED_PROXY_SECRET: "",
  }).map((result) => result.status);
  assert.deepEqual(statuses, [FAIL, FAIL]);

  const [placeholder] = checkSecrets({
    FERRUM_JWT_SECRET: "replace-me-with-at-least-32-characters-of-random",
    FERRUM_TRUSTED_PROXY_SECRET: "b".repeat(48),
  });
  assert.equal(placeholder.status, FAIL);
  assert.match(placeholder.detail, /placeholder/);
});

test("a secret is never echoed, only measured", () => {
  const results = checkSecrets(workingEnv);
  const rendered = JSON.stringify(results);
  assert.ok(!rendered.includes(workingEnv.FERRUM_JWT_SECRET));
  assert.ok(!rendered.includes(workingEnv.FERRUM_TRUSTED_PROXY_SECRET));
  assert.deepEqual(results.map((result) => result.status), [PASS, PASS]);
});

/* ---------------- admin URL ---------------- */

test("the admin URL must be a bare origin", () => {
  assert.equal(checkAdminUrl({ FERRUM_ADMIN_URL: "https://host:9000" }).status, PASS);
  assert.equal(checkAdminUrl({ FERRUM_ADMIN_URL: "https://host:9000/admin" }).status, FAIL);
  assert.equal(checkAdminUrl({ FERRUM_ADMIN_URL: "https://user:pw@host" }).status, FAIL);
  assert.equal(checkAdminUrl({ FERRUM_ADMIN_URL: "ftp://host" }).status, FAIL);
  assert.equal(checkAdminUrl({}).status, FAIL);
});

test("a plaintext admin URL is unknown, not a pass", () => {
  const result = checkAdminUrl({ FERRUM_ADMIN_URL: "http://127.0.0.1:9000" });
  assert.equal(result.status, UNKNOWN);
  assert.match(result.remedy, /disposable local stack/);
});

test("a plaintext admin URL to another host fails, as the production BFF refuses it", () => {
  for (const url of [
    "http://ferrum-admin.internal:9000",
    "http://10.0.0.5:9000",
    "http://127.0.0.1.gateway.example:9000",
  ]) {
    const result = checkAdminUrl({ FERRUM_ADMIN_URL: url });
    assert.equal(result.status, FAIL, url);
    assert.match(result.remedy, /https/);
  }
});

test("the explicit plaintext override is reported as unknown, never a pass", () => {
  const result = checkAdminUrl({
    FERRUM_ADMIN_URL: "http://demo-gateway:9000",
    FERRUM_ALLOW_INSECURE_ADMIN_HTTP: "true",
  });
  assert.equal(result.status, UNKNOWN);
  assert.match(result.detail, /FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true/);
  assert.equal(
    checkAdminUrl({
      FERRUM_ADMIN_URL: "http://demo-gateway:9000",
      FERRUM_ALLOW_INSECURE_ADMIN_HTTP: "1",
    }).status,
    FAIL,
  );
});

/* ---------------- TLS trust ---------------- */

test("a CA bundle outside its approved root fails", async () => {
  const result = await checkTlsTrust(
    { FERRUM_TLS_CA_PATH: "/etc/other/ca.pem", FERRUM_TLS_CA_ROOT: "/etc/ferrum/ca" },
    statFor(),
  );
  assert.equal(result.status, FAIL);
});

test("an unreadable CA bundle fails with its errno", async () => {
  const result = await checkTlsTrust(
    { FERRUM_TLS_CA_PATH: "/etc/ferrum/ca/x.pem", FERRUM_TLS_CA_ROOT: "/etc/ferrum/ca" },
    { stat: async () => { const error = new Error("nope"); error.code = "EACCES"; throw error; } },
  );
  assert.equal(result.status, FAIL);
  assert.match(result.detail, /EACCES/);
});

test("a readable bundle is still unknown, because anchoring was not proved", async () => {
  const result = await checkTlsTrust(
    { FERRUM_TLS_CA_PATH: "/etc/ferrum/ca/x.pem", FERRUM_TLS_CA_ROOT: "/etc/ferrum/ca" },
    statFor(),
  );
  assert.equal(result.status, UNKNOWN);
  assert.match(result.remedy, /has not verified/);
});

test("an https gateway with no configured bundle is unknown, not a pass", async () => {
  const result = await checkTlsTrust({ FERRUM_ADMIN_URL: "https://host:9000" }, statFor());
  assert.equal(result.status, UNKNOWN);
  assert.match(result.remedy, /cannot tell from here/);
});

/* ---------------- gateway reachability ---------------- */

test("an unreachable gateway fails with an actionable remedy", async () => {
  const error = new Error("fetch failed");
  error.cause = { code: "ECONNREFUSED" };
  const result = await checkGatewayReachable(workingEnv, async () => { throw error; });
  assert.equal(result.status, FAIL);
  assert.match(result.detail, /ECONNREFUSED/);
});

test("a certificate failure names the trust remedy, not a verification bypass", async () => {
  const error = new Error("fetch failed");
  error.cause = { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" };
  const result = await checkGatewayReachable(workingEnv, async () => { throw error; });
  assert.match(result.remedy, /FERRUM_TLS_CA_PATH/);
  assert.ok(!/disable/i.test(result.remedy.replace("do not disable", "")));
});

/* ---------------- admin credentials ---------------- */

test("a 401 from the gateway names the signing key and audience", async () => {
  const [result] = await checkAdminCredentials(workingEnv, async () => new Response("", { status: 401 }));
  assert.equal(result.status, FAIL);
  assert.match(result.remedy, /FERRUM_ADMIN_JWT_SECRET/);
});

test("a 403 separates an accepted key from a refused namespace", async () => {
  const results = await checkAdminCredentials(workingEnv, async () => new Response("", { status: 403 }));
  assert.equal(results[0].status, PASS);
  assert.equal(results[1].status, FAIL);
  assert.match(results[1].name, /namespace grant/);
});

test("a 200 confirms both, and the request carries the namespace header", async () => {
  let seen;
  const results = await checkAdminCredentials(workingEnv, async (url, init) => {
    seen = { url, headers: init.headers };
    return Response.json({ data: [], pagination: { offset: 0, limit: 1, total: 0 } });
  });
  assert.deepEqual(results.map((result) => result.status), [PASS, PASS]);
  assert.match(seen.url, /\/proxies\?offset=0&limit=1$/);
  assert.equal(seen.headers["x-ferrum-namespace"], "production");
  assert.match(seen.headers.authorization, /^Bearer ey/);
});

test("a missing namespace is unknown rather than silently skipped", async () => {
  const [result] = await checkAdminCredentials(
    { ...workingEnv, FERRUM_NAMESPACE: undefined },
    async () => new Response("", { status: 200 }),
  );
  assert.equal(result.status, UNKNOWN);
});

test("no admin token is minted or sent to a plaintext remote admin URL", async () => {
  for (const env of [
    { ...workingEnv, FERRUM_ADMIN_URL: "http://ferrum-admin.internal:9000" },
    {
      ...workingEnv,
      FERRUM_ADMIN_URL: "http://demo-gateway:9000",
      FERRUM_ALLOW_INSECURE_ADMIN_HTTP: "true",
    },
    { ...workingEnv, FERRUM_ADMIN_URL: "http://127.0.0.1.gateway.example:9000" },
  ]) {
    let requests = 0;
    const [result] = await checkAdminCredentials(env, async () => {
      requests += 1;
      return new Response("", { status: 200 });
    });
    assert.equal(result.status, UNKNOWN, env.FERRUM_ADMIN_URL);
    assert.match(result.detail, /neither https nor loopback/);
    assert.equal(requests, 0, `${env.FERRUM_ADMIN_URL} must receive no credentialed probe`);
  }
});

test("a loopback plaintext admin URL still gets the credentialed probe", async () => {
  let seen;
  const results = await checkAdminCredentials(
    { ...workingEnv, FERRUM_ADMIN_URL: "http://127.0.0.1:9000" },
    async (url, init) => {
      seen = { url, headers: init.headers };
      return Response.json({ data: [] });
    },
  );
  assert.deepEqual(results.map((result) => result.status), [PASS, PASS]);
  assert.match(seen.url, /^http:\/\/127\.0\.0\.1:9000\/proxies/);
  assert.match(seen.headers.authorization, /^Bearer ey/);
});

test("the full preflight sends only the anonymous health probe to a remote plaintext gateway", async () => {
  const sent = [];
  const report = await runPreflight(
    { ...workingEnv, FERRUM_ADMIN_URL: "http://ferrum-admin.internal:9000" },
    {
      fetch: async (url, init = {}) => {
        sent.push({ url: String(url), headers: init.headers ?? {} });
        return new Response("", { status: 200 });
      },
      fs: statFor(),
    },
  );
  assert.ok(report.failed > 0, "the plaintext remote admin URL must fail the preflight");
  const toGateway = sent.filter(({ url }) => url.startsWith("http://ferrum-admin.internal:9000"));
  assert.deepEqual(toGateway.map(({ url }) => url), ["http://ferrum-admin.internal:9000/health"]);
  assert.ok(
    sent.every(({ headers }) => !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")),
    "no request may carry an admin token",
  );
});

/* ---------------- trust boundary ---------------- */

test("a served forged-identity request fails", async () => {
  const results = await checkTrustBoundary(
    { ...workingEnv, FOUNDRY_PREFLIGHT_URL: "https://foundry.example.com" },
    async (_url, init) =>
      init.headers?.["X-Ferrum-Role"] === "admin"
        ? Response.json({ data: [] })
        : new Response("", { status: 401 }),
  );
  assert.equal(results[0].status, PASS);
  assert.equal(results[1].status, FAIL);
  assert.match(results[1].remedy, /proxy_set_header/);
});

test("a served anonymous request fails", async () => {
  const [anonymous] = await checkTrustBoundary(
    { ...workingEnv, FOUNDRY_PREFLIGHT_URL: "https://foundry.example.com" },
    async () => Response.json({ data: [] }),
  );
  assert.equal(anonymous.status, FAIL);
  assert.match(anonymous.remedy, /auth_request/);
});

test("without a front-door URL the boundary is unknown, not assumed sound", async () => {
  const [result] = await checkTrustBoundary(workingEnv, async () => new Response("", { status: 500 }));
  assert.equal(result.status, UNKNOWN);
});

test("an invalid front-door URL is unknown and sends no requests", async () => {
  let requests = 0;
  const results = await checkTrustBoundary(
    { ...workingEnv, FOUNDRY_PREFLIGHT_URL: "not a url" },
    async () => {
      requests += 1;
      return new Response("", { status: 401 });
    },
  );

  assert.deepEqual(results.map((result) => result.status), [UNKNOWN, UNKNOWN]);
  assert.equal(requests, 0);
});

/* ---------------- runner ---------------- */

test("the report counts failures and unknowns separately", async () => {
  const report = await runPreflight(
    { FERRUM_JWT_SECRET: "short" },
    { fetch: async () => { throw new Error("no network"); }, fs: statFor() },
  );
  assert.ok(report.failed > 0);
  assert.ok(report.unknown > 0);
  assert.equal(
    report.results.length,
    report.failed + report.unknown + report.results.filter((r) => r.status === PASS).length,
  );
});

/* ---------------- checked-in starter ---------------- */

test("the example env holds no working secret", async () => {
  const env = parseEnvFile(await readFile(new URL(".env.example", STARTER), "utf8"));
  const results = checkSecrets(env);
  assert.deepEqual(
    results.map((result) => result.status),
    [FAIL, FAIL],
    ".env.example must ship placeholders that the preflight refuses",
  );
});

test("only the demo bootstrap lets Foundry use a plaintext admin URL to another host", async () => {
  const compose = await readFile(new URL("compose.yaml", STARTER), "utf8");
  const foundry = compose.slice(compose.indexOf("  foundry:"), compose.indexOf("  oauth2-proxy:"));
  assert.match(
    foundry,
    /FERRUM_ALLOW_INSECURE_ADMIN_HTTP: \$\{FERRUM_ALLOW_INSECURE_ADMIN_HTTP:-false\}/,
    "the BFF must default to refusing remote plaintext in both profiles",
  );

  const example = parseEnvFile(await readFile(new URL(".env.example", STARTER), "utf8"));
  assert.equal(example.FERRUM_ALLOW_INSECURE_ADMIN_HTTP, "false");
  assert.equal(checkAdminUrl(example).status, PASS, "the production example must use https");

  const bootstrap = await readFile(new URL("bootstrap-demo.sh", STARTER), "utf8");
  assert.match(bootstrap, /^FERRUM_ADMIN_URL=http:\/\/demo-gateway:9000$/m);
  assert.match(bootstrap, /^FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true$/m);
});

test("production and demo proxies share one authorization policy", async () => {
  const production = await readFile(new URL("nginx/foundry.conf", STARTER), "utf8");
  const demo = await readFile(new URL("nginx/foundry.demo.conf", STARTER), "utf8");
  for (const config of [production, demo]) {
    assert.match(config, /include \/etc\/nginx\/identity\/policy\.conf;/);
    assert.match(config, /include \/etc\/nginx\/identity\/inject\.conf;/);
  }
  // The demo may differ only in its identity source, so it must not carry its
  // own copy of the policy or the header injection.
  assert.ok(!/map \$auth_groups/.test(demo));
  assert.ok(!/X-Ferrum-Auth-Secret/.test(demo));
  assert.ok(!/map \$auth_groups/.test(production));
});

test("the shared injection replaces every identity header a client could send", async () => {
  const inject = await readFile(new URL("nginx/identity/inject.conf", STARTER), "utf8");
  for (const header of [
    "X-Ferrum-Auth-Secret",
    "X-Forwarded-User",
    "X-Ferrum-Role",
    "X-Ferrum-Namespaces",
  ]) {
    assert.match(
      inject,
      new RegExp(`proxy_set_header\\s+${header}\\s`),
      `${header} must be overwritten, not forwarded from the client`,
    );
  }
});

test("an unmapped identity is denied by the shared policy's default", async () => {
  const policy = await readFile(new URL("nginx/identity/policy.conf", STARTER), "utf8");
  assert.match(policy, /map \$auth_groups \$ferrum_role \{\s*\n\s*default\s+"";/);
  assert.match(policy, /map \$auth_groups \$ferrum_namespaces \{\s*\n\s*default\s+"";/);
});

test("the shipped policy grants no test-only second namespace", async () => {
  const policy = await readFile(new URL("nginx/identity/policy.conf", STARTER), "utf8");
  assert.ok(!policy.includes("ferrum-foundry-demo-b"));

  const e2ePolicy = await readFile(new URL("../e2e/nginx/policy.conf", import.meta.url), "utf8");
  assert.match(e2ePolicy, /ferrum-foundry-demo,ferrum-foundry-demo-b/);
});

test("the BFF publishes no host port in either profile", async () => {
  const compose = await readFile(new URL("compose.yaml", STARTER), "utf8");
  const foundryService = compose.slice(
    compose.indexOf("  foundry:"),
    compose.indexOf("  oauth2-proxy:"),
  );
  assert.ok(/expose:/.test(foundryService));
  assert.ok(
    !/^\s{4}ports:/m.test(foundryService),
    "anyone who can reach the BFF port and knows the proof secret is an administrator",
  );
});

test("every third-party image in the starter is pinned by digest", async () => {
  const compose = await readFile(new URL("compose.yaml", STARTER), "utf8");
  const images = [...compose.matchAll(/^\s+image:\s*(\S+)/gm)].map((match) => match[1]);
  assert.ok(images.length >= 4);
  for (const image of images) {
    if (image.startsWith("${FOUNDRY_IMAGE")) continue; // operator-selected release
    assert.match(image, /@sha256:[0-9a-f]{64}/, `${image} must be pinned by digest`);
  }
});

test("only variables both profiles need are required by compose", async () => {
  // Compose interpolates the whole file before it filters by profile, so a
  // `:?` on a production-only value stops the demo profile from starting at
  // all — and the other way round. Only the three the BFF cannot run without
  // may be required here; everything else is the reading service's business.
  const compose = await readFile(new URL("compose.yaml", STARTER), "utf8");
  const required = [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((match) => match[1]);

  assert.deepEqual(
    [...new Set(required)].sort(),
    ["FERRUM_ADMIN_URL", "FERRUM_JWT_SECRET", "FERRUM_TRUSTED_PROXY_SECRET"],
    "a profile-specific variable marked required breaks the other profile",
  );
});

test("oauth2-proxy takes its identity settings from the environment", async () => {
  const compose = await readFile(new URL("compose.yaml", STARTER), "utf8");
  const service = compose.slice(
    compose.indexOf("  oauth2-proxy:"),
    compose.indexOf("  proxy:"),
  );
  // Passing these on the command line would reintroduce the interpolation the
  // demo profile cannot satisfy.
  assert.ok(!/--oidc-issuer-url/.test(service));
  assert.ok(!/--redirect-url/.test(service));
  assert.ok(!/--email-domain/.test(service));
  assert.match(service, /env_file:/);

  const env = parseEnvFile(
    await readFile(new URL("oauth2-proxy.env.example", STARTER), "utf8"),
  );
  for (const key of [
    "OAUTH2_PROXY_OIDC_ISSUER_URL",
    "OAUTH2_PROXY_REDIRECT_URL",
    "OAUTH2_PROXY_EMAIL_DOMAINS",
  ]) {
    assert.ok(env[key], `${key} must be documented in oauth2-proxy.env.example`);
  }
});

test("every demo service can prove it is ready", async () => {
  // `docker compose up --wait` blocks on health, so a service that inherits a
  // healthcheck for a port it does not serve holds the whole stack. The demo
  // backend runs the Foundry image for its Node runtime, not for its server.
  const compose = await readFile(new URL("compose.yaml", STARTER), "utf8");
  const backend = compose.slice(compose.indexOf("  demo-backend:"));
  assert.match(backend, /healthcheck:/);
  assert.match(backend, /127\.0\.0\.1:8081/, "the probe must target this service's own port");
});

test("the demo backend runs and probes with the image's own Node", async () => {
  // The demo backend's command is bare Node arguments and its probe names a
  // Node binary, so both depend on the Foundry runtime base. The starter also
  // runs already-published images (the released digest, a cached `:main`),
  // all of which have Node at /nodejs/bin/node. The probe therefore names that
  // path, and the runtime stage must be the digest-pinned distroless nonroot
  // Node image, which has Node only there. The entrypoint and the image
  // HEALTHCHECK use the same path.
  const DISTROLESS_NODE = "/nodejs/bin/node";
  const dockerfile = await readFile(new URL("../docker/Dockerfile", import.meta.url), "utf8");
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM ") + 1);
  const base = runtime.slice(0, runtime.indexOf("\n"));
  const entrypoint = runtime.match(/^ENTRYPOINT \["([^"]+)"\]$/m);
  assert.ok(entrypoint, "the runtime stage must name Node as its exec-form entrypoint");
  assert.equal(entrypoint[1], DISTROLESS_NODE, "the entrypoint must be Node at the distroless path");
  assert.ok(
    runtime.includes(`CMD ["${DISTROLESS_NODE}", "-e",`),
    "the image HEALTHCHECK must use the entrypoint's Node binary",
  );
  const DISTROLESS_BASE = /^FROM gcr\.io\/distroless\/nodejs\d+-debian\d+:nonroot@sha256:[0-9a-f]{64}$/;
  assert.match(
    base,
    DISTROLESS_BASE,
    `the runtime base must be the digest-pinned distroless nonroot Node image (${base})`,
  );
  assert.doesNotMatch(runtime, /^RUN /m, "a distroless runtime stage has no shell to RUN in");
  assert.match(runtime, /^USER 65532:65532$/m, "the runtime must run as the numeric nonroot user");

  const compose = await readFile(new URL("compose.yaml", STARTER), "utf8");
  const backend = compose.slice(compose.indexOf("  demo-backend:"));
  assert.match(backend, /^ {4}command:\n {6}- "-e"\n/m, "the command must be Node arguments");
  assert.ok(
    backend.includes(`- CMD\n        - ${DISTROLESS_NODE}\n`),
    "the demo probe must use the Node path every published Foundry image has",
  );
});

test("oauth2-proxy never receives the gateway admin secrets", async () => {
  // An env_file hands a service every variable in it. `.env` holds the key
  // that signs gateway admin tokens and the proxy proof secret.
  const compose = await readFile(new URL("compose.yaml", STARTER), "utf8");
  const service = compose.slice(compose.indexOf("  oauth2-proxy:"), compose.indexOf("  proxy:"));
  assert.ok(!/-\s+\.env\s*$/m.test(service), "oauth2-proxy must not read .env");
  assert.match(service, /path: oauth2-proxy\.env/);

  const oauthEnv = await readFile(new URL("oauth2-proxy.env.example", STARTER), "utf8");
  assert.ok(!/FERRUM_JWT_SECRET|FERRUM_TRUSTED_PROXY_SECRET/.test(oauthEnv));
  const mainEnv = parseEnvFile(await readFile(new URL(".env.example", STARTER), "utf8"));
  assert.ok(
    !Object.keys(mainEnv).some((key) => key.startsWith("OAUTH2_PROXY_")),
    "identity-provider secrets belong in oauth2-proxy.env, not .env",
  );
});

test("a CA path merely sharing the root's prefix is outside it", async () => {
  const result = await checkTlsTrust(
    { FERRUM_TLS_CA_PATH: "/etc/ferrum/ca-evil/x.pem", FERRUM_TLS_CA_ROOT: "/etc/ferrum/ca" },
    statFor(),
  );
  assert.equal(result.status, FAIL);
});

test("the e2e proof guard matches the canonical rule over the same URL table", () => {
  const cases = [
    ["https://foundry.example.com", true],
    ["HTTP://localhost", true],
    ["http://127.0.0.1:8088", true],
    ["http://127.1", true],
    ["http://2130706433", true],
    ["http://localhost:8088", true],
    ["http://[::1]:8088", true],
    ["http://LOCALHOST", true],
    ["http://[0:0:0:0:0:0:0:1]", true],
    ["https://gateway.example", true],
    ["http://foundry.example.com", false],
    ["http://10.0.0.5:8088", false],
    ["http://127.0.0.1.gateway.example", false],
    ["http://127.ops.example", false],
    ["http://127.0.0.1@evil.example", false],
    ["http://localhost.evil.example", false],
    ["http://[::ffff:127.0.0.1]", false],
    ["http://0.0.0.0", false],
    ["http://[::]", false],
    ["http://localhost.", false],
    ["ftp://localhost:8088", false],
    ["not a url", false],
  ];

  for (const [url, expected] of cases) {
    assert.equal(mayCarrySecret(url), expected, `canonical: ${url}`);
    assert.equal(e2eMayCarrySecret(url), expected, `e2e: ${url}`);
  }
});

test("HTTP accepts only literal IPv4 loopback addresses", () => {
  for (const url of ["http://127.0.0.1:8088", "http://127.255.255.255:8088"]) {
    assert.equal(mayCarrySecret(url), true, url);
  }
});

test("the shared loopback classifier handles canonical and unusual URL spellings", () => {
  const cases = [
    ["http://0.0.0.0", false],
    ["http://[::]", false],
    ["HTTP://localhost", true],
    ["http://127.1", true],
    ["http://2130706433", true],
    ["http://[::ffff:127.0.0.1]", false],
    ["http://localhost.", false],
  ];

  for (const [url, expected] of cases) {
    assert.equal(isLoopbackAdminOrigin(url), expected, url);
  }
});

test("the stripping probe is not run against a plaintext remote front door", async () => {
  const sent = [];
  const results = await checkTrustBoundary(
    { ...workingEnv, FOUNDRY_PREFLIGHT_URL: "http://foundry.example.com" },
    async (_url, init) => {
      sent.push(init.headers ?? {});
      return new Response("", { status: 401 });
    },
  );
  assert.equal(results[1].status, UNKNOWN);
  assert.ok(
    !sent.some((headers) => headers["X-Ferrum-Auth-Secret"] === workingEnv.FERRUM_TRUSTED_PROXY_SECRET),
    "the proof secret must not have been sent",
  );
});

test("a 127-prefixed DNS name never receives the proof after other checks fail", async () => {
  const sent = [];
  const results = await checkTrustBoundary(
    { ...workingEnv, FOUNDRY_PREFLIGHT_URL: "http://127.0.0.1.gateway.example" },
    async (_url, init) => {
      sent.push(init.headers ?? {});
      return new Response("", { status: 500 });
    },
  );

  assert.equal(results[0].status, FAIL);
  assert.equal(results[1].status, UNKNOWN);
  assert.equal(sent.length, 1);
  assert.ok(
    sent.every((headers) => !Object.hasOwn(headers, "X-Ferrum-Auth-Secret")),
    "the proof header must be absent for a non-loopback HTTP hostname",
  );
});
