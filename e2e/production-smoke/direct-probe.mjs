#!/usr/bin/env node
// ------------------------------------------------------------------
// A request straight to oauth2-proxy, bypassing nginx
// ------------------------------------------------------------------
//
// run.sh runs this inside a throwaway container (the Foundry image, for its
// Node), once on the starter's own network and once on a network outside the
// range oauth2-proxy trusts (--trusted-proxy-ip). It asks oauth2-proxy to
// start a login while forging the headers that, from a trusted proxy, choose
// where the user lands after login (X-Forwarded-Uri) and the host and client
// address oauth2-proxy logs (X-Forwarded-Host, X-Real-IP).
//
// oauth2-proxy carries the post-login redirect in the authorize redirect's
// `state` parameter (`<nonce>:<query-escaped redirect>`), so the redirect it
// chose is visible without completing a login. A trusted peer's forged
// X-Forwarded-Uri becomes that redirect; an untrusted peer's is ignored, and
// a login started at /oauth2/start redirects to "/".
//
// Prints one JSON line: {"status": <code>, "redirect": <string or null>}.
// No cookie or other response value is printed.
//
//   node direct-probe.mjs <address> <port> <host> <forwarded-host> <forwarded-uri> <real-ip>

import { request } from "node:http";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The post-login redirect oauth2-proxy put in an authorize URL's state. */
export function appRedirectFromLocation(location) {
  let state;
  try {
    state = new URL(location).searchParams.get("state");
  } catch {
    return null;
  }
  const separator = state?.indexOf(":") ?? -1;
  if (separator === -1) return null;
  try {
    // Go's url.QueryEscape writes a space as "+".
    return decodeURIComponent(state.slice(separator + 1).replaceAll("+", " "));
  } catch {
    return null;
  }
}

function probe([address, port, host, forwardedHost, forwardedUri, realIp]) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: address,
        port: Number(port),
        path: "/oauth2/start",
        method: "GET",
        headers: {
          host,
          "x-forwarded-host": forwardedHost,
          "x-forwarded-uri": forwardedUri,
          "x-real-ip": realIp,
        },
        timeout: 10_000,
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          const location = response.headers.location;
          resolve({
            status: response.statusCode,
            redirect: typeof location === "string" ? appRedirectFromLocation(location) : null,
          });
        });
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("oauth2-proxy did not answer in 10s")));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const args = process.argv.slice(2, 8);
  if (args.length !== 6 || args.some((arg) => !arg)) {
    console.error("usage: direct-probe.mjs <address> <port> <host> <forwarded-host> <forwarded-uri> <real-ip>");
    process.exit(2);
  }
  probe(args).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(`direct probe failed: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
