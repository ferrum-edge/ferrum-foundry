import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  checkProbes,
  clientStreams,
  parseRequests,
  readPcap,
} from "../e2e/production-smoke/forwarded-headers.mjs";

const OVERLAY = new URL("../e2e/production-smoke/compose.yaml", import.meta.url);
const COMPOSE_IMAGE_PATTERN = /^\s+image:\s*(\S+)/gm;
const TOP_LEVEL_SERVICE_PATTERN = /^ {2}([a-z0-9][\w.-]*):\s*$/gm;
const TAG_AND_DIGEST_PATTERN = /^[a-z0-9./_-]+:[A-Za-z0-9_][A-Za-z0-9_.-]*@sha256:[0-9a-f]{64}$/;
const DEPENDABOT_COMPOSE_DIRECTORY_PATTERN =
  /package-ecosystem:\s*"docker-compose"\s*\n\s*directory:\s*"([^"]+)"/g;
const SHIPPED_SERVICE_PATTERN = /^ {2}(foundry|oauth2-proxy|proxy|demo-[\w-]+):/m;

const NGINX = "172.18.0.4";
const OAUTH2_PROXY = "172.18.0.3";
const PEER = "172.18.0.1";
const HOST = "foundry.example.com";
const SPOOFS = ["203.0.113.66", "spoofed.invalid", "/spoofed/uri", "smoke-spoofed-request-id"];

// ---- synthetic captures ----------------------------------------------------

function ipv4Tcp({ source, destination, sourcePort, destinationPort, sequence, syn = false, payload = Buffer.alloc(0) }) {
  const ip = Buffer.alloc(20);
  ip[0] = 0x45;
  ip.writeUInt16BE(20 + 20 + payload.length, 2);
  ip[8] = 64;
  ip[9] = 6;
  source.split(".").forEach((octet, index) => { ip[12 + index] = Number(octet); });
  destination.split(".").forEach((octet, index) => { ip[16 + index] = Number(octet); });
  const tcp = Buffer.alloc(20);
  tcp.writeUInt16BE(sourcePort, 0);
  tcp.writeUInt16BE(destinationPort, 2);
  tcp.writeUInt32BE(sequence >>> 0, 4);
  tcp[12] = 5 << 4;
  tcp[13] = syn ? 0x02 : 0x18;
  return Buffer.concat([ip, tcp, payload]);
}

function ethernet(packet) {
  const header = Buffer.alloc(14);
  header.writeUInt16BE(0x0800, 12);
  return Buffer.concat([header, packet]);
}

function sll2(packet) {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0800, 0);
  return Buffer.concat([header, packet]);
}

function pcap(linkType, frames, { littleEndian = true } = {}) {
  const write32 = (buffer, value, offset) =>
    littleEndian ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
  const write16 = (buffer, value, offset) =>
    littleEndian ? buffer.writeUInt16LE(value, offset) : buffer.writeUInt16BE(value, offset);
  const header = Buffer.alloc(24);
  write32(header, 0xa1b2c3d4, 0);
  write16(header, 2, 4);
  write16(header, 4, 6);
  write32(header, 262144, 16);
  write32(header, linkType, 20);
  const records = frames.map((frame) => {
    const record = Buffer.alloc(16);
    write32(record, frame.length, 8);
    write32(record, frame.length, 12);
    return Buffer.concat([record, frame]);
  });
  return Buffer.concat([header, ...records]);
}

