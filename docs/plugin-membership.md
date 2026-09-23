# Plugin membership and cascade deletion

See [plugin configuration templates](plugin-defaults.md) for defaults, scope
requirements, operator prerequisites, and exhaustive pinned-gateway admission coverage.

A `proxy_group` plugin is one configuration shared by its associated proxies.
Ferrum Edge deletes that configuration when a proxy update removes its final
reference. An empty selection is therefore not a membership edit: use Delete
Plugin to remove a group.

The group editor waits for the complete proxy list, including every page, before
showing the current membership. A failed list request shows a load error instead
of an editable empty group. Initial membership is applied once when it becomes
available; later successful refreshes do not overwrite selections you have edited.
Failed background refreshes also preserve the mounted editor and all its drafts.
The proxy picker is disabled until its catalog recovers; a retry notice identifies
the last successful read. Retained complete membership still counts as initialized,
so an error or its recovery cannot remount the form and reset selections.
While editing, switching Scope away and back preserves the draft selections;
only saving applies the chosen scope. A selected ID omitted from the current
catalog remains visible with its ID and can be removed explicitly. Foundry never
silently drops missing IDs, and saving still validates the desired membership
against a complete fresh proxy list.

Foundry attaches all selected destinations before detaching any previous members.
During a move, both source and destination can briefly use the configuration.
Membership changes span multiple requests and are not atomic.

Scope changes to `global` or `proxy` use `PUT /plugins/config/{id}` directly.
Edge atomically reconciles associations in that operation: global scope removes
the associations, and proxy scope keeps only the selected `proxy_id`. Foundry
must not detach the group first. Entering group scope establishes the group
configuration before adding members.

Creating a proxy-scoped plugin is the same on Ferrum Edge 0.9.x
(ferrum-edge#4611): `POST /plugins/config` appends the association to the
target proxy in the same transaction, so the plugin runs as soon as the `201`
arrives. Every such create or `PUT` also advances the `updated_at` of each
proxy whose associations it changed. That is the gateway's own write, not a
concurrent edit, and the plan never mistakes it for one: after a proxy-scoped
write Foundry reads the target proxy fresh, writes the association only if it
is missing (a gateway that does not attach), conditions that write on the read
it just made, and never compares a proxy with a snapshot taken before the
plugin write. Group membership is unaffected: Edge does not touch associations
when a write leaves the plugin in group scope, so the preflight snapshots the
group plan compares stay valid. `src/lib/pluginMembership.binding.test.ts`
drives both proxy-scoped paths against a fake gateway that attaches, bumps, and
enforces `If-Match`.

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
Timestamp checks avoid overwriting resources observed to have changed meanwhile.
Every write is also sent with `If-Match` set to the tag of the read it was
checked against, so on a gateway that implements the precondition
(ferrum-edge#5661) the check and the write are atomic and a change that did not
move `updated_at` is caught too; without a tag they remain client checks. A
plugin save or delete from its detail page is also refused if the configuration
no longer matches what the editor opened — see `docs/concurrent-edits.md`.

Concurrent writers or ambiguous network failures can still prevent compensation.
Foundry checks that the plugin exists before trying to reattach it, and reports
the observed plugin scope/existence and remaining proxy references. The plugin
page keeps recovery details and a copyable saved configuration visible after the
error toast disappears. If the configuration is missing, recreate it from that
saved configuration, then restore the intended memberships. Review redacted
values before recreation. Foundry does not automatically recreate a missing
plugin, which could overwrite another operator's intended deletion.
