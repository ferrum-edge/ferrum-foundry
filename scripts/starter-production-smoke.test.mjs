import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  checkProbes,
  clientStreams,
  parseRequests,
  readPcap,
} from "../e2e/production-smoke/forwarded-headers.mjs";
import { appRedirectFromLocation } from "../e2e/production-smoke/direct-probe.mjs";
import { checkTokenExchange, s256Challenge } from "../e2e/production-smoke/pkce.mjs";

const OVERLAY = new URL("../e2e/production-smoke/compose.yaml", import.meta.url);
const SMOKE_LIB = fileURLToPath(new URL("../e2e/production-smoke/lib.sh", import.meta.url));
const STARTER_COMPOSE = fileURLToPath(new URL("../deploy/starter/compose.yaml", import.meta.url));
const STARTER_DEFAULT_SUBNET = "10.73.88.0/24";
const ZOMBIE_STAT_PATTERN = /^\d+ \(.*\) Z /s;
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
const SPOOFS = [
  "203.0.113.66",
  "spoofed.invalid",
  "/spoofed/uri",
  "smoke-spoofed-request-id",
  "spoofed-user",
  "spoofed-group",
  "spoofed-namespace",
  "spoofed-proof-secret",
];

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
      ["X-Real-IP", PEER],
      ["X-Forwarded-For", PEER],
      ["X-Forwarded-Proto", "https"],
      ["X-Forwarded-Host", HOST],
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
    .some((error) => error.includes('foundry-session: x-request-id "client-chosen" is not a value nginx sets')));

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
    'probe auth-session: x-auth-request-redirect must not reach oauth2-proxy on /oauth2/auth (1 sent, with the forged "spoofed.invalid")',
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

test("Foundry gets nginx's host and no client X-Forwarded-Uri or redirect", () => {
  const spoofedHost = cleanRequests();
  replaceHeader(spoofedHost[2], "x-forwarded-host", "spoofed.invalid");
  assert.ok(checkProbes(spoofedHost, EXPECTATIONS).errors
    .some((error) => error.includes("foundry-session: x-forwarded-host passed the client's value through")));

  for (const [header, value, marker] of [
    ["x-forwarded-uri", "/spoofed/uri", "/spoofed/uri"],
    ["x-auth-request-redirect", "https://spoofed.invalid/", "spoofed.invalid"],
  ]) {
    const requests = cleanRequests();
    requests[2].headers.push([header, value]);
    assert.deepEqual(checkProbes(requests, EXPECTATIONS).errors, [
      `probe foundry-session: ${header} must not reach foundry on /api/auth/session (1 sent, with the forged "${marker}")`,
    ]);
  }

  const other = cleanRequests();
  other[2].headers.push(["x-original-host", "spoofed.invalid"]);
  assert.deepEqual(checkProbes(other, EXPECTATIONS).errors, [
    'probe foundry-session: x-original-host carried the forged "spoofed.invalid" to foundry',
  ]);
});

test("a client's identity headers at Foundry fail", () => {
  for (const [header, value, marker] of [
    ["x-auth-request-user", "spoofed-user@example.com", "spoofed-user"],
    ["x-auth-request-email", "spoofed-user@example.com", "spoofed-user"],
    ["x-auth-request-preferred-username", "spoofed-user-name", "spoofed-user"],
    ["x-auth-request-groups", "ferrum-admins,spoofed-group", "spoofed-group"],
  ]) {
    const requests = cleanRequests();
    requests[2].headers.push([header, value]);
    const { errors, observed } = checkProbes(requests, EXPECTATIONS);
    assert.deepEqual(errors, [
      `probe foundry-session: ${header} must not reach foundry on /api/auth/session (1 sent, with the forged "${marker}")`,
    ]);
    // An identity value is never echoed into the job log.
    assert.ok(!JSON.stringify({ errors, observed }).includes(value), header);
  }
  // inject.conf replaces these; a client copy left beside nginx's fails.
  const forwardedUser = cleanRequests();
  forwardedUser[2].headers.push(["x-forwarded-user", "spoofed-user@example.com"]);
  assert.deepEqual(checkProbes(forwardedUser, EXPECTATIONS).errors, [
    'probe foundry-session: x-forwarded-user carried the forged "spoofed-user" to foundry',
  ]);
});

