#!/usr/bin/env node
// ------------------------------------------------------------------
// What nginx actually sends oauth2-proxy and Foundry, read off the wire
// ------------------------------------------------------------------
//
// The production smoke test (run.sh) captures the plaintext traffic from the
// starter's nginx to oauth2-proxy (port 4180) and to Foundry (port 8080) while
// it sends probes carrying spoofed values. This reads that capture,
// reassembles each TCP stream nginx opened, and checks every probe's request:
//
//   - at oauth2-proxy, each forwarded header it reads with --reverse-proxy
//     (X-Forwarded-For/-Host/-Proto/-Uri, X-Real-IP) arrives exactly once,
//     with nginx's own value; X-Auth-Request-Redirect arrives once, set to
//     the request URI, on the /oauth2/ sign-in routes, and not at all on the
//     /oauth2/auth subrequest;
//   - at Foundry, which trusts X-Forwarded-* from nginx, X-Forwarded-Host,
//     -Proto and X-Real-IP are nginx's, X-Forwarded-For ends with nginx's
//     peer, and X-Forwarded-Uri, X-Auth-Request-Redirect and oauth2-proxy's
//     X-Auth-Request-* identity headers are not sent;
//   - at every upstream, X-Request-Id is nginx's own $request_id;
//   - no spoofed value reaches the upstream in any of them.
//
// "Spoofed value" means one of the marker strings in the expectations: the
// probes put a marker in every forwarded and identity value they forge (all
// but the role, an enum the session check covers). Any other header carrying
// a marker fails at Foundry and is reported at oauth2-proxy (see
// e2e/README.md). A client header with no marker is not detected.
//
//   node e2e/production-smoke/forwarded-headers.mjs <capture.pcap> <expectations.json>

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

/** Read by oauth2-proxy's redirect logic, which only /oauth2/ routes run. */
export const REDIRECT_HEADER = "x-auth-request-redirect";

/** Logged by oauth2-proxy as the request ID; nginx sends its own $request_id. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * oauth2-proxy's identity response headers. nginx reads them from the auth
 * subrequest; a client's copies must never reach Foundry under these names.
 */
export const CLEARED_TOWARD_FOUNDRY = [
  "x-auth-request-user",
  "x-auth-request-email",
  "x-auth-request-preferred-username",
  "x-auth-request-groups",
];

/** The header the smoke test marks each probe with. nginx forwards it untouched. */
export const PROBE_HEADER = "x-smoke-probe";

const PCAP_MAGIC = new Map([
  [0xa1b2c3d4, { littleEndian: false }],
  [0xd4c3b2a1, { littleEndian: true }],
  [0xa1b23c4d, { littleEndian: false }],
  [0x4d3cb2a1, { littleEndian: true }],
]);
const LINKTYPE_ETHERNET = 1;
const LINKTYPE_LINUX_SLL = 113;
const LINKTYPE_LINUX_SLL2 = 276;
const ETHERTYPE_IPV4 = 0x0800;
const ETHERTYPE_IPV6 = 0x86dd;
const ETHERTYPE_VLAN = 0x8100;
const PROTOCOL_TCP = 6;
const TCP_FLAG_SYN = 0x02;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const HEADER_END = Buffer.from("\r\n\r\n");
const REQUEST_LINE_PATTERN = /^([A-Z]+) (\S+) HTTP\/\d\.\d$/;
const CONTENT_LENGTH_PATTERN = /^\d+$/;
const NGINX_REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;

/** One packet's link-layer payload offset and EtherType, or undefined to skip it. */
function linkLayer(linkType, packet) {
  if (linkType === LINKTYPE_ETHERNET) {
    if (packet.length < 14) return undefined;
    let offset = 12;
    let etherType = packet.readUInt16BE(offset);
    while (etherType === ETHERTYPE_VLAN && packet.length >= offset + 6) {
      offset += 4;
      etherType = packet.readUInt16BE(offset);
    }
    return { offset: offset + 2, etherType };
  }
  if (linkType === LINKTYPE_LINUX_SLL) {
    if (packet.length < 16) return undefined;
    return { offset: 16, etherType: packet.readUInt16BE(14) };
  }
  if (linkType === LINKTYPE_LINUX_SLL2) {
    if (packet.length < 20) return undefined;
    return { offset: 20, etherType: packet.readUInt16BE(0) };
  }
  throw new Error(`unsupported pcap link type ${linkType}`);
}

