# Threat model

Foundry's security boundaries and supported deployment assumptions are
described in [SECURITY.md](../SECURITY.md),
[authentication.md](authentication.md), and [deployment.md](deployment.md).
This document records the threat relevant to operator helper scripts.

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