test("Foundry's X-Forwarded-For may carry the client's list only before nginx's peer", () => {
  const appended = cleanRequests();
  replaceHeader(appended[2], "x-forwarded-for", `203.0.113.66, ${PEER}`);
  assert.deepEqual(checkProbes(appended, EXPECTATIONS).errors, []);

  const lastHopSpoofed = cleanRequests();
  replaceHeader(lastHopSpoofed[2], "x-forwarded-for", `${PEER}, 203.0.113.66`);
  assert.ok(checkProbes(lastHopSpoofed, EXPECTATIONS).errors
    .some((error) => error.includes("does not end with nginx's peer")));
});

test("at oauth2-proxy, a client value in a header no rule covers is reported, not failed", () => {
  const requests = cleanRequests();
  requests[1].headers.push(["x-original-uri", "/spoofed/uri"]);
  const { errors, passthrough } = checkProbes(requests, EXPECTATIONS);
  assert.deepEqual(errors, []);
  assert.deepEqual(passthrough, [{
    probe: "auth-session",
    upstream: "oauth2-proxy",
    header: "x-original-uri",
    marker: "/spoofed/uri",
  }]);
});

// ---- PKCE: the token request, read off the wire -------------------------------

// RFC 7636 appendix B.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const MOCK_OIDC = "172.18.0.5";
const TOKEN_PATH = "/default/token";
const FAKE_CODE = "smoke-test-authorization-code";

function httpPost(target, body) {
  const bytes = Buffer.from(body, "latin1");
  return Buffer.concat([
    Buffer.from(
      `POST ${target} HTTP/1.1\r\nHost: mock-oidc:8080\r\n` +
        "Content-Type: application/x-www-form-urlencoded\r\n" +
        `Content-Length: ${bytes.length}\r\n\r\n`,
      "latin1",
    ),
    bytes,
  ]);
}

function tokenBody(overrides = {}) {
  const params = new URLSearchParams({
    code: FAKE_CODE,
    code_verifier: RFC_VERIFIER,
    grant_type: "authorization_code",
    redirect_uri: "https://foundry.example.com/oauth2/callback",
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) params.delete(name);
    else params.set(name, value);
  }
  return params.toString();
}

/** The requests oauth2-proxy sent the provider, through a synthetic capture. */
function capturedProviderRequests(...payloads) {
  const frames = payloads.map((payload, index) => sll2(ipv4Tcp({
    source: OAUTH2_PROXY, destination: MOCK_OIDC, sourcePort: 41000 + index, destinationPort: 8080,
    sequence: 1000, payload,
  })));
  return clientStreams(readPcap(pcap(276, frames)), 8080).flatMap(parseRequests);
}

test("the S256 challenge is RFC 7636's", () => {
  assert.equal(s256Challenge(RFC_VERIFIER), RFC_CHALLENGE);
});

test("a token request with the verifier of the authorize redirect's challenge passes", () => {
  const requests = capturedProviderRequests(
    // The discovery and JWKS reads share the port and are not token requests.
    httpRequest("/default/.well-known/openid-configuration", [["Host", "mock-oidc:8080"]]),
    httpPost(TOKEN_PATH, tokenBody()),
  );
  assert.equal(requests.at(-1).body.toString("latin1"), tokenBody());
  assert.deepEqual(checkTokenExchange(requests, { tokenPath: TOKEN_PATH, challenge: RFC_CHALLENGE }), []);
});

test("a token request without the matching verifier fails, without printing the body", () => {
  const otherVerifier = "a".repeat(43);
  for (const [overrides, expected] of [
    [{ code_verifier: undefined }, "the token request carries 0 code_verifier parameters, expected one"],
    [{ code_verifier: otherVerifier }, "the code_verifier's S256 digest is not the authorize redirect's code_challenge"],
    [{ code_verifier: "short" }, "the code_verifier is not 43-128 unreserved characters (length 5)"],
    [{ grant_type: "refresh_token" }, 'the token request is not one authorization_code grant (["refresh_token"])'],
  ]) {
    const errors = checkTokenExchange(
      capturedProviderRequests(httpPost(TOKEN_PATH, tokenBody(overrides))),
      { tokenPath: TOKEN_PATH, challenge: RFC_CHALLENGE },
    );
    assert.deepEqual(errors, [expected], JSON.stringify(overrides));
    for (const secret of [FAKE_CODE, RFC_VERIFIER, otherVerifier]) {
      assert.ok(!errors.join("\n").includes(secret), "no body value is echoed");
    }
  }
  const twice = `${tokenBody()}&code_verifier=${RFC_VERIFIER}`;
  assert.deepEqual(
    checkTokenExchange(capturedProviderRequests(httpPost(TOKEN_PATH, twice)), {
      tokenPath: TOKEN_PATH,
      challenge: RFC_CHALLENGE,
    }),
    ["the token request carries 2 code_verifier parameters, expected one"],
  );
});

