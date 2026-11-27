# Ferrum Foundry — next release (draft)

> **Draft notes.** The unreleased v0.5.7 candidate is documented in
> [v0.5.7.md](v0.5.7.md) and the `[Unreleased]` changelog bucket. Hosted
> qualification and Foundry publication are pending. The latest published
> pairing remains v0.5.6 / Edge v0.9.20 in its
> [immutable release record](v0.5.6.compatibility.json).
> The release workflow requires matching package/compatibility versions,
> versioned notes and hosted `release-ready` verification.
>
> Name an Edge image only in versioned notes using `edge.release` from the
> current record; moving the pin requires full qualification.

### Changes since v0.5.7

No changes beyond the prepared v0.5.7 candidate are recorded yet. Summarize
future work from `[Unreleased]` here when preparing the next versioned notes.

### Known limitations

Retain the documented support limits in
[Not qualified](../compatibility.md#not-qualified). Three release controls are
owner settings outside the repository, which no Foundry check can verify (see
[release security](../release-security.md)): immutable-tag rules on Docker Hub
for release version tags, required reviewers and environment-scoped Docker Hub
secrets on the `release` environment, and the bypass list of the tag ruleset
that blocks updating or deleting `v*` tags. Published upstream facts,
canonical consumption, hosted Foundry qualification and Foundry publication
remain separate evidence.

### Publication

No subsequent Foundry version or qualification is claimed. See
[compatibility](../compatibility.md).
