import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { SignJWT } from "jose";

const manifestPath = process.env.FERRUM_DEMO_MANIFEST ?? "/tmp/ferrum-foundry-demo-manifest.json";
const clientName = process.argv[2] ?? "mixed";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const profiles = {
  key: ["key"],
  basic: ["basic"],
  jwt: ["jwt"],
  partner: ["multi"],
  public: ["public", "mock"],
  mixed: ["key", "basic", "jwt", "multi", "public", "mock"],
};

const authTypes = profiles[clientName] ?? profiles.mixed;
const routes = manifest.routes.filter((route) => authTypes.includes(route.auth));

if (routes.length === 0) {
  throw new Error(`No demo routes found for traffic client "${clientName}"`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

async function makeJwt(consumer) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: "demo:read" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(consumer.username)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(consumer.secret));
}

async function headersForRoute(route) {
  const headers = {
    accept: "application/json",
    "user-agent": `FerrumDemoClient/${clientName}`,
    "x-demo-user": `${clientName}-${Math.floor(Math.random() * 20)}`,
  };

  if (route.auth === "key" || (route.auth === "multi" && Math.random() < 0.5)) {
    headers["x-api-key"] = pick(manifest.key_consumers).key;
    return headers;
  }

  if (route.auth === "basic") {
    const consumer = pick(manifest.basic_consumers);
    headers.authorization = `Basic ${Buffer.from(`${consumer.username}:${consumer.password}`).toString("base64")}`;
    return headers;
  }

  if (route.auth === "jwt" || route.auth === "multi") {
    const consumer = pick(manifest.jwt_consumers);
    headers.authorization = `Bearer ${await makeJwt(consumer)}`;
    return headers;
  }

  return headers;
}

let total = 0;
let failures = 0;

while (true) {
  const route = pick(routes);
  const path = route.auth === "mock" && Math.random() < 0.6
    ? `${route.path}/fixtures`
    : `${route.path}/v1/items/${Math.floor(Math.random() * 50)}?client=${clientName}`;
  const url = `${manifest.proxy_base_url}${path}`;
  const shouldPost = Math.random() < 0.15;

  try {
    const response = await fetch(url, {
      method: shouldPost ? "POST" : "GET",
      headers: await headersForRoute(route),
      body: shouldPost ? JSON.stringify({ client: clientName, at: new Date().toISOString() }) : undefined,
    });
    await response.arrayBuffer();
    total += 1;
    if (!response.ok) failures += 1;
    if (total % 25 === 0) {
      console.log(`${new Date().toISOString()} ${clientName}: ${total} requests, ${failures} non-2xx`);
    }
  } catch (error) {
    failures += 1;
    console.error(`${new Date().toISOString()} ${clientName}: ${error instanceof Error ? error.message : String(error)}`);
  }

  await sleep(80 + Math.floor(Math.random() * 220));
}
