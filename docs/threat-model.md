# Threat model

Foundry's security boundaries and supported deployment assumptions are
described in [SECURITY.md](../SECURITY.md),
[authentication.md](authentication.md), and [deployment.md](deployment.md).
This document records the threats relevant to admin API transport, operator
helper scripts, and the browser-facing surface of the BFF.

## Admin API token transport

The BFF and the real-gateway helpers sign an admin JWT for every admin API
request. Over plaintext to another host, an on-path observer could replay the
token or alter the request and the gateway's answer. With
`NODE_ENV=production`, the BFF refuses to start (and refuses a runtime
`adminUrl` change) unless the admin origin uses HTTPS or HTTP to exact
`localhost`, an IPv4 address in `127.0.0.0/8`, or IPv6 `::1`.
`FERRUM_ALLOW_INSECURE_ADMIN_HTTP=true` is an explicit exception for a
disposable stack on an isolated network, such as the starter's demo profile.
Production also requires `FERRUM_TLS_VERIFY=true` for a remote HTTPS admin
origin, at startup and after runtime settings changes. A private gateway CA can
be trusted with `FERRUM_TLS_CA_PATH`; disabling verification is allowed only
with the explicit insecure transport override.

Ferrum Edge uses `FERRUM_ALLOW_INSECURE_ADMIN_HTTP` for its own plaintext admin
listener. Sharing an env file or ConfigMap with Edge therefore also disables
Foundry's production transport checks. Keep the deployments' settings separate
except for disposable, isolated demo stacks.

The seeder and the helpers that share its configuration apply the same rule
with no exception, before they sign anything. The starter preflight may send
its anonymous `/health` request to any configured admin URL, but it mints and
sends its credentialed probe only to an HTTPS or loopback origin.

## Starter helper network probes

The starter preflight and walkthrough can send `FERRUM_TRUSTED_PROXY_SECRET`
to prove that the identity proxy replaces client-supplied identity headers.
That proof is sent only over HTTPS or over HTTP to exact `localhost`, an IPv4
address in `127.0.0.0/8`, or IPv6 `::1`. Hostnames are not considered loopback
based on their spelling, and other schemes are refused. Redirects remain
manual, so a probe does not follow a response to another destination.

The walkthrough validates this boundary and its destructive-target
acknowledgement before its first network request. The preflight can perform
its anonymous, proof-free diagnostic request first, but it does not send the
proof header when the configured HTTP target is not an allowed loopback
literal. Operators should use HTTPS for remote targets.

## Browser-facing headers and public endpoints

- **Content-Security-Policy.** `script-src 'self'` with `script-src-attr 'none'`,
  `object-src 'none'` and `frame-ancestors 'none'`. `style-src` still allows
  `'unsafe-inline'` because of a framework constraint: Radix's scroll lock
  (Dialog, Select, DropdownMenu) injects a `<style>` element with computed
  widths at runtime, and Select's viewport renders another. No hash can cover
  them. Removing it needs per-response nonces in the SPA shell and in those
  libraries. That work is tracked in
  [#594](https://github.com/ferrum-edge/ferrum-foundry/issues/594) and is due
  before Foundry leaves buildout. Until then, an HTML-injection sink could use
  inline styles for UI redress or CSS-based exfiltration, but not to run script.
- **HSTS** is on by default wherever Secure cookies are (both default to
  `NODE_ENV=production`). `FERRUM_ENABLE_HSTS=false` opts out.
- **CORS** is disabled in every environment. The development UI reaches the
  BFF through Vite's same-origin `/api/` proxy, so no other site a developer
  visits can read a locally running BFF.
- **Health endpoints** are unauthenticated so probes work. An anonymous caller
  gets only the verdict (`status`, `ready`) and the status code. The Foundry
  version, the gateway's `degraded` verdict and the Admin API status code need
  an authenticated session.
