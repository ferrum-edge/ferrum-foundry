import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { SignJWT } from "jose";
import { readSeedConfig } from "./seed-demo-gateway.mjs";

const config = readSeedConfig();
const manifest = JSON.parse(readFileSync(config.manifestPath, "utf8"));
const commonHeaders = {
  accept: "application/json",
  "user-agent": "FerrumDemoClient/contract-smoke",
};

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function request(path, headers = {}) {
  return fetch(`${manifest.proxy_base_url}${path}`, {
    headers: { ...commonHeaders, ...headers },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
}

async function requireSuccess(path, headers = {}, { expectBackend = true } = {}) {
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await request(path, headers);
      lastStatus = response.status;
      lastBody = await response.text();
      if (response.ok) {
        assert.equal(response.headers.get("x-demo-response"), "seeded");
        if (expectBackend) assert.ok(response.headers.get("x-demo-backend"));
        return JSON.parse(lastBody);
      }
    } catch (error) {
      lastBody = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000);
  }
  assert.fail(`GET ${path} never became ready; last status ${lastStatus}: ${lastBody}`);
}

async function makeConsumerJwt() {
  const consumer = manifest.jwt_consumers[0];
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: "demo:read" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(consumer.username)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(consumer.secret));
}

await requireSuccess("/demo/pricing/v1/items/1");

const unauthenticated = await request("/demo/catalog/v1/items/1");
await unauthenticated.arrayBuffer();
assert.ok(
  [401, 403].includes(unauthenticated.status),
  `key-auth route unexpectedly returned ${unauthenticated.status} without a credential`,
);

await requireSuccess("/demo/catalog/v1/items/1", {
  "x-api-key": manifest.key_consumers[0].key,
});

const basicConsumer = manifest.basic_consumers[0];
await requireSuccess("/demo/identity/v1/items/1", {
  authorization: `Basic ${Buffer.from(`${basicConsumer.username}:${basicConsumer.password}`).toString("base64")}`,
});

const bearer = `Bearer ${await makeConsumerJwt()}`;
await requireSuccess("/demo/reporting/v1/items/1", { authorization: bearer });
await requireSuccess("/demo/fulfillment/v1/items/1", {
  "x-api-key": manifest.key_consumers[0].key,
});
await requireSuccess("/demo/support/v1/items/1", { authorization: bearer });
await requireSuccess("/demo/sandbox/fixtures", {}, { expectBackend: false });

console.log(JSON.stringify({
  verified: true,
  routes: ["public", "key", "basic", "jwt", "multi-key", "multi-jwt", "response-mock"],
  negative_auth: "missing key credential rejected",
}));
