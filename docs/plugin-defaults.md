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
| `ai_stream_router` | Provider API keys in the gateway environment (the template references `${OPENAI_API_KEY}` first). |
| `load_testing` | A trigger `key` of at least 32 characters. |
| `proxy_alerts` | `FERRUM_ALERTS_SLACK_WEBHOOK` in the gateway environment. |
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
