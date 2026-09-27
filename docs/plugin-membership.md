# Plugin membership and cascade deletion

See [plugin configuration templates](plugin-defaults.md) for defaults, scope
requirements, operator prerequisites, and pinned-gateway admission coverage.
The plans described here live in `src/lib/pluginMembership.ts`.

A `proxy_group` plugin is one configuration shared by the proxies that list it.
Ferrum Edge deletes that configuration when a proxy update removes its last
reference. An empty selection is therefore not a valid membership edit: use
Delete Plugin to remove a group.

## Editing a group

- The editor waits for the complete proxy list (every page) before showing the
  current membership. If that read fails, the page shows a load error instead
  of an editable empty group.
- Initial membership is applied once. Later refreshes, successful or failed, do
  not reset the form or your selections. While the proxy catalog is failing,
  the picker is disabled and a notice shows the last successful read.
- While editing, switching Scope away and back keeps the draft selections. Only
  saving applies the chosen scope.
- A selected proxy that is no longer in the catalog stays visible by ID (for
  example, "no longer on the gateway") until you remove it. Foundry never drops
  missing IDs silently, and saving checks the membership against a fresh,
  complete proxy list.

Group membership is written through `PUT /proxies/{id}`. Foundry attaches every
new member before detaching any old one, so during a move both source and
destination can briefly run the plugin. A membership change spans several
requests and is not atomic.

## Scope changes and proxy-scoped plugins

Changing scope to `global` or `proxy` is a single `PUT /plugins/config/{id}`.
Edge reconciles associations atomically in that request: `global` removes
them, and `proxy` keeps only the selected `proxy_id`. Foundry does not detach
group members first. Entering group scope writes the plugin first, then adds
members.

Creating a proxy-scoped plugin (`POST /plugins/config`) or moving one to proxy
scope makes Edge attach it to the target proxy in the same transaction
(ferrum-edge#4611). That transaction also advances the proxy's `updated_at`;
Foundry does not treat this as a concurrent edit. After every proxy-scoped
write Foundry:

1. reads the target proxy fresh;
2. adds the association only if it is missing, conditional on that read; and
3. if the plugin still is not attached, reports the failure. A new plugin that
   cannot be attached is deleted rather than left in place unused.

When a plugin leaves proxy scope, or moves to a different proxy, Foundry also
detaches it from the proxy it used to target if Edge left it there.

`src/lib/pluginMembership.binding.test.ts` covers both proxy-scoped paths
against a fake gateway that attaches, advances `updated_at`, and enforces
`If-Match`. The **Pinned Gateway Contract** CI job runs
`scripts/gateway-contract-smoke.mjs` against the pinned gateway image.

## Deleting a group

Deleting a group detaches every member, then reads the plugin configuration.
A `404` means the last detach already deleted it, and the delete is shown as
successful. If the configuration still exists (including a group with no
members), Foundry sends an explicit `DELETE`. A failed read (for example, a
`503`) is not treated as confirmation of deletion.

## Failures and recovery

If a change fails, Foundry attempts a compensating rollback:

- It restores original references before removing new ones.
- It keeps a final reference when removing it would delete a configuration that
  still needs recovery.
- A failed move into group scope first restores the original non-group scope,
  relying on Edge's atomic reconciliation.
- It does not reattach a plugin that no longer exists.

Every write is guarded against concurrent changes. Foundry compares
`updated_at` with the read it just made, and sends `If-Match` with that read's
`ETag`. On the paired Ferrum Edge release (ferrum-edge#5661, since v0.9.7) this makes
the check and the write atomic and also catches changes that did not move
`updated_at`. A save or delete from the plugin page is also refused if the
configuration no longer matches what the editor opened; see
[concurrent edits](concurrent-edits.md).

Concurrent writers or ambiguous network failures can still prevent rollback.
Foundry then reports whether the plugin exists, its scope, and which proxies
still reference it. The plugin page keeps these recovery details, plus a
copyable saved configuration, visible after the error toast disappears.

If the configuration is missing, recreate it from that saved configuration,
then restore the intended memberships. Review redacted values before
recreating it. Foundry never recreates a missing plugin automatically, because
that could undo another operator's intended deletion.