function ipv6Text(bytes) {
  const groups = [];
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index).toString(16));
  return groups.join(":");
}

/** The TCP segment carried by one captured frame, or undefined for anything else. */
function tcpSegment(linkType, packet) {
  const link = linkLayer(linkType, packet);
  if (!link) return undefined;
  let offset = link.offset;
  let source;
  let destination;
  let end;
  if (link.etherType === ETHERTYPE_IPV4) {
    if (packet.length < offset + 20) return undefined;
    const headerLength = (packet[offset] & 0x0f) * 4;
    if (packet[offset + 9] !== PROTOCOL_TCP) return undefined;
    const totalLength = packet.readUInt16BE(offset + 2);
    source = [...packet.subarray(offset + 12, offset + 16)].join(".");
    destination = [...packet.subarray(offset + 16, offset + 20)].join(".");
    // A segment offloaded to the NIC can carry a zero total length.
    end = totalLength > 0 ? Math.min(packet.length, offset + totalLength) : packet.length;
    offset += headerLength;
  } else if (link.etherType === ETHERTYPE_IPV6) {
    if (packet.length < offset + 40) return undefined;
    if (packet[offset + 6] !== PROTOCOL_TCP) return undefined;
    const payloadLength = packet.readUInt16BE(offset + 4);
    source = ipv6Text(packet.subarray(offset + 8, offset + 24));
    destination = ipv6Text(packet.subarray(offset + 24, offset + 40));
    end = payloadLength > 0 ? Math.min(packet.length, offset + 40 + payloadLength) : packet.length;
    offset += 40;
  } else {
    return undefined;
  }
  if (end < offset + 20) return undefined;
  const dataOffset = (packet[offset + 12] >> 4) * 4;
  return {
    source,
    destination,
    sourcePort: packet.readUInt16BE(offset),
    destinationPort: packet.readUInt16BE(offset + 2),
    sequence: packet.readUInt32BE(offset + 4),
    syn: (packet[offset + 13] & TCP_FLAG_SYN) !== 0,
    payload: packet.subarray(offset + dataOffset, end),
  };
}

/** Every TCP segment in a classic pcap file. */
export function readPcap(buffer) {
  if (buffer.length < 24) throw new Error("capture is shorter than a pcap header");
  const format = PCAP_MAGIC.get(buffer.readUInt32BE(0));
  if (!format) throw new Error("not a pcap capture (pcapng is not supported)");
  const read32 = (offset) =>
    format.littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const linkType = read32(20);
  const segments = [];
  let offset = 24;
  while (offset + 16 <= buffer.length) {
    const capturedLength = read32(offset + 8);
    const start = offset + 16;
    // tcpdump stopped mid-write: the last record is partial and carries nothing usable.
    if (start + capturedLength > buffer.length) break;
    const segment = tcpSegment(linkType, buffer.subarray(start, start + capturedLength));
    if (segment) segments.push(segment);
    offset = start + capturedLength;
  }
  return segments;
}

/**
 * The bytes each client sent to `port`, one entry per TCP connection, in
 * order. A capture on `any` sees the same segment on several interfaces (each
 * container's veth and the bridge), possibly coalesced differently, so bytes
 * are placed by sequence number rather than appended.
 */
export function clientStreams(segments, port) {
  const streams = new Map();
  for (const segment of segments) {
    if (segment.destinationPort !== port) continue;
    const key = `${segment.source}:${segment.sourcePort}>${segment.destination}:${segment.destinationPort}`;
    let stream = streams.get(key);
    if (!stream) {
      stream = { synBase: undefined, pieces: [] };
      streams.set(key, stream);
    }
    if (segment.syn) stream.synBase = (segment.sequence + 1) >>> 0;
    if (segment.payload.length > 0) stream.pieces.push(segment);
  }
  const result = [];
  for (const stream of streams.values()) {
    if (stream.pieces.length === 0) continue;
    const base = stream.synBase ?? Math.min(...stream.pieces.map((piece) => piece.sequence));
    let length = 0;
    const placed = [];
    for (const piece of stream.pieces) {
      const position = (piece.sequence - base) >>> 0;
      if (position + piece.payload.length > MAX_STREAM_BYTES) continue;
      placed.push({ position, payload: piece.payload });
      length = Math.max(length, position + piece.payload.length);
    }
    const bytes = Buffer.alloc(length);
    const filled = new Uint8Array(length);
    for (const { position, payload } of placed) {
      payload.copy(bytes, position);
      filled.fill(1, position, position + payload.length);
    }
    // Stop at the first byte no capture point saw.
    const gap = filled.indexOf(0);
    result.push(gap === -1 ? bytes : bytes.subarray(0, gap));
  }
  return result;
}

