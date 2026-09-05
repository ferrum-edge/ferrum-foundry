# Plugin membership and cascade deletion

A `proxy_group` plugin is one configuration shared by its associated proxies.
Ferrum Edge deletes that configuration when a proxy update removes its final
reference. An empty selection is therefore not a membership edit: use Delete
Plugin to remove a group.

The group editor waits for the complete proxy list, including every page, before
showing the current membership. A failed list request shows a load error instead
of an editable empty group. Initial membership is applied once when it becomes
available; later successful refreshes do not overwrite selections you have edited.

Foundry attaches all selected destinations before detaching any previous members.
During a move, both source and destination can briefly use the configuration.
Membership changes span multiple requests and are not atomic.

Scope changes to `global` or `proxy` use `PUT /plugins/config/{id}` directly.
Edge atomically reconciles associations in that operation: global scope removes
the associations, and proxy scope keeps only the selected `proxy_id`. Foundry
must not detach the group first. Entering group scope establishes the group
configuration before adding members.

The CI job **Pinned Gateway Contract** in `.github/workflows/ci.yml` pins the
gateway image by digest and exercises `scripts/gateway-contract-smoke.mjs`;
there is no local OpenAPI fixture. The [upstream OpenAPI contract](https://github.com/ferrum-edge/ferrum-edge/blob/main/openapi.yaml)
and the [0.9.2 reproduction revision](https://github.com/ferrum-edge/ferrum-edge/blob/e8848386b9f4d49247e2ab0f6cce19c291d19d1f/openapi.yaml)
describe the plugin PUT scope reconciliation above. Arbitrary group membership
is managed through `PUT /proxies/{id}`. `/batch` creates resources; it has no
update/delete operation. Namespace-wide `/restore` is not a membership editor.

Deleting a group detaches its members and then reads the plugin configuration.
A verified `404` means the final detach already deleted it and is shown as
success. Foundry sends an explicit DELETE only if the configuration still
exists, including groups that had no references. A failed verification read
(for example, a `503`) is not confirmation of deletion.

If an edit fails, compensation restores original references before removing new
ones. It retains a final reference when removing it would destroy a configuration
that still needs recovery. Compensation for entering group scope restores the
original non-group scope first, using Edge's atomic association reconciliation.
Timestamp checks avoid overwriting resources observed to have changed meanwhile;
these are client checks, not server-side compare-and-swap guarantees.

Concurrent writers or ambiguous network failures can still prevent compensation.
Foundry checks that the plugin exists before trying to reattach it, and reports
the observed plugin scope/existence and remaining proxy references. The plugin
page keeps recovery details and a copyable saved configuration visible after the
error toast disappears. If the configuration is missing, recreate it from that
saved configuration, then restore the intended memberships. Review redacted
values before recreation. Foundry does not automatically recreate a missing
plugin, which could overwrite another operator's intended deletion.
