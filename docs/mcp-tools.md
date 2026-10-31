# MCP Tools tab

Ferrum Edge v0.9.9 was the first release with everything the proxy page's MCP
Tools tab (#505) needs; none of it is in v0.9.8:

- **The catalog read**, `GET /proxies/{id}/mcp/tools` (ferrum-edge#5949):
  each tool's public name, source, title, description, annotations, policy
  (`action`, `configured`, `effective`, `listed`, `callable`), grants,
  `schema_hash`, and `discovered_at`, plus each instance's `catalog_state`,
  servers, `tools_refresh` outcome, and fixed-text `refresh_error`. Every role
  from `viewer` up gets the same projection; a server's `upstream_url` is
  always reduced to `scheme://host[:port]`, plus `/[REDACTED_PATH]` when the
  URL has a non-empty, non-root path.
- **Generated OpenAPI tools** (`servers.*.openapi`, ferrum-edge#5906): the
  catalog reports them as `source.type: openapi` with the operation's name,
  method, and path. Their `listed` and `callable` flags also account for the
  proxy's `allowed_methods`.
- **Per-group grants** (`policy.tools.*.allowed_groups` / `denied_groups`,
  ferrum-edge#5919), matched against the calling Consumer's `acl_groups`.
  Foundry checks the rules Edge applies at plugin load before it sends a
  save: groups only on `allow`, no empty list, no group in both lists, at most
  255 bytes per group and 512 distinct groups across the map, and a
  group-conditioned name must start with a configured server's namespace and
  the namespace separator.

**The catalog is node-local.** It is what the node behind Foundry's admin API
has cached. Edge never contacts an upstream or starts a refresh for this read,
and an upstream that tailors tools per principal shows one session's view. A
control plane runs no data plane, so it answers every instance
`catalog_state: not_served` with no tools, as does a data plane that does not
serve the proxy's namespace or has not loaded the change yet. Foundry
connects to one admin API (`FERRUM_ADMIN_URL`) and cannot route a read to a
particular data plane, so it does not pretend: on a `cp` gateway the tab says
the catalog lives on each data plane's own admin API and that a Foundry
deployment connected to a data plane serving the namespace shows it. The
stored policy is still listed, from the plugin configuration, and stays
editable on the control plane, which is where configuration is written. A
saved policy is "configured" at once and reaches the catalog only when the
node reloads; until then the row says it is not yet live on this node.

**Writing a policy** is a plugin configuration write, not a catalog write: it
needs `operator` or above on a writable gateway, replaces one
`config.policy.tools` entry through the conditional-write path, omits
`labels` (so `provisioned-by` survives), and is refused before sending when
the session's read masks a value. In practice an `operator` read masks the
path of every MCP server URL that has one. Every inline save re-reads the
configuration and refuses again, and re-entered URLs are masked again on the
next `operator` read. For such configurations an `admin` must make the inline
edit, or the `operator` must change `policy.tools` on the plugin page in the
same save that re-enters the masked values.

The capability parity contract probes the catalog read as each role (see
[capabilities.md](capabilities.md)); `scripts/mock-admin-gateway.mjs` serves it
with the same shape and node-local states, and
`scripts/mock-admin-gateway.mcp.test.mjs` runs a policy edit end to end
against it.