/** The HTTP/1.x request heads in one client byte stream. */
export function parseRequests(stream) {
  const requests = [];
  let offset = 0;
  while (offset < stream.length) {
    const end = stream.indexOf(HEADER_END, offset);
    if (end === -1) break;
    const lines = stream.subarray(offset, end).toString("latin1").split("\r\n");
    const requestLine = REQUEST_LINE_PATTERN.exec(lines[0]);
    if (!requestLine) break;
    const headers = [];
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
    }
    requests.push({ method: requestLine[1], target: requestLine[2], headers });
    const contentLength = headers.find(([name]) => name === "content-length")?.[1];
    offset = end + HEADER_END.length;
    if (contentLength && CONTENT_LENGTH_PATTERN.test(contentLength)) offset += Number(contentLength);
  }
  return requests;
}

function values(request, name) {
  return request.headers.filter(([header]) => header === name).map(([, value]) => value);
}

function containsSpoof(value, spoofs) {
  return spoofs.find((spoof) => value.includes(spoof));
}

/**
 * What nginx must send each upstream for one probe: headers that arrive once
 * with nginx's value, and headers that must not arrive at all.
 */
function rulesFor(probe, upstream, { host, proto }) {
  const isAddress = (value) => isIP(value) !== 0;
  const isRequestId = (value) => NGINX_REQUEST_ID_PATTERN.test(value);
  if (upstream === "oauth2-proxy") {
    // The sign-in routes read the redirect header, so nginx sets it there;
    // the auth subrequest does not, and nginx clears it.
    const signIn = probe.path !== "/oauth2/auth";
    return {
      exact: {
        "x-forwarded-host": host,
        "x-forwarded-proto": proto,
        "x-forwarded-uri": probe.uri,
        "x-real-ip": isAddress,
        "x-forwarded-for": "x-real-ip",
        [REQUEST_ID_HEADER]: isRequestId,
        ...(signIn ? { [REDIRECT_HEADER]: probe.uri } : {}),
      },
      absent: signIn ? [] : [REDIRECT_HEADER],
      appendedForwardedFor: false,
    };
  }
  // Foundry trusts X-Forwarded-* from nginx (its directly connected hop), so
  // nginx sets or clears every one. X-Forwarded-For is the exception by
  // design: nginx appends its peer to the client's list, and the BFF trusts
  // only that last hop, so the last entry must be nginx's peer.
  return {
    exact: {
      "x-forwarded-host": host,
      "x-forwarded-proto": proto,
      "x-real-ip": isAddress,
      [REQUEST_ID_HEADER]: isRequestId,
    },
    absent: ["x-forwarded-uri", REDIRECT_HEADER, ...CLEARED_TOWARD_FOUNDRY],
    appendedForwardedFor: true,
  };
}

/**
 * Checks every probe against what reached its upstream. Returns the failures,
 * the checked headers each probe arrived with, and the client values that
 * reached oauth2-proxy in headers no rule covers (at Foundry those fail).
 */
