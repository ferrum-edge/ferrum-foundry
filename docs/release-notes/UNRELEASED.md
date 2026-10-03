# Ferrum Foundry — next release (draft)

> **Draft.** At release preparation, move this file to
> `docs/release-notes/vX.Y.Z.md`, fill the release-step markers, and leave a
> fresh copy of this template here. The release workflow publishes the
> versioned file and refuses a tag without it. It also requires `package.json`
> and `foundry.version` in `docs/compatibility.json` to match the tag, and
> `node scripts/supported-pairing.mjs release-ready` to pass.
> Changes since [v0.4.0](https://github.com/ferrum-edge/ferrum-foundry/releases/tag/v0.4.0):
> `git log v0.4.0..vX.Y.Z`.
>
> Name a Ferrum Edge image only at the release step, using `edge.release.image`.
> If the release pairs with a different Edge release, moving the pin is a
> re-qualification; see `docs/compatibility.md` → "Changing the pairing".

*Release step:* one paragraph on who this release is for and what it changes.

### Supported pairing

| | |
| --- | --- |
| Foundry | vX.Y.Z (*release step*) — `ferrumedge/ferrum-foundry:vX.Y.Z`, `linux/amd64` and `linux/arm64` |
| Ferrum Edge | *release step* — `edge.release` from `docs/compatibility.json` |
| Tested gateway | *release step* — from `tested.gateway` |
| Tested access | *release step* — from `tested.roles` and `tested.auth_mode` |
| Tested browser | *release step* — from `tested.browsers` |
| CI evidence | *release step* — the qualification pull request and this release's Pre-publication Gates |

### Highlights since v0.4.0

*Release step:* summarize the changes from the `[Unreleased]` section of
`CHANGELOG.md`.

- Admin API resource identifiers are encoded as single path segments and
  empty or dot-segment identifiers are rejected. This fixes GHSA-64c9-hw76-jqmh.

### Known limitations

*Release step.*

### Install

*Release step:* both images by digest, plus the starter and deployment links at
`vX.Y.Z`.

### Upgrading from v0.4.0

*Release step:* Edge first if the pairing moved, then Foundry; describe any
configuration changes and how to confirm `GET /api/health/ready`.

### Rolling back

*Release step:* Foundry by immutable tag or digest, Ferrum Edge by its own
guidance, and the backup to take first.