function httpRequest(target, headers) {
  const lines = [`GET ${target} HTTP/1.0`, ...headers.map(([name, value]) => `${name}: ${value}`)];
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

const NGINX_REQUEST_ID = "0123456789abcdef0123456789abcdef";

function nginxHeaders(uri, { redirect = false } = {}) {
  return [
    ["Host", HOST],
    ["X-Real-IP", PEER],
    ["X-Forwarded-For", PEER],
    ["X-Forwarded-Host", HOST],
    ["X-Forwarded-Proto", "https"],
    ["X-Forwarded-Uri", uri],
    ["X-Request-Id", NGINX_REQUEST_ID],
    ...(redirect ? [["X-Auth-Request-Redirect", uri]] : []),
  ];
}

const EXPECTATIONS = {
  port: 4180,
  host: HOST,
  proto: "https",
  spoofs: SPOOFS,
  probes: [
    { id: "start", path: "/oauth2/start", uri: "/oauth2/start?rd=%2F" },
    { id: "auth-session", path: "/oauth2/auth", uri: "/api/auth/session" },
    {
      id: "foundry-session",
      marker: "auth-session",
      upstream: "foundry",
      port: 8080,
      path: "/api/auth/session",
    },
  ],
};

function request(target, headers, port) {
  return { ...parseRequests(httpRequest(target, headers))[0], port };
}

function cleanRequests() {
  return [
    request("/oauth2/start?rd=%2F", [
      ...nginxHeaders("/oauth2/start?rd=%2F", { redirect: true }),
      ["x-smoke-probe", "start"],
    ], 4180),
    request("/oauth2/auth", [
      ...nginxHeaders("/api/auth/session"),
      ["x-smoke-probe", "auth-session"],
    ], 4180),
    // The same probe, as nginx proxies it on to Foundry.
    request("/api/auth/session", [
      ["Host", HOST],
      ["X-Request-Id", NGINX_REQUEST_ID],
      ["x-smoke-probe", "auth-session"],
    ], 8080),
  ];
}

function replaceHeader(requestToChange, header, value) {
  requestToChange.headers = requestToChange.headers.map(([name, current]) =>
    name === header ? [name, value] : [name, current]);
}

// ---- capture parsing -------------------------------------------------------

test("a request split across segments and captured on every interface is read once", () => {
  const payload = httpRequest("/oauth2/auth", [...nginxHeaders("/api/auth/session"), ["x-smoke-probe", "auth-session"]]);
  const isn = 0xfffffff0; // the sequence space wraps inside this request
  const segment = (sequence, bytes) => ipv4Tcp({
    source: NGINX, destination: OAUTH2_PROXY, sourcePort: 40000, destinationPort: 4180, sequence, payload: bytes,
  });
  const first = payload.subarray(0, 40);
  const second = payload.subarray(40);
  const frames = [
    ipv4Tcp({ source: NGINX, destination: OAUTH2_PROXY, sourcePort: 40000, destinationPort: 4180, sequence: isn, syn: true }),
    // nginx's veth, the bridge, and oauth2-proxy's veth: once split, once coalesced.
    segment(isn + 1, first),
    segment(isn + 1 + first.length, second),
    segment(isn + 1, payload),
    segment(isn + 1, first),
    segment(isn + 1 + first.length, second),
    // The reply direction is not the client's stream.
    ipv4Tcp({
      source: OAUTH2_PROXY, destination: NGINX, sourcePort: 4180, destinationPort: 40000, sequence: 7,
      payload: Buffer.from("HTTP/1.1 401 Unauthorized\r\n\r\n"),
    }),
  ].map(sll2);

  const streams = clientStreams(readPcap(pcap(276, frames)), 4180);
  assert.equal(streams.length, 1);
  assert.deepEqual(streams[0], payload);
  const requests = parseRequests(streams[0]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].target, "/oauth2/auth");
  assert.deepEqual(
    requests[0].headers.find(([name]) => name === "x-forwarded-uri"),
    ["x-forwarded-uri", "/api/auth/session"],
  );
});

test("an Ethernet capture yields one stream per connection, and a cut-off record is ignored", () => {
  const frames = [40001, 40002].map((port) => ethernet(ipv4Tcp({
    source: NGINX, destination: OAUTH2_PROXY, sourcePort: port, destinationPort: 4180, sequence: 100,
    payload: httpRequest(`/oauth2/start?port=${port}`, nginxHeaders("/oauth2/start", { redirect: true })),
  })));
  const capture = pcap(1, frames, { littleEndian: false });
  const truncated = Buffer.concat([capture, Buffer.alloc(16, 0xff)]);
  const targets = clientStreams(readPcap(truncated), 4180)
    .flatMap(parseRequests)
    .map((parsed) => parsed.target)
    .sort();
  assert.deepEqual(targets, ["/oauth2/start?port=40001", "/oauth2/start?port=40002"]);
});

test("a pcapng or foreign file is refused rather than read as empty", () => {
  assert.throws(() => readPcap(Buffer.alloc(32)), /not a pcap capture/);
});

// ---- probe verdicts ----------------------------------------------------------

test("nginx's own forwarded headers pass", () => {
  const { errors, observed, passthrough } = checkProbes(cleanRequests(), EXPECTATIONS);
  assert.deepEqual(errors, []);
  assert.deepEqual(observed.map((entry) => entry.probe), ["start", "auth-session", "foundry-session"]);
  assert.deepEqual(observed[1].headers["x-auth-request-redirect"], [], "the auth subrequest sends no redirect");
  assert.deepEqual(passthrough, []);
});

test("a client's forwarded value reaching oauth2-proxy fails", () => {
  const requests = cleanRequests();
  // $proxy_add_x_forwarded_for appends to the client's list instead of replacing it.
  replaceHeader(requests[1], "x-forwarded-for", `203.0.113.66, ${PEER}`);
  const { errors } = checkProbes(requests, EXPECTATIONS);
  assert.ok(errors.some((error) => error.includes("auth-session: x-forwarded-for passed the client's value through")));
});