export function checkProbes(requests, expectations) {
  const { spoofs, probes } = expectations;
  const errors = [];
  const observed = [];
  const passthrough = [];
  for (const probe of probes) {
    const upstream = probe.upstream ?? "oauth2-proxy";
    const port = probe.port ?? expectations.port;
    const marker = probe.marker ?? probe.id;
    const fail = (message) => errors.push(`probe ${probe.id}: ${message}`);
    const matches = requests.filter((request) =>
      (request.port === undefined || request.port === port) &&
      values(request, PROBE_HEADER).includes(marker));
    if (matches.length !== 1) {
      fail(`expected exactly one request at ${upstream}, found ${matches.length}`);
      continue;
    }
    const [request] = matches;
    const path = request.target.split("?")[0];
    if (path !== probe.path) fail(`reached ${upstream} as ${path}, expected ${probe.path}`);

    const { exact, absent, appendedForwardedFor } = rulesFor(probe, upstream, expectations);
    const seen = {};
    const single = (name) => (seen[name]?.length === 1 ? seen[name][0] : undefined);
    for (const name of Object.keys(exact)) {
      const found = values(request, name);
      seen[name] = found;
      if (found.length !== 1) {
        fail(`${name} arrived ${found.length} times (${JSON.stringify(found)})`);
        continue;
      }
      const spoof = containsSpoof(found[0], spoofs);
      if (spoof) fail(`${name} passed the client's value through (${spoof})`);
    }
    for (const [name, rule] of Object.entries(exact)) {
      const actual = single(name);
      if (actual === undefined) continue;
      if (typeof rule === "function") {
        if (!rule(actual)) fail(`${name} ${JSON.stringify(actual)} is not a value nginx sets`);
      } else {
        // A rule naming another header means "equal to that header's value".
        const expected = rule in exact ? single(rule) : rule;
        if (expected !== undefined && actual !== expected) {
          fail(`${name} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
        }
      }
    }
    // A header that must be absent may carry an identity or a secret, so its
    // value is never logged: only the count and the forged marker it holds.
    for (const name of absent) {
      const found = values(request, name);
      seen[name] = found.length === 0 ? [] : [`(${found.length} sent, value not shown)`];
      if (found.length !== 0) {
        const marker = found.map((value) => containsSpoof(value, spoofs)).find(Boolean);
        fail(`${name} must not reach ${upstream} on ${probe.path} (${found.length} sent${
          marker ? `, with the forged "${marker}"` : ""})`);
      }
    }
    if (appendedForwardedFor) {
      const found = values(request, "x-forwarded-for");
      seen["x-forwarded-for"] = found;
      const lastHop = found.length === 1 ? found[0].split(",").at(-1).trim() : undefined;
      if (found.length !== 1) {
        fail(`x-forwarded-for arrived ${found.length} times (${JSON.stringify(found)})`);
      } else if (lastHop !== single("x-real-ip")) {
        fail(`x-forwarded-for ${JSON.stringify(found[0])} does not end with nginx's peer (${single("x-real-ip")})`);
      }
    }

    observed.push({ probe: probe.id, upstream, target: request.target, headers: seen });
    // Name only the forged marker, never the header's value.
    for (const [name, value] of request.headers) {
      if (name in seen) continue;
      const marker = containsSpoof(value, spoofs);
      if (!marker) continue;
      if (upstream === "foundry") fail(`${name} carried the forged "${marker}" to foundry`);
      else passthrough.push({ probe: probe.id, upstream, header: name, marker });
    }
  }
  return { errors, observed, passthrough };
}

async function main(capturePath, expectationsPath) {
  if (!capturePath || !expectationsPath) {
    throw new Error("usage: forwarded-headers.mjs <capture.pcap> <expectations.json>");
  }
  const expectations = JSON.parse(await readFile(expectationsPath, "utf8"));
  const segments = readPcap(await readFile(capturePath));
  const ports = [...new Set(expectations.probes.map((probe) => probe.port ?? expectations.port))];
  const requests = ports.flatMap((port) =>
    clientStreams(segments, port).flatMap(parseRequests).map((request) => ({ ...request, port })));
  console.log(`Captured ${requests.length} request(s) from nginx to port(s) ${ports.join(", ")}.`);
  const { errors, observed, passthrough } = checkProbes(requests, expectations);
  for (const { probe, upstream, target, headers } of observed) {
    console.log(`\n${probe} (${upstream}): ${target}`);
    for (const [name, found] of Object.entries(headers)) {
      console.log(`  ${name}: ${found.length > 0 ? found.join(" | ") : "(not sent)"}`);
    }
  }
  for (const { probe, upstream, header, marker } of passthrough) {
    console.log(`\nnote: ${probe}: ${header} carried the forged "${marker}" to ${upstream}`);
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nnginx set every checked header itself; no spoofed value reached an upstream in them.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main(process.argv[2], process.argv[3]).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
