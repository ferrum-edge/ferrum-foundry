#!/usr/bin/env node
// ------------------------------------------------------------------
// What nginx actually sends oauth2-proxy, read off the wire
// ------------------------------------------------------------------
//
// The production smoke test (run.sh) captures the plaintext traffic from the
// starter's nginx to oauth2-proxy (port 4180) while it sends probes carrying
// spoofed X-Forwarded-* values. This reads that capture, reassembles each TCP
// stream nginx opened, and checks every probe's request:
//
//   - each forwarded header oauth2-proxy reads with --reverse-proxy
//     (X-Forwarded-For/-Host/-Proto/-Uri, X-Real-IP, and on /oauth2/ also
//     X-Auth-Request-Redirect) arrives exactly once, with nginx's own value;
//   - no spoofed value reaches oauth2-proxy in any of them.
//
// Any other header that still carries a client value is reported, not failed:
// oauth2-proxy does not read it on that route (see the README).
//
//   node e2e/production-smoke/forwarded-headers.mjs <capture.pcap> <expectations.json>

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

/** Read by oauth2-proxy on every route when --reverse-proxy is set. */
export const FORWARDED_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-uri",
];

/** Read by oauth2-proxy's redirect logic, which only /oauth2/ routes run. */
export const REDIRECT_HEADER = "x-auth-request-redirect";

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
 * Checks every probe against what reached oauth2-proxy. Returns the failures,
 * the forwarded headers each probe arrived with, and the client values that
 * reached oauth2-proxy in headers it does not read on that route.
 */
export function checkProbes(requests, expectations) {
  const { host, proto, spoofs, probes } = expectations;
  const errors = [];
  const observed = [];
  const passthrough = [];
  for (const probe of probes) {
    const matches = requests.filter((request) => values(request, PROBE_HEADER).includes(probe.id));
    if (matches.length !== 1) {
      errors.push(
        `probe ${probe.id}: expected exactly one request at oauth2-proxy, found ${matches.length}`,
      );
      continue;
    }
    const [request] = matches;
    const path = request.target.split("?")[0];
    if (path !== probe.path) {
      errors.push(`probe ${probe.id}: reached oauth2-proxy as ${path}, expected ${probe.path}`);
    }
    const checked = probe.path.startsWith("/oauth2/") && probe.path !== "/oauth2/auth"
      ? [...FORWARDED_HEADERS, REDIRECT_HEADER]
      : FORWARDED_HEADERS;
    const seen = {};
    for (const name of checked) {
      const found = values(request, name);
      seen[name] = found;
      if (found.length !== 1) {
        errors.push(`probe ${probe.id}: ${name} arrived ${found.length} times (${JSON.stringify(found)})`);
        continue;
      }
      const spoof = containsSpoof(found[0], spoofs);
      if (spoof) errors.push(`probe ${probe.id}: ${name} passed the client's value through (${spoof})`);
    }
    const single = (name) => (seen[name]?.length === 1 ? seen[name][0] : undefined);
    const expected = {
      "x-forwarded-host": host,
      "x-forwarded-proto": proto,
      "x-forwarded-uri": probe.uri,
      ...(checked.includes(REDIRECT_HEADER) ? { [REDIRECT_HEADER]: probe.uri } : {}),
    };
    for (const [name, value] of Object.entries(expected)) {
      const actual = single(name);
      if (actual !== undefined && actual !== value) {
        errors.push(`probe ${probe.id}: ${name} is ${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`);
      }
    }
    const realIp = single("x-real-ip");
    const forwardedFor = single("x-forwarded-for");
    if (realIp !== undefined && !isIP(realIp)) {
      errors.push(`probe ${probe.id}: x-real-ip ${JSON.stringify(realIp)} is not an address`);
    }
    if (realIp !== undefined && forwardedFor !== undefined && forwardedFor !== realIp) {
      errors.push(
        `probe ${probe.id}: x-forwarded-for ${JSON.stringify(forwardedFor)} is not nginx's view of the peer (${realIp})`,
      );
    }
    observed.push({ probe: probe.id, target: request.target, headers: seen });
    for (const [name, value] of request.headers) {
      if (checked.includes(name)) continue;
      const spoof = containsSpoof(value, spoofs);
      if (spoof) passthrough.push({ probe: probe.id, header: name, value });
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
  const requests = clientStreams(segments, expectations.port).flatMap(parseRequests);
  console.log(`Captured ${requests.length} request(s) from nginx to oauth2-proxy:${expectations.port}.`);
  const { errors, observed, passthrough } = checkProbes(requests, expectations);
  for (const { probe, target, headers } of observed) {
    console.log(`\n${probe}: ${target}`);
    for (const [name, found] of Object.entries(headers)) console.log(`  ${name}: ${found.join(" | ")}`);
  }
  for (const { probe, header, value } of passthrough) {
    console.log(`\nnote: ${probe}: the client's ${header} reached oauth2-proxy (${value}); oauth2-proxy does not read it on this route`);
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nEvery forwarded header oauth2-proxy reads was set by nginx; no spoofed value reached it.");
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