test("no token request, two, or a malformed challenge fails rather than passing on nothing", () => {
  const options = { tokenPath: TOKEN_PATH, challenge: RFC_CHALLENGE };
  assert.deepEqual(checkTokenExchange([], options), [
    `expected exactly one token request to ${TOKEN_PATH}, found 0`,
  ]);
  const two = capturedProviderRequests(httpPost(TOKEN_PATH, tokenBody()), httpPost(TOKEN_PATH, tokenBody()));
  assert.deepEqual(checkTokenExchange(two, options), [
    `expected exactly one token request to ${TOKEN_PATH}, found 2`,
  ]);
  const one = capturedProviderRequests(httpPost(TOKEN_PATH, tokenBody()));
  for (const challenge of ["", "plain-challenge", `${RFC_CHALLENGE}=`]) {
    assert.deepEqual(checkTokenExchange(one, { tokenPath: TOKEN_PATH, challenge }), [
      "the authorize redirect's code_challenge is not an S256 challenge",
    ]);
  }
});

// ---- the trust boundary: the redirect oauth2-proxy chose -----------------------

test("the post-login redirect is read from the authorize redirect's state", () => {
  const authorize = "http://mock-oidc:8080/default/authorize?client_id=foundry-starter-smoke";
  // oauth2-proxy writes <nonce>:<url.QueryEscape(redirect)>, and the URL
  // query escapes the whole state again.
  const location = (redirect) =>
    `${authorize}&state=${encodeURIComponent(`nonce123:${encodeURIComponent(redirect)}`)}&code_challenge_method=S256`;
  assert.equal(appRedirectFromLocation(location("/trusted-probe")), "/trusted-probe");
  assert.equal(appRedirectFromLocation(location("/")), "/");
  assert.equal(appRedirectFromLocation(location("/a?b=c d")), "/a?b=c d");
  assert.equal(appRedirectFromLocation(authorize), null, "no state");
  assert.equal(appRedirectFromLocation(`${authorize}&state=nonce-only`), null);
  assert.equal(appRedirectFromLocation("not a url"), null);
});

// ---- run.sh helpers (lib.sh) -------------------------------------------------

// A stand-in for tcpdump: announces itself as tcpdump does, writes a capture
// to stdout, and exits on SIGINT. Node installs its own handler, so it hears
// SIGINT even though a background job starts with it ignored, as tcpdump does.
const FAKE_CAPTURE = `#!/usr/bin/env node
process.stderr.write("listening on fake, link-type LINUX_SLL2\\n");
process.stdout.write("captured");
process.on("SIGINT", () => process.exit(0));
setInterval(() => {}, 1000);
`;

function smokeDir() {
  const dir = mkdtempSync(join(tmpdir(), "starter-smoke-"));
  const tool = join(dir, "fake-capture");
  writeFileSync(tool, FAKE_CAPTURE);
  chmodSync(tool, 0o755);
  return { dir, tool };
}

// Runs `body` in bash with lib.sh sourced, as run.sh does.
function runLib(body, { dir, tool }) {
  return spawnSync(
    "bash",
    ["-c", `set -euo pipefail\nfail() { echo "::error::$*" >&2; exit 1; }\n. "$0"\n${body}`, SMOKE_LIB],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, WORK: dir, SMOKE_CAPTURE_SUDO: "env", SMOKE_CAPTURE_TOOL: tool },
    },
  );
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !ZOMBIE_STAT_PATTERN.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

async function stopped(pid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isRunning(pid)) return true;
    await delay(100);
  }
  return false;
}

const START = 'capture_start "tcp port 4180" "$WORK/capture.pcap" "$WORK/capture.log"';

