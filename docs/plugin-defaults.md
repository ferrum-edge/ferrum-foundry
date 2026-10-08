# Plugin configuration templates

The plugin picker and JSON editor take their starting configuration from
`src/lib/pluginConfigDefaults.ts`. Templates are starting points: replace the
example endpoints, identities, keys, and policy values with your own. A template
the gateway admits has not proved that a directory, provider, or log destination
is reachable. For deployment requirements, see the Edge
[OpenAPI contract](https://github.com/ferrum-edge/ferrum-edge/blob/main/openapi.yaml)
and [plugin documentation](https://github.com/ferrum-edge/ferrum-edge/blob/main/docs/plugins.md).

## Template notes

| Plugin | What the template sets |
| --- | --- |
| `ldap_auth` | Direct bind: `ldap_url`, `bind_dn_template` (with `{username}`), and `canonical_identity_attribute` (`uid` in the example; set it to your directory's authoritative attribute). The loopback URL needs a local directory; use LDAPS or STARTTLS for a remote one. Search-then-bind uses different, service-account fields. |
| `mcp_gateway` | Aggregate-router mode with `endpoint`, upstream `servers`, and tool `policy`. `discovery.public_base_url` belongs to the A2A gateway schema and is not set. |
| `mesh_authz` | Native Edge `MeshPolicy` documents under `mesh_policies` (`name`, `namespace`, `scope`, `rules`, and a per-rule `action`), not a Kubernetes CRD envelope. The example denies `/admin/*` namespace-wide and allows one SPIFFE service account. The proxy `namespace` and `labels` drive `PolicyScope` filtering. Mesh mode is not required. |
| `soap_ws_security` | Timestamp checking is on. UsernameToken (`username_token.credentials`), X.509 (`x509_signature.trusted_certs`), and SAML are off. Before enabling one, supply credentials or trust material and choose a replay scope. `nonce.max_cache_size` bounds the nonce cache; retention time is set by the gateway. |
| `tcp_connection_throttle` | `max_connections_per_key: 100`, per consumer (falling back to client IP) per gateway process. Attach it to a TCP or TCP+TLS proxy, or to a global policy that covers a TCP listener. |
| `response_caching` | Caches `GET`/`HEAD` responses with status 200, 301, or 404. |
| `compression` | Strong ETags are always preserved; there is no ETag switch. |
| `loki_logging` | `include_proxy_id_label` labels streams by proxy. |
| `transaction_debugger` | `redacted_headers` lists headers to redact (it is not a capture allowlist). Body capture is off. |
| `ai_federation` | One OpenAI provider with `default_model` and `model_patterns`, plus status-code fallback. There is no `preserve_original_model` switch. |
| `ai_prompt_shield` | `patterns`, `redaction_placeholder`, and `exclude_roles` configure detection and redaction. The built-in US phone pattern is `phone_us`; `phone` is invalid. |
| `ai_response_guard` | `pii_patterns` (also `phone_us`) and `redaction_placeholder` configure response redaction. |
| `ai_request_guard` | Model allow/block lists, token caps, message count, prompt length, and temperature range. There is no `required_fields` key. |
| `ws_message_size_limiting`, `ws_rate_limiting` | `close_reason` sets the WebSocket close text. |

## Templates that need operator input

Seven templates are rejected as shipped, because they need something only the
operator or the gateway environment can supply. The contract records each exact
error body and its `400` status.

| Template | What to supply |
| --- | --- |
| `hmac_auth` | A `replay_scope` for `ferrum-hmac-v2` that matches your replica topology. |
| `mtls_auth` | `allowed_issuers[0].ca_certificate_pem`; an issuer name alone cannot pin trust. |
| `ai_stream_router` | Provider API keys in the gateway environment (the template references `${FERRUM_PLUGIN_SECRET_OPENAI_API_KEY}` first). |
| `load_testing` | A trigger `key` of at least 32 characters. |
| `proxy_alerts` | `FERRUM_PLUGIN_SECRET_ALERTS_SLACK_WEBHOOK` in the gateway environment. |
| `kafka_logging` | An unrestricted backend egress policy. Under the default restrictive policy the gateway refuses librdkafka during field validation (the error starts with `Invalid plugin config fields: kafka_logging:`), before contacting a broker. Use another log sink if egress must stay restricted. |
| `openapi_validator` | Proxy scope, on a proxy with an attached API spec. |

## Contract gate

The **Pinned Gateway Contract** CI job runs `scripts/gateway-contract-smoke.mjs`,
which calls `verifyPluginDefaults` in `scripts/plugin-defaults-contract.mjs`
against the Ferrum Edge image pinned as `edge.image` in
[the compatibility record](compatibility.md). It imports the real TypeScript
templates and:

1. checks that Foundry's 81 non-internal templates match the gateway's
   `GET /plugins` catalog;
2. in a separate disposable namespace, submits each unmodified template with
   `enabled: true`, one at a time, and deletes it before the next. TCP
   throttling gets a TCP proxy fixture and OpenAPI validation an HTTP proxy
   fixture; every other template is global;
3. expects 74 `201` admissions (each read back as enabled) and the seven exact
   rejections above.

It runs before the demo seeds, because the seeded `prometheus_metrics` plugin
owns a process-wide registry that a separate namespace cannot isolate.

The gate fails on an unexpected success, a changed error body or status, a
missing or extra catalog member, or a failed cleanup. Admission failures are
collected across the catalog; a cleanup failure stops further submissions,
because isolation is no longer assured. `scripts/plugin-defaults-contract.test.mjs`
covers these failure paths.

Passing establishes compatibility with the pinned image only. Treat any
divergence as a compatibility change to review: do not widen the rejection
table or move the image pin to make a failure go away.

## Shared plugin catalog contract

Foundry pins the plugin catalog and the `provisioned-by` vocabulary from
[ferrum-edge/ferrum-contracts](https://github.com/ferrum-edge/ferrum-contracts),
the org's central contract store, in
[`contracts/ferrum-contracts/PIN`](../contracts/ferrum-contracts/PIN).
The pinned files and the local plugin names and provisioning markers are checked
by `scripts/ferrum-contracts.test.mjs` in the normal contract test suite.
The canonical pin is now published `contracts-edge-0.9.15` at
`6fb64c5dc2e014204c17609fc717d976f3b4589e`, mapped to Edge v0.9.15. The plugin
catalog and provisioning vocabulary refresh provenance to released Edge source
`25b37395ff61bfea0f3ffd189d9011c4984fa755`, and the catalog notes the v0.9.15
config-schema changes; plugin entries, lifecycle metadata, provisioning values
and historical first availability are unchanged. The
vocabulary schemas retain their exact earlier bytes. The pin also includes the
implemented service-manifest schema, every shared manifest fixture and the
canonical invalid-expectations file for the
[Alloy preview consumer](alloy-manifest-preview.md). Every adopted file is
byte-identical to the immutable canonical commit, including descriptions with
historical preparation wording. The complete canonical invalid-expectations
file versions its deployment-snapshot and backend-egress-policy negatives and
adds their v2 entries, including the v0.9.14 data-plane attestation negatives;
v0.9.15 adds diagnostic-ref and gateway-headers negatives. Foundry's same
18-file scope includes no deployment, egress-policy, diagnostic or header
schemas or profile implementation. Manifest schema, fixtures and
owner-unreleased status remain unchanged. Foundry v0.5.5 hosted pairing
qualification is pending in [the compatibility record](compatibility.md);
v0.5.4 and earlier evidence belongs to their unchanged immutable release records.

Edge v0.9.15 confines every plugin-config environment reference to
`FERRUM_PLUGIN_SECRET_<NAME>` (`<NAME>` uppercase `[A-Z_][A-Z0-9_]*`) and
refuses any other name with `400` (ferrum-edge#6089). The `ai_semantic_firewall`,
`ai_stream_router`, `api_chargeback_sink` and `proxy_alerts` templates name
variables in that namespace; set them in the gateway environment, directly or
through a `_FILE` / `_VAULT` / `_AWS` / `_AZURE` / `_GCP` source. The
`serverless_function` Azure and GCP credential fallbacks now read
`FERRUM_PLUGIN_SECRET_AZURE_FUNCTIONS_KEY` and
`FERRUM_PLUGIN_SECRET_GCP_CLOUD_FUNCTIONS_BEARER_TOKEN`. The `ldap_auth`
template never set `consumer_mapping`, which v0.9.15 removes and refuses.

To bump the pin, choose a `contracts-edge-*` release, download the adopted
vocabulary and schema files from that tag into the same paths, resolve the tag
to its commit SHA, and update `PIN` with the new commit and each file's SHA-256.
Then update this document if the adopted file set changes and run CI; the
contract test fails if a vendored file or local copy drifts.
