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
requests and is not atomic. Its last detach can still make Edge delete the configuration if
another operator removes the members it just attached and edits the plugin in
between: each proxy write is conditional on that proxy only, and Edge offers no
way to condition the cascade on the plugin's revision.

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
   cannot be verified as attached is kept and reported, with the proxies that
   reference it; see below for why it is not deleted.

When a plugin leaves proxy scope, or moves to a different proxy, Foundry also
detaches it from the proxy it used to target if Edge left it there.

`src/lib/pluginMembership.binding.test.ts` covers both proxy-scoped paths
against a fake gateway that attaches, advances `updated_at`, and enforces
`If-Match`. The **Pinned Gateway Contract** CI job runs
`scripts/gateway-contract-smoke.mjs` against the pinned gateway image.

## Masked plugin secrets

An `operator` (or `viewer`) read of a plugin configuration does not return its
secrets. Ferrum Edge replaces each one with a placeholder:

- a secret value (a header value, a password, an integrity key) becomes
  `[REDACTED]`;
- an endpoint URL keeps only `scheme://host[:port]`, with `redacted@` for any
  userinfo and `/[REDACTED_PATH]`, `?[REDACTED_QUERY]`, and
  `#[REDACTED_FRAGMENT]` for a path, query, or fragment that was present
  (`https://collector.example.com/[REDACTED_PATH]?[REDACTED_QUERY]`);
- a Redis URL keeps its scheme, host, port, and database, with the same
  `redacted@`, `?[REDACTED_QUERY]`, and `#[REDACTED_FRAGMENT]` markers.

Upstreams work the same way for one field: an `operator` read shows the Consul
ACL token (`service_discovery.consul.token`) as `[REDACTED]`. `admin` reads of
both resources are raw.

Since v0.9.9, Edge refuses with `400` a `POST` or `PUT` of a plugin
configuration or upstream that sends one of those placeholders back at a field
the caller's read masks (ferrum-edge#5925), and the error names each field by
JSON pointer. The check runs before Edge's update merge, so a placeholder never
stands in for the stored value. `PUT` stays a full replace: omitting the field
clears the stored secret rather than keeping it.

Edge applies the check only where it would apply: never to an `admin`, and
for other roles only at a field the caller's read masks. A placeholder-shaped
value anywhere else (`ai_prompt_shield`'s `redaction_placeholder: "[REDACTED]"`,
say) is saved as written.

Foundry recognises the placeholders exactly as Edge does
(`src/api/maskedSecrets.ts`), finds the masked fields by replaying Edge's
projection (`src/api/maskedSecretSites.ts`: the CI-checked schema rules in
`pluginSensitivity.ts`, Edge's name floor, and its URL-userinfo sweep), and
handles them as follows:

- **Plugin and upstream editors.** For a non-admin session, each masked field
  that still holds a placeholder is marked "Hidden from your role: re-enter it,
  or clear it (clearing deletes the stored secret)". Save stays blocked until
  every one is re-entered with the real value or cleared with its **Clear**
  action, which omits the field. A placeholder-shaped value anywhere else, and
  every one in an admin's editor, is listed as a warning and saved as written.
  A plugin Foundry has no rules for (a custom plugin, or a built-in newer than
  Foundry's copy of the rules) has every placeholder in its `config` treated
  as masked. An unknown session role is treated as a non-admin one.
- **Refused saves.** If Edge refuses a save anyway, the page lists the JSON
  pointers from Edge's error as written, never a value.
- **Upstream targets.** A targets save resends every upstream setting from a
  fresh read. When that read masks the Consul token (a non-admin session),
  Foundry refuses the save before sending it; re-enter or clear the token on the Configuration tab
  first, or have an admin make the change.
- **Rollback.** A failed membership change restores the plugin configuration it
  read first. When that read has a placeholder at a field masked for the
  session's role, the restore is not attempted: the
  recovery report names the fields that could not be restored, and the previous
  configuration must be restored manually, with the real values, or by an
  admin.

## Deleting a plugin

Deleting a plugin configuration, a group included, is a single
`DELETE /plugins/config/{id}`, conditional on the read the plugin page's
baseline was compared with. Edge removes the configuration from every proxy
that lists it in the same transaction. Foundry does not detach members first:
the last detach would make Edge delete the configuration before Foundry could
check it again, so a concurrent configuration change could be deleted unseen
(#609). A `412` re-reads the configuration: if it no longer matches what the
page showed, the comparison is shown; otherwise the delete is refused as
changed during deletion. A `404` means it is already gone, and a
committed-but-not-live `503` is reported as a completed delete that is not yet
proven live. A read without a usable strong `ETag` (an older gateway, or Edge's
cached fallback) refuses the delete before anything is sent, since the
`DELETE` could not be conditional.

## Failures and recovery

If a change fails, Foundry attempts a compensating rollback:

- It restores original references.
- It never removes a reference the failed change added, whatever scope the
  plugin is read with. If that is the
  last reference, Edge deletes the configuration, and no check can rule that
  out: another operator can detach the other members and edit the plugin just
  before the write (#618). Such a reference is kept and named in the recovery
  details; detach it once the group's membership is confirmed.
- A failed move into group scope first restores the original non-group scope,
  relying on Edge's atomic reconciliation.
- A move out of group scope is not rolled back once its plugin `PUT` has
  committed (#610). That `PUT` detached the group's members in the same
  transaction; restoring them, or removing the new proxy-scope target, could
  undo or cascade-delete another operator's concurrent change. If a later step
  fails (such as the read that verifies the new attachment), the editor
  reports "saved, but its attachment could not be verified": the members
  before the save, those the scope change detached, the proxy to check, and
  what the gateway holds now, with a recovery snapshot of the configuration.
  The form and its baseline are left as they are, so saving again would meet
  your own committed change as a conflict; **Reload saved configuration**
  reseeds both from fresh reads (the plugin and, for a group, its membership)
  and changes nothing if a read fails. The saved proxy- or global-scoped
  configuration cannot simply be reattached to the old members: to give them
  the policy again, change the plugin back to `proxy_group` and select the
  members you want, or create a separate group configuration for them.
- A new plugin whose create did not converge, proxy-scoped or group, is kept
  where it got to and reported with its existence and the proxies that
  reference it, never cleaned up automatically (#608). Detaching members can
  cascade-delete a concurrent edit, and a `DELETE` conditional on the plugin
  cannot see an association another operator made or remade on a proxy, which
  changes neither the plugin's revision nor its `ETag`. Remove it, or finish
  attaching it, from the plugin page.
- It does not reattach a plugin that no longer exists.

Every write is guarded against concurrent changes. Foundry compares
`updated_at` with the read it just made, and sends `If-Match` with that read's
`ETag`. On the Ferrum Edge v0.9.9 release, ferrum-edge#5661
(since v0.9.7) makes the check and write atomic and catches changes that did not move
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
