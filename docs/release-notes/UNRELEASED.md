# Ferrum Foundry — next release (draft)

> **Draft.** The release step renames this file to `docs/release-notes/vX.Y.Z.md`,
> replaces every *release step* marker, removes this note, and leaves a fresh
> copy of this template behind. The release workflow publishes that file as the
> GitHub release body and refuses a tag without it. It also requires
> `package.json` and `foundry.version` in `docs/compatibility.json` to be
> `X.Y.Z`, and `node scripts/supported-pairing.mjs release-ready` to pass.
> Changes since [v0.3.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.3.0):
> `git log v0.3.0..vX.Y.Z`.
>
> Name a Ferrum Edge image here only at the release step, and only
> `edge.release.image`: `scripts/supported-pairing.test.mjs` fails if this
> draft pins one. If the next release pairs with a different Edge release,
> moving the pin is a re-qualification (`docs/compatibility.md`, "Changing the
> pairing").

*Release step:* one paragraph on who this release is for and what it changes.

### Qualification

- The next Foundry pairing is being qualified against the published Ferrum Edge
  v0.9.9 release in [#512](https://github.com/ferrum-edge/ferrum-foundry/pull/512),
  separately from Foundry release preparation.
- Plugin configuration and upstream editors handle the secrets an `operator`
  read masks: each masked field holding a placeholder is marked, Save stays
  blocked until it is re-entered or cleared (clearing deletes the stored
  secret), and Ferrum Edge's refusal lists the fields it names. Admins, whose
  reads are raw, are never blocked, and a placeholder-shaped value in a field
  the read does not mask only gets a warning.

### Supported pairing

| | |
| --- | --- |
| Foundry | vX.Y.Z (*release step*) — `ferrumedge/ferrum-foundry:vX.Y.Z`, `linux/amd64` and `linux/arm64` |
| Ferrum Edge | *release step* — `edge.release` from `docs/compatibility.json`: version, multi-architecture index digest, source commit, and per-platform manifest digests |
| Tested gateway | *release step* — from `tested.gateway` |
| Tested access | *release step* — from `tested.roles` and `tested.auth_mode` |
| Tested browser | *release step* — from `tested.browsers` |
| CI evidence | *release step* — the qualifying pull request and this release's Pre-publication Gates |

Best-effort and not qualified: *release step* — from `best_effort` and
`not_qualified`, linking
`https://github.com/ferrum-edge/ferrum-foundry/blob/vX.Y.Z/docs/compatibility.md`.

### Highlights since v0.3.0

*Release step:* grouped highlights from the `[Unreleased]` section of
`CHANGELOG.md`, which moves under `[X.Y.Z]` in the same change.

### Known limitations

*Release step.*

### Install

*Release step:* both images by digest, and the starter and deployment links at
`vX.Y.Z`.

### Upgrading from v0.3.0

*Release step:* Edge first if the pairing moved, then Foundry; what changed in
configuration; how to confirm `GET /api/health/ready`.

### Rolling back

*Release step:* Foundry by immutable tag or digest; Ferrum Edge by its own
guidance; the backup to take first.