test("capture_stop stops only the capture it started, and waits for its output", async () => {
  const smoke = smokeDir();
  // Another capture on the host, which a name-based pkill would also stop.
  const unrelated = spawn(smoke.tool, [], { stdio: "ignore" });
  try {
    const result = runLib(`${START}\ncapture_stop\ncat "$WORK/capture.pcap"`, smoke);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "captured", "the writer finished before capture_stop returned");
    const pid = Number(readFileSync(join(smoke.dir, "capture.pcap.pid"), "utf8"));
    assert.ok(await stopped(pid), "the capture process is stopped");
    assert.ok(isRunning(unrelated.pid), "an unrelated capture keeps running");
  } finally {
    unrelated.kill("SIGKILL");
    rmSync(smoke.dir, { recursive: true, force: true });
  }
});

test("a failure or a signal after capture_start stops the capture and keeps the exit status", async () => {
  for (const [body, status] of [
    ["exit 7", 7],
    ["false", 1],
    ['fail "probe failed"', 1],
    ["kill -TERM $$\nsleep 5", 143],
  ]) {
    const smoke = smokeDir();
    try {
      const result = runLib(`${START}\n${body}\necho unreachable`, smoke);
      assert.equal(result.status, status, `${body}: ${result.stderr}`);
      assert.ok(!result.stdout.includes("unreachable"), body);
      const pid = Number(readFileSync(join(smoke.dir, "capture.pcap.pid"), "utf8"));
      assert.ok(await stopped(pid), `${body}: the capture process is stopped`);
      assert.equal(readFileSync(join(smoke.dir, "capture.pcap"), "utf8"), "captured", body);
    } finally {
      rmSync(smoke.dir, { recursive: true, force: true });
    }
  }
});

test("a log that cannot be read, or is empty, fails instead of passing as clean", () => {
  const smoke = smokeDir();
  try {
    const unreadable = runLib('read_log "the log" "$WORK/a.log" false\necho judged', smoke);
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stderr, /could not read the log/);
    assert.ok(!unreadable.stdout.includes("judged"));

    const empty = runLib('read_log "the log" "$WORK/b.log" true\necho judged', smoke);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /the log is empty/);

    const clean = runLib(
      'read_log "the log" "$WORK/c.log" printf "host foundry.example.com\\n"\n' +
        'log_names_none "the log" "$WORK/c.log" spoofed.invalid 203.0.113.66',
      smoke,
    );
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /ok: the log names no spoofed value/);

    const spoofed = runLib(
      'read_log "the log" "$WORK/d.log" printf "host spoofed.invalid\\n"\n' +
        'log_names_none "the log" "$WORK/d.log" spoofed.invalid',
      smoke,
    );
    assert.equal(spoofed.status, 1);
    assert.match(spoofed.stderr, /the log names a spoofed value/);
  } finally {
    rmSync(smoke.dir, { recursive: true, force: true });
  }
});

// ---- check 4: the trusted range and the outside network -----------------------

test("the trusted range is read from the rendered Compose configuration", () => {
  const smoke = smokeDir();
  try {
    const rendered = JSON.stringify({
      networks: { default: { ipam: { config: [{ subnet: "10.75.88.0/24" }] } } },
      services: {
        "oauth2-proxy": {
          command: ["--provider=oidc", "--reverse-proxy=true", "--trusted-proxy-ip=10.75.88.0/24"],
        },
      },
    });
    writeFileSync(join(smoke.dir, "rendered.json"), rendered);
    const result = runLib(
      'rendered_subnets < "$WORK/rendered.json"\nrendered_trusted_proxy_ips < "$WORK/rendered.json"',
      smoke,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "10.75.88.0/24\n10.75.88.0/24\n");

    writeFileSync(join(smoke.dir, "bare.json"), JSON.stringify({ networks: {}, services: {} }));
    const bare = runLib('rendered_subnets < "$WORK/bare.json"\nrendered_trusted_proxy_ips < "$WORK/bare.json"', smoke);
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(bare.stdout, "\n\n", "nothing rendered is an empty value, which run.sh refuses");
  } finally {
    rmSync(smoke.dir, { recursive: true, force: true });
  }
});