test("a client's X-Request-Id reaching any upstream fails", () => {
  for (const index of [0, 1, 2]) {
    const requests = cleanRequests();
    replaceHeader(requests[index], "x-request-id", "smoke-spoofed-request-id");
    const { errors } = checkProbes(requests, EXPECTATIONS);
    assert.ok(
      errors.some((error) => error.includes("x-request-id passed the client's value through")),
      `request ${index}: ${errors.join("; ")}`,
    );
  }
  const notNginx = cleanRequests();
  replaceHeader(notNginx[2], "x-request-id", "client-chosen");
  assert.ok(checkProbes(notNginx, EXPECTATIONS).errors
    .some((error) => error.includes("foundry-session: x-request-id \"client-chosen\" is not nginx's $request_id")));

  const missing = cleanRequests();
  missing[0].headers = missing[0].headers.filter(([name]) => name !== "x-request-id");
  assert.ok(checkProbes(missing, EXPECTATIONS).errors
    .some((error) => error.includes("start: x-request-id arrived 0 times")));
});

test("a client's X-Auth-Request-Redirect on the auth subrequest fails", () => {
  const requests = cleanRequests();
  requests[1].headers.push(["x-auth-request-redirect", "https://spoofed.invalid/after-login"]);
  const { errors } = checkProbes(requests, EXPECTATIONS);
  assert.deepEqual(errors, [
    'probe auth-session: x-auth-request-redirect must not reach /oauth2/auth (["https://spoofed.invalid/after-login"])',
  ]);
});

test("a duplicated, missing, or rewritten header fails", () => {
  const duplicated = cleanRequests();
  duplicated[1].headers.push(["x-forwarded-uri", "/spoofed/uri"]);
  assert.ok(checkProbes(duplicated, EXPECTATIONS).errors
    .some((error) => error.includes("x-forwarded-uri arrived 2 times")));

  const noRedirect = cleanRequests();
  noRedirect[0].headers = noRedirect[0].headers.filter(([name]) => name !== "x-auth-request-redirect");
  assert.ok(checkProbes(noRedirect, EXPECTATIONS).errors
    .some((error) => error.includes("start: x-auth-request-redirect arrived 0 times")));

  const wrongProto = cleanRequests();
  replaceHeader(wrongProto[0], "x-forwarded-proto", "http");
  assert.ok(checkProbes(wrongProto, EXPECTATIONS).errors
    .some((error) => error.includes('start: x-forwarded-proto is "http", expected "https"')));
});

test("a probe that never reached its upstream fails, so the check cannot pass on nothing", () => {
  const { errors } = checkProbes(cleanRequests().slice(0, 1), EXPECTATIONS);
  assert.deepEqual(errors, [
    "probe auth-session: expected exactly one request at oauth2-proxy, found 0",
    "probe foundry-session: expected exactly one request at foundry, found 0",
  ]);
});

test("a client value in a header no check covers is reported, not failed", () => {
  const requests = cleanRequests();
  requests[2].headers.push(["x-forwarded-host", "spoofed.invalid"]);
  const { errors, passthrough } = checkProbes(requests, EXPECTATIONS);
  assert.deepEqual(errors, []);
  assert.deepEqual(passthrough, [{
    probe: "foundry-session",
    upstream: "foundry",
    header: "x-forwarded-host",
    value: "spoofed.invalid",
  }]);
});

// ---- the overlay -------------------------------------------------------------

test("the smoke overlay adds a provider and leaves every shipped service alone", async () => {
  const overlay = await readFile(OVERLAY, "utf8");
  const services = [...overlay.matchAll(TOP_LEVEL_SERVICE_PATTERN)].map((match) => match[1]);
  assert.deepEqual(services, ["mock-oidc"]);
  assert.ok(!SHIPPED_SERVICE_PATTERN.test(overlay), "the smoke test must run the shipped services unchanged");
});

test("the smoke overlay pins its image by tag and digest, and Dependabot moves it", async () => {
  const overlay = await readFile(OVERLAY, "utf8");
  const images = [...overlay.matchAll(COMPOSE_IMAGE_PATTERN)].map((match) => match[1]);
  assert.equal(images.length, 1);
  for (const image of images) {
    assert.match(image, TAG_AND_DIGEST_PATTERN, `${image} must be written as name:tag@sha256:<digest>`);
  }
  const config = await readFile(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  const directories = [...config.matchAll(DEPENDABOT_COMPOSE_DIRECTORY_PATTERN)].map((match) => match[1]);
  assert.ok(directories.includes("/e2e/production-smoke"));
});
