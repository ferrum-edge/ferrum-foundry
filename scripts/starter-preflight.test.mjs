import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
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