test("IPv4 ranges are compared by address, and a malformed one fails", () => {
  const smoke = smokeDir();
  try {
    for (const [left, right, overlap] of [
      ["10.73.88.0/24", "10.73.88.0/24", true],
      ["10.73.88.0/24", "10.73.88.128/25", true],
      ["10.0.0.0/8", "10.74.88.0/24", true],
      ["10.73.88.0/24", "10.73.89.0/24", false],
      ["10.73.88.0/24", "172.18.0.0/16", false],
      ["0.0.0.0/0", "192.168.1.0/24", true],
      // A host address with a prefix is its network.
      ["10.73.88.77/24", "10.73.88.0/30", true],
      ["010.073.088.000/24", "10.73.88.0/24", true],
    ]) {
      const result = runLib(`ipv4_cidrs_overlap ${left} ${right} && echo overlap || echo disjoint`, smoke);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), overlap ? "overlap" : "disjoint", `${left} ${right}`);
    }
    for (const bad of ["10.73.88.0", "10.73.88.256/24", "10.73.88.0/33", "fd00::/64", ""]) {
      const result = runLib(`ipv4_cidrs_overlap "${bad}" 10.0.0.0/8 && echo overlap || echo disjoint`, smoke);
      assert.equal(result.status, 1, bad);
      assert.match(result.stderr, /is not an IPv4 CIDR/, bad);
      assert.equal(result.stdout, "", `${bad} must not be read as either answer`);
    }
  } finally {
    rmSync(smoke.dir, { recursive: true, force: true });
  }
});

function dockerComposeAvailable() {
  return spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
}

test(
  "Compose takes FOUNDRY_STARTER_SUBNET from the starter's .env, and run.sh reads what Compose renders",
  { skip: !dockerComposeAvailable() && "docker compose is not installed" },
  () => {
    // `docker compose config` only renders files; it needs no daemon. A copy of
    // the shipped compose.yaml in a scratch project directory, with a .env
    // there, is exactly the operator's file-only override.
    const smoke = smokeDir();
    const project = join(smoke.dir, "starter");
    try {
      mkdirSync(project);
      copyFileSync(STARTER_COMPOSE, join(project, "compose.yaml"));
      const required = [
        "FERRUM_ADMIN_URL=https://ferrum-admin.internal:9000",
        "FERRUM_JWT_SECRET=dev-secret-at-least-32-characters-long",
        "FERRUM_TRUSTED_PROXY_SECRET=dev-bff-token-at-least-32-characters-long",
      ];
      const env = { ...process.env };
      delete env.FOUNDRY_STARTER_SUBNET;
      const render = (dotenv, extra = {}) => {
        writeFileSync(join(project, ".env"), `${dotenv.join("\n")}\n`);
        writeFileSync(join(smoke.dir, "render.sh"), [
          `. "${SMOKE_LIB}"`,
          `rendered="$(docker compose -f "${join(project, "compose.yaml")}" --profile production config --format json)"`,
          'rendered_subnets <<<"$rendered"',
          'rendered_trusted_proxy_ips <<<"$rendered"',
        ].join("\n"));
        const result = spawnSync("bash", ["-c", 'set -euo pipefail\nfail() { echo "::error::$*" >&2; exit 1; }\n. "$0"', join(smoke.dir, "render.sh")], {
          encoding: "utf8",
          timeout: 60_000,
          env: { ...env, ...extra },
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim().split("\n");
      };

      assert.deepEqual(render(required), [STARTER_DEFAULT_SUBNET, STARTER_DEFAULT_SUBNET]);
      assert.deepEqual(
        render([...required, "FOUNDRY_STARTER_SUBNET=10.75.88.0/24"]),
        ["10.75.88.0/24", "10.75.88.0/24"],
        "a .env-only override reaches both the network and --trusted-proxy-ip",
      );
      assert.deepEqual(
        render([...required, "FOUNDRY_STARTER_SUBNET=10.75.88.0/24"], { FOUNDRY_STARTER_SUBNET: "10.76.88.0/24" }),
        ["10.76.88.0/24", "10.76.88.0/24"],
        "the shell wins over .env, as Compose documents",
      );
    } finally {
      rmSync(smoke.dir, { recursive: true, force: true });
    }
  },
);

test("check 4 lets Docker allocate the outside network and proves it disjoint", async () => {
  const run = await readFile(new URL("../e2e/production-smoke/run.sh", import.meta.url), "utf8");
  const boundary = run.slice(run.indexOf("trust_boundary() {"));
  assert.ok(!boundary.includes("docker network create --subnet"), "no hardcoded outside range that could overlap");
  assert.ok(boundary.includes('docker network create "$OUTSIDE_NETWORK"'));
  assert.ok(boundary.indexOf("ipv4_cidrs_overlap") < boundary.indexOf("docker network connect"),
    "the overlap check runs before oauth2-proxy is attached");
  assert.ok(boundary.includes('expect_equal "the running network\'s subnet" "$subnet" "$expected"'));
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
