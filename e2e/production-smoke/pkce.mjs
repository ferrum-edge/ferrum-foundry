#!/usr/bin/env node
// ------------------------------------------------------------------
// PKCE on the wire: the token request oauth2-proxy sends the provider
// ------------------------------------------------------------------
//
// The starter ships OAUTH2_PROXY_CODE_CHALLENGE_METHOD=S256. run.sh checks
// that the authorize redirect carries an S256 code_challenge, captures the
// plaintext traffic to the mock provider while one login completes, and hands
// the capture here with that login's challenge. This finds the one token
// request (POST to the provider's token endpoint) and checks that it redeemed
// the code with a code_verifier whose S256 digest is that challenge
// (RFC 7636 section 4.6), so the verifier came from the same login.
//
// The request body also holds the authorization code, and may hold the client
// secret, so no body value is ever printed: only what was checked.
//
//   node e2e/production-smoke/pkce.mjs <capture.pcap> <port> <token-path> <code-challenge>

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { clientStreams, parseRequests, readPcap } from "./forwarded-headers.mjs";

/** RFC 7636 section 4.1: 43 to 128 unreserved characters. */
export const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** An S256 challenge is the base64url SHA-256 digest, unpadded: 43 characters. */
export const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The S256 code_challenge for a code_verifier (RFC 7636 section 4.2). */
export function s256Challenge(verifier) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Checks the token requests among `requests` against the challenge the
 * authorize redirect carried. Returns the failures; empty means the one token
 * request redeemed the code with the matching verifier.
 */
export function checkTokenExchange(requests, { tokenPath, challenge }) {
  if (!S256_CHALLENGE_PATTERN.test(challenge ?? "")) {
    return ["the authorize redirect's code_challenge is not an S256 challenge"];
  }
  const tokenRequests = requests.filter(
    (request) => request.method === "POST" && request.target.split("?")[0] === tokenPath,
  );
  if (tokenRequests.length !== 1) {
    return [`expected exactly one token request to ${tokenPath}, found ${tokenRequests.length}`];
  }
  const [request] = tokenRequests;
  const params = new URLSearchParams((request.body ?? Buffer.alloc(0)).toString("latin1"));
  const errors = [];
  const grantTypes = params.getAll("grant_type");
  if (grantTypes.length !== 1 || grantTypes[0] !== "authorization_code") {
    errors.push(`the token request is not one authorization_code grant (${JSON.stringify(grantTypes)})`);
  }
  if (params.getAll("code").length !== 1) {
    errors.push("the token request does not carry exactly one code");
  }
  const verifiers = params.getAll("code_verifier");
  if (verifiers.length !== 1) {
    errors.push(`the token request carries ${verifiers.length} code_verifier parameters, expected one`);
    return errors;
  }
  const [verifier] = verifiers;
  if (!CODE_VERIFIER_PATTERN.test(verifier)) {
    errors.push(`the code_verifier is not 43-128 unreserved characters (length ${verifier.length})`);
  } else if (s256Challenge(verifier) !== challenge) {
    errors.push("the code_verifier's S256 digest is not the authorize redirect's code_challenge");
  }
  return errors;
}

async function main(capturePath, portText, tokenPath, challenge) {
  const port = Number(portText);
  if (!capturePath || !Number.isInteger(port) || !tokenPath || !challenge) {
    throw new Error("usage: pkce.mjs <capture.pcap> <port> <token-path> <code-challenge>");
  }
  const segments = readPcap(await readFile(capturePath));
  const requests = clientStreams(segments, port).flatMap(parseRequests);
  console.log(`Captured ${requests.length} request(s) to port ${port}.`);
  const errors = checkTokenExchange(requests, { tokenPath, challenge });
  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `ok: the token request to ${tokenPath} redeemed the code with a code_verifier ` +
      "whose S256 digest is the authorize redirect's code_challenge",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main(...process.argv.slice(2, 6)).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
