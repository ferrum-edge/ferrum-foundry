# Security policy

## Supported versions

| Version | Supported |
|---|---|
| Latest minor release line | Yes, security fixes |
| `main` | Yes, fixes land here first |
| Any older minor release line | No |

Security fixes are published on the newest minor release line. Upgrade to the
latest patch of that line to receive them. Older lines do not receive backports.

## Reporting a vulnerability

Report privately through GitHub private vulnerability reporting:

<https://github.com/ferrum-edge/ferrum-foundry/security/advisories/new>

Do not open a public issue, discussion, or pull request for a suspected
vulnerability, and do not disclose it publicly before a fix is available.

Please include:

- the affected version, image tag, or commit;
- the deployment mode (`static` or `trusted-proxy`) and the reverse proxy in
  front of the BFF, if relevant;
- reproduction steps or a proof of concept;
- the impact you believe the issue has.

We aim to acknowledge a report within **5 business days**. After that you will
receive updates as triage, fix, and release progress. We will credit reporters
in the advisory unless you ask us not to.

## Scope

In scope:

- the Fastify BFF in `server/`, including authentication, session and CSRF
  handling, the admin JWT signer, the gateway proxy, and TLS trust handling;
- the React single-page application in `src/`, including anything that could
  leak credentials or gateway material to a browser;
- the published container image and its build in `docker/`;
- the CI and release workflows in `.github/`, including supply-chain integrity
  of published images and attestations;
- the helper scripts in `scripts/` when they can affect a real gateway.

Out of scope:

- the Ferrum Edge gateway itself, which has its own security policy at
  <https://github.com/ferrum-edge/ferrum-edge>;
- findings that depend on `FERRUM_AUTH_MODE=static` outside local development,
  or on `FERRUM_ALLOW_INSECURE_STATIC_AUTH=true`, both of which are documented
  as unsafe;
- findings that depend on exposing the BFF port directly to untrusted clients
  rather than placing it behind an identity-aware proxy;
- findings that depend on `FERRUM_TLS_VERIFY=false`;
- vulnerabilities in third-party dependencies with no exploitable path in
  Foundry, though we still want to hear about them;
- denial of service through the demo scripts, mock gateway, or dev server.

## Security architecture

- [Production authentication](docs/authentication.md) covers the trusted-proxy
  identity contract, the development static-token flow, and the downstream JWT
  claims.
- [Release and supply-chain gates](docs/release-security.md) covers the gates
  that must pass before an image or GitHub release is published, image tag
  immutability, and provenance and SBOM attestations.
- [Deployment guide](docs/deployment.md) covers the required topology, the full
  configuration reference, and the production hardening checklist.
