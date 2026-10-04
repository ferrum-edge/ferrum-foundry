import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  EDGE_REFERENCE,
  PLACEHOLDER_PREFIX,
  REPO_ROOT,
  UNRELEASED_NOTES,
  FOUNDRY_RELEASE_STEP_FIELDS,
  edgeReleaseErrors,
  findPairingDrift,
  foundryReleaseErrors,
  isPlaceholder,
  missingRequiredReferences,
  readSupportedPairing,
  requireReleaseReady,
  validatePairing,
} from "./supported-pairing.mjs";

const record = readSupportedPairing();

/** A rejected entry for fixtures; the live record currently rejects nothing. */
const REJECTED_FIXTURE = {
  image: `ferrumedge/ferrum-edge@sha256:${"f".repeat(64)}`,
  version: "v0.0.1",
  evidence: "https://github.com/ferrum-edge/ferrum-foundry/actions/runs/1",
  finding: "fixture",
};

function withRejected(base) {
  const copy = structuredClone(base);
  copy.edge.rejected_images = [
    ...(copy.edge.rejected_images ?? []),
    structuredClone(REJECTED_FIXTURE),
  ];
  return copy;
}

function repoFile(path) {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("the supported pairing record", () => {
  it("is structurally valid and pins the gateway CI runs by digest", () => {
    assert.deepEqual(validatePairing(record), []);
    assert.match(record.edge.image, /^ferrumedge\/ferrum-edge@sha256:[0-9a-f]{64}$/);
  });

  it("names the Edge release to pair with only once it is recorded and qualified", () => {
    const release = record.edge.release;
    assert.ok(release.requirements.some((requirement) => requirement.includes("ferrum-edge#5661")));
    assert.ok(release.requirements.some((requirement) => requirement.includes("Deployment Starter")));
    if (isPlaceholder(release.image)) {
      // No published Edge release qualifies yet, so nothing may be tagged.
      assert.equal(record.status, "candidate");
      assert.ok(edgeReleaseErrors(record).length > 0);
    } else {
      assert.match(
        release.version,
        /^v\d+\.\d+\.\d+$/,
        "a recorded release is a published Edge version",
      );
    }
  });

  it("pins the verified v0.9.11 distribution for pending hosted qualification", () => {
    const image =
      "ferrumedge/ferrum-edge@sha256:2476b502855940e28157858fc24008545cb3baeb3084c9610e1d4505cbe0d36e";
    const sourceCommit = "c764084b3b51c3f7ffde268c039688d35e49c553";
    const manifests = {
      "linux/amd64": "sha256:7287d297e8f305c99143e148f910024e50fac0341e7fd89236325331fe405b22",
      "linux/arm64": "sha256:738a68e81da5cc9c0dde8e8ed5ba9e9c6957fcbdd930070d60d8782c303bb9eb",
    };
    assert.equal(record.edge.image, image);
    assert.equal(record.edge.source_commit, sourceCommit);
    assert.deepEqual(record.edge.platform_manifests, manifests);
    assert.match(record.edge.build, /v0\.9\.11/);

    const release = record.edge.release;
    assert.equal(release.version, "v0.9.11");
    assert.equal(release.image, image);
    assert.equal(release.source_commit, sourceCommit);
    assert.deepEqual(release.platform_manifests, manifests);
    assert.deepEqual(edgeReleaseErrors(record), []);
    assert.ok(!record.edge.rejected_images.some((entry) => entry.image === record.edge.image));
  });

  it("never pairs with v0.9.5, which lacks ferrum-edge#5661, or the unpublished v0.9.6", () => {
    for (const version of ["v0.9.5", "v0.9.6"]) {
      assert.notEqual(record.edge.release.version, version);
    }
    assert.ok(
      !JSON.stringify(record.edge).includes(
        "eca46c84bca92d6ef467979f8846537f7ab56c0cdc137befff465526a10fe10f",
      ),
      "the v0.9.5 digest belongs to history, not to edge.image or edge.release",
    );
  });

  it("records the Edge 0.9.x semantics the gates now assert", () => {
    const semantics = record.edge.release.requirements.find((requirement) =>
      requirement.includes("ferrum-edge#4611"),
    );
    assert.ok(semantics, "the association and namespace-identity requirement must stay recorded");
    assert.match(semantics, /5db1d77a8/);
    assert.match(semantics, /#409/);
  });

  it("records the Foundry candidate preparation against the verified Edge distribution", () => {
    assert.equal(record.foundry.version, "0.5.0");
    assert.equal(record.foundry.previous_release, "v0.4.0");
    const pkg = JSON.parse(repoFile("package.json"));
    const lock = JSON.parse(repoFile("package-lock.json"));
    // The release workflow requires the tag, package.json, and the record to agree.
    assert.equal(pkg.version, record.foundry.version);
    assert.equal(lock.version, record.foundry.version);
    assert.equal(lock.packages[""].version, record.foundry.version);
    for (const field of ["source_commit", "image", "ci_evidence"]) {
      assert.equal(
        record.foundry[field] === null,
        record.status !== "released",
        `foundry.${field} reflects whether this release has been published`,
      );
    }
    if (record.status === "released") {
      // A released record also mirrors the recorded Foundry artifacts in docs.
      for (const field of ["source_commit", "image", "ci_evidence"]) {
        assert.notEqual(record.foundry[field], null, `foundry.${field} after release`);
      }
      // docs/compatibility.md mirrors them, with no release-step marker left.
      const doc = repoFile("docs/compatibility.md");
      for (const field of ["source_commit", "image", "ci_evidence"]) {
        assert.ok(doc.includes(record.foundry[field]), `compatibility.md names foundry.${field}`);
      }
      assert.ok(!doc.includes("*release step*"), "compatibility.md has no release-step marker");
    } else {
      assert.ok(
        repoFile("docs/compatibility.md").includes("*release step*"),
        "the prepared release's unpublished artifacts remain marked",
      );
    }
    assert.deepEqual(record.foundry.platforms, ["linux/amd64", "linux/arm64"]);
  });

  it("preserves the published v0.4.0 facts separately from the candidate", () => {
    const previous = JSON.parse(repoFile("docs/release-notes/v0.4.0.compatibility.json"));
    assert.equal(previous.status, "released");
    assert.equal(previous.record_version, 1);
    assert.equal(previous.foundry.version, "0.4.0");
    assert.equal(previous.foundry.source_commit, "cb6dbe5b2b2e3f3ed211d5e829322d867ecb7a36");
    assert.equal(
      previous.foundry.image,
      "ferrumedge/ferrum-foundry@sha256:03d4baa0e424c4438abb65da4ee3a4441f50cde9f2eb4e28664e5cf0698c0241",
    );
    assert.equal(
      previous.foundry.ci_evidence,
      "https://github.com/ferrum-edge/ferrum-foundry/actions/runs/36874319153",
    );
    assert.equal(previous.edge.release.version, "v0.9.10");
    assert.notEqual(previous.edge.image, record.edge.image);
    assert.deepEqual(record.tested, previous.tested);
    assert.deepEqual(record.best_effort, previous.best_effort);
  });

  it("records the Edge changes the pairing depends on as released in it", () => {
    const changes = record.edge_dependencies.map((entry) => entry.change);
    assert.deepEqual(changes, ["ferrum-edge#5661", "ferrum-edge#5726"]);
    // The status's last clause lists the releases that carry the change
    // ("released in Ferrum Edge vA" or "retained in Ferrum Edge vA and vB");
    // edge.release must be one of them, whatever the others are.
    for (const dependency of record.edge_dependencies) {
      const clause = dependency.status.split(";").at(-1);
      const carriedBy = /(?:released|retained) in Ferrum Edge (.+)$/.exec(clause)?.[1] ?? "";
      assert.ok(
        carriedBy.split(/,\s*(?:and\s+)?|\s+and\s+/).includes(record.edge.release.version),
        `${dependency.change}: ${dependency.status}`,
      );
    }
  });
});

describe("validatePairing", () => {
  const valid = structuredClone(record);

  it("rejects a mutable tag, a missing platform, and a rejected image", () => {
    const tagged = structuredClone(valid);
    tagged.edge.image = "ferrumedge/ferrum-edge:v0.9.5";
    assert.ok(validatePairing(tagged).some((error) => error.includes("tags are mutable")));

    const oneArch = structuredClone(valid);
    delete oneArch.edge.platform_manifests["linux/arm64"];
    assert.ok(validatePairing(oneArch).some((error) => error.includes("linux/arm64")));

    const repinned = withRejected(valid);
    repinned.edge.image = REJECTED_FIXTURE.image;
    assert.ok(validatePairing(repinned).includes("edge.image is listed as rejected"));

    const repaired = withRejected(valid);
    repaired.edge.release.version = REJECTED_FIXTURE.version;
    assert.ok(validatePairing(repaired).some((error) => error.includes("evaluated and rejected")));

    const unexplained = structuredClone(valid);
    unexplained.edge.rejected_images = [{ image: REJECTED_FIXTURE.image }];
    assert.ok(validatePairing(unexplained).some((error) => error.includes("needs an image digest")));

    const guessed = structuredClone(valid);
    guessed.edge.release.image = "ferrumedge/ferrum-edge:latest";
    assert.ok(validatePairing(guessed).some((error) => error.startsWith("edge.release.image")));
  });

  it("is release-ready only when edge.image is the recorded Edge release", () => {
    const recorded = structuredClone(valid);
    // This falsifies an in-progress pairing evaluation; a released record can
    // only pair with the Edge release it was already qualified against.
    recorded.status = "candidate";
    Object.assign(recorded.edge.release, {
      version: "v9.9.9",
      source_commit: "d".repeat(40),
      image: `ferrumedge/ferrum-edge@sha256:${"e".repeat(64)}`,
      platform_manifests: {
        "linux/amd64": `sha256:${"1".repeat(64)}`,
        "linux/arm64": `sha256:${"2".repeat(64)}`,
      },
    });
    assert.deepEqual(validatePairing(recorded), []);
    assert.ok(edgeReleaseErrors(recorded).some((error) => error.includes("has not qualified")));

    const pinned = structuredClone(recorded);
    Object.assign(pinned.edge, {
      image: pinned.edge.release.image,
      source_commit: pinned.edge.release.source_commit,
      platform_manifests: { ...pinned.edge.release.platform_manifests },
    });
    assert.deepEqual(edgeReleaseErrors(pinned), []);
  });

  it("releases only the unreleased candidate record (GHSA-rw8r-hrr2-vpc2)", () => {
    // The checked-in record has been through its release step, so a tag moved
    // or re-created onto this commit, or any later one, must not publish
    // foundry.version again.
    if (record.status === "released") {
      const errors = foundryReleaseErrors(record);
      assert.ok(errors.some((error) => error.includes('not "candidate"')));
      for (const field of FOUNDRY_RELEASE_STEP_FIELDS) {
        assert.ok(errors.some((error) => error.startsWith(`foundry.${field} is already recorded`)));
      }
    }

    // The commit that prepares a release: candidate, artifacts null.
    const candidate = structuredClone(valid);
    candidate.status = "candidate";
    for (const field of FOUNDRY_RELEASE_STEP_FIELDS) {
      candidate.foundry[field] = null;
    }
    assert.deepEqual(validatePairing(candidate), []);
    assert.deepEqual(foundryReleaseErrors(candidate), []);

    const recordedValues = {
      source_commit: "a".repeat(40),
      image: `ferrumedge/ferrum-foundry@sha256:${"b".repeat(64)}`,
      ci_evidence: "https://github.com/ferrum-edge/ferrum-foundry/actions/runs/123",
    };
    for (const field of FOUNDRY_RELEASE_STEP_FIELDS) {
      const recorded = structuredClone(candidate);
      recorded.foundry[field] = recordedValues[field];
      assert.deepEqual(validatePairing(recorded), []);
      assert.deepEqual(foundryReleaseErrors(recorded), [
        `foundry.${field} is already recorded; this version was already released`,
      ]);
    }

    const released = structuredClone(candidate);
    released.status = "released";
    assert.equal(foundryReleaseErrors(released).length, 1);
    assert.equal(foundryReleaseErrors(undefined).length, 1 + FOUNDRY_RELEASE_STEP_FIELDS.length);
  });

  it("allows null artifact fields only until the record is marked released", () => {
    const released = structuredClone(valid);
    released.status = "released";
    released.qualification = {
      status: "qualified",
      ci_evidence: "https://github.com/ferrum-edge/ferrum-foundry/actions/runs/123",
    };
    for (const field of FOUNDRY_RELEASE_STEP_FIELDS) {
      released.foundry[field] = null;
      assert.ok(validatePairing(released).includes(`foundry.${field} is still null`));
    }

    const filled = structuredClone(released);
    Object.assign(filled.foundry, {
      version: "0.2.0",
      source_commit: "a".repeat(40),
      image: `ferrumedge/ferrum-foundry@sha256:${"b".repeat(64)}`,
      ci_evidence: "https://github.com/ferrum-edge/ferrum-foundry/actions/runs/123",
    });
    // A released record also needs the Edge release it was qualified against.
    // The checked-in record now carries a real one, so blank it here.
    const unqualified = structuredClone(filled);
    unqualified.edge.release.image = `${PLACEHOLDER_PREFIX}: edge release image`;
    assert.ok(
      validatePairing(unqualified).some((error) => error.startsWith("edge.release.image")),
    );
    const edgeImage = `ferrumedge/ferrum-edge@sha256:${"e".repeat(64)}`;
    const manifests = {
      "linux/amd64": `sha256:${"1".repeat(64)}`,
      "linux/arm64": `sha256:${"2".repeat(64)}`,
    };
    Object.assign(filled.edge.release, {
      version: "v9.9.9",
      source_commit: "d".repeat(40),
      image: edgeImage,
      platform_manifests: manifests,
    });
    Object.assign(filled.edge, {
      image: edgeImage,
      source_commit: "d".repeat(40),
      platform_manifests: { ...manifests },
    });
    assert.deepEqual(validatePairing(filled), []);

    const guessed = structuredClone(valid);
    guessed.foundry.image = "ferrumedge/ferrum-foundry:latest";
    assert.ok(validatePairing(guessed).some((error) => error.includes("foundry.image")));
  });

  it("requires metadata version 2 and refuses missing or string candidate placeholders", () => {
    const oldVersion = structuredClone(valid);
    oldVersion.record_version = 1;
    assert.ok(validatePairing(oldVersion).includes("record_version must be 2"));
    for (const field of FOUNDRY_RELEASE_STEP_FIELDS) {
      for (const value of [undefined, "", `${PLACEHOLDER_PREFIX}: ${field}`]) {
        const malformed = structuredClone(valid);
        malformed.foundry[field] = value;
        assert.ok(validatePairing(malformed).some((error) => error.startsWith(`foundry.${field}`)));
        assert.ok(
          foundryReleaseErrors(malformed).some((error) => error.startsWith(`foundry.${field}`)),
        );
      }
    }
    const noVersion = structuredClone(valid);
    noVersion.foundry.version = null;
    assert.ok(validatePairing(noVersion).some((error) => error.startsWith("foundry.version")));
  });

  it("does not present missing hosted evidence or a draft as qualified", () => {
    for (const qualification of [
      {},
      {
        status: "pending",
        ci_evidence: "https://github.com/ferrum-edge/ferrum-foundry/actions/runs/123",
      },
      { status: "qualified", ci_evidence: null },
    ]) {
      const malformed = structuredClone(valid);
      malformed.qualification = qualification;
      assert.ok(validatePairing(malformed).some((error) => error.includes("qualification.")));
    }
  });
});

describe("requireReleaseReady", () => {
  // The candidate commit that prepares a release: status candidate, Foundry
  // artifacts still null. Its Edge release has hosted qualification evidence.
  const candidate = structuredClone(record);
  candidate.status = "candidate";
  for (const field of FOUNDRY_RELEASE_STEP_FIELDS) {
    candidate.foundry[field] = null;
  }
  candidate.qualification = {
    status: "qualified",
    ci_evidence: "https://github.com/ferrum-edge/ferrum-foundry/actions/runs/123",
  };

  it("passes the unreleased candidate the release workflow tags", () => {
    assert.deepEqual(requireReleaseReady(candidate), {
      ready: true,
      edge: candidate.edge.release.version,
      image: candidate.edge.image,
    });
  });

  it("refuses a published version through foundryReleaseErrors", () => {
    // The command's second check is foundryReleaseErrors: a released status or
    // a recorded artifact must stop the tag even when the record validates.
    const recorded = {
      source_commit: "a".repeat(40),
      image: `ferrumedge/ferrum-foundry@sha256:${"b".repeat(64)}`,
      ci_evidence: "https://github.com/ferrum-edge/ferrum-foundry/actions/runs/123",
    };
    const publishedStatus = structuredClone(candidate);
    publishedStatus.status = "released";
    Object.assign(publishedStatus.foundry, recorded);
    const publishedArtifact = structuredClone(candidate);
    Object.assign(publishedArtifact.foundry, recorded);
    for (const published of [publishedStatus, publishedArtifact]) {
      assert.deepEqual(validatePairing(published), []);
      assert.throws(
        () => requireReleaseReady(published),
        (error) => {
          assert.match(error.message, /is not an unreleased candidate/);
          assert.match(error.message, /Tag the commit that prepared this version/);
          return true;
        },
      );
    }
  });

  it("refuses an unqualified Edge release before it checks the candidate status", () => {
    const unqualified = structuredClone(candidate);
    unqualified.edge.release.image = `${PLACEHOLDER_PREFIX}: edge release image`;
    assert.throws(
      () => requireReleaseReady(unqualified),
      /does not name a qualified Ferrum Edge release/,
    );
  });

  it("refuses a draft pairing even when the verified Edge distribution is pinned", () => {
    for (const qualification of [
      { status: "pending", ci_evidence: null },
      { status: "qualified", ci_evidence: null },
    ]) {
      assert.throws(
        () => requireReleaseReady({ ...candidate, qualification }),
        /hosted qualification is still pending/,
      );
    }
  });

  it("wires the release-ready command to requireReleaseReady, not an inline check", () => {
    // requireReleaseReady is the seam the tests above exercise; this pins that
    // main() actually calls it rather than reverting to an inline edge check.
    assert.match(
      repoFile("scripts/supported-pairing.mjs"),
      /command === "release-ready"\) \{\n\s+console\.log\(JSON\.stringify\(requireReleaseReady\(record\)\)\)/,
    );
  });
});

describe("repository alignment", () => {
  it("pins no Ferrum Edge image but the supported one outside history", () => {
    assert.deepEqual(findPairingDrift(record), []);
  });

  it("starts the supported image from the starter and the local-run instructions", () => {
    assert.deepEqual(missingRequiredReferences(record), []);
    assert.match(
      repoFile("deploy/starter/compose.yaml"),
      new RegExp(`demo-gateway:\\n\\s+image: ${record.edge.image.replace(/[/.]/g, "\\$&")}(?: #[^\\n]*)?\\n`),
    );
  });

  it("has CI read the gateway image from the record rather than repeat it", () => {
    const workflow = repoFile(".github/workflows/ci.yml");
    assert.equal(workflow.match(EDGE_REFERENCE), null, "ci.yml must not pin an Edge image itself");
    const runs = [...workflow.matchAll(/docker run [^\n]*\\\n(?:[^\n]*\\\n)*[^\n]*\n/g)]
      .map(([block]) => block)
      .filter((block) => /FERRUM_MODE=database/.test(block));
    assert.ok(runs.length >= 3, "the contract, read-only parity, and container gateways");
    for (const block of runs) assert.match(block, /"\$FERRUM_EDGE_IMAGE"\s*$/);
    assert.match(workflow, /node scripts\/supported-pairing\.mjs edge-image/);
  });

  it("has the release workflow refuse a tag until the Edge release is qualified", () => {
    const workflow = repoFile(".github/workflows/release.yml");
    assert.match(workflow, /node scripts\/supported-pairing\.mjs release-ready\n/);
  });

  describe("the release workflow never reassigns a release (GHSA-rw8r-hrr2-vpc2)", () => {
    const workflow = repoFile(".github/workflows/release.yml");
    const job = (name) => {
      const start = workflow.indexOf(`\n  ${name}:\n`);
      assert.ok(start >= 0, `release.yml has a ${name} job`);
      const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
      return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
    };
    const metadata = job("release-metadata");
    const build = job("docker");
    const manifest = job("docker-manifest");
    const release = job("create-release");
    const TAG_IS_THIS_COMMIT = /if \[\[ "\$tag_commit" != "\$GITHUB_SHA" \]\]; then\n\s+echo [^\n]*\n\s+exit 1/;

    it("binds the tag to this run's commit before building, publishing, and releasing", () => {
      assert.match(metadata, TAG_IS_THIS_COMMIT);
      for (const later of [manifest, release]) {
        assert.match(later, /git fetch --no-tags origin "\+refs\/tags\/\$\{RELEASE_TAG\}:refs\/release-check\/tag"/);
        assert.match(later, TAG_IS_THIS_COMMIT);
      }
      // The manifest job re-checks after waiting for earlier runs, before any login.
      const recheck = manifest.search(TAG_IS_THIS_COMMIT);
      assert.ok(recheck > manifest.indexOf("Wait for earlier release runs"));
      assert.ok(recheck < manifest.indexOf("docker/login-action"));
      assert.ok(release.search(TAG_IS_THIS_COMMIT) < release.indexOf("gh release create"));
    });

    it("refuses an existing GitHub release and foreign registry tags before any build", () => {
      assert.match(metadata, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/releases\/tags\/\$\{RELEASE_TAG\}"/);
      assert.match(metadata, /grep --quiet 'HTTP 404'/);
      assert.match(metadata, /run: node scripts\/release-image-identity\.mjs preflight\n/);
      assert.match(metadata, /IMAGE_REPOSITORIES: ferrumedge\/ferrum-foundry ghcr\.io\/\$\{\{ github\.repository \}\}\n/);
      assert.match(metadata, /SOURCE_REVISION: \$\{\{ github\.sha \}\}\n/);
      assert.doesNotMatch(metadata, /login-action|secrets\.DOCKERHUB/);
      assert.match(build, /needs: \[quality-gates, release-metadata\]/);
    });

    it("compares both version tags in both registries before writing either registry", () => {
      const identity = manifest.indexOf("Refuse to reassign published release version tags");
      const firstWrite = manifest.search(/imagetools create (?!--dry-run)/);
      assert.ok(identity > 0 && identity < firstWrite, "the comparison precedes every registry write");
      const step = manifest.slice(identity, manifest.indexOf("Create and push multi-arch manifest (Docker Hub)"));
      assert.match(step, /imagetools create --dry-run/);
      assert.match(step, /for repository in ferrumedge\/ferrum-foundry "\$GHCR_REPOSITORY"; do/);
      assert.match(step, /for tag in "\$RELEASE_TAG" "\$RELEASE_VERSION"; do/);
      assert.match(step, /release-image-identity\.mjs" compare "\$repository" "\$release_digest" "\$tag"/);
    });

    it("writes a version tag only when absent and only as this run's digest", () => {
      const writes = [...manifest.matchAll(/^\s*docker buildx imagetools create (?!--dry-run)(.*)$/gm)]
        .map(([, args]) => args.trim());
      assert.deepEqual(writes, [
        '-t "$IMAGE_REPOSITORY:$tag" "$@"',
        '"${channel_tags[@]}" "$IMAGE_REPOSITORY@$RELEASE_DIGEST"',
        '-t "$IMAGE_REPOSITORY:$tag" "$@"',
        '"${channel_tags[@]}" "$IMAGE_REPOSITORY@$RELEASE_DIGEST"',
      ]);
      // Only X.Y and latest are channels; X.Y.Z is a version tag.
      const channels = [...manifest.matchAll(/channel_tags\+?=\((.*)\)$/gm)].map(([, tags]) => tags);
      assert.deepEqual(channels.sort(), [
        "",
        "",
        '-t "$IMAGE_REPOSITORY:$RELEASE_MAJOR_MINOR"',
        '-t "$IMAGE_REPOSITORY:$RELEASE_MAJOR_MINOR"',
        '-t "$IMAGE_REPOSITORY:latest"',
        '-t "$IMAGE_REPOSITORY:latest"',
      ].sort());
      const guarded = /if \[\[ "\$state" == "absent" \]\]; then\n\s+docker buildx imagetools create -t "\$IMAGE_REPOSITORY:\$tag" "\$@"/g;
      assert.equal(manifest.match(guarded)?.length, 2);
      assert.equal(manifest.match(/if \[\[ "\$state" != "published" \]\]; then/g)?.length, 2);
      assert.equal(manifest.match(/publish_version_tag "\$RELEASE_TAG" "\$\{images\[@\]\}"/g)?.length, 2);
      assert.equal(
        manifest.match(/publish_version_tag "\$RELEASE_VERSION" "\$IMAGE_REPOSITORY@\$RELEASE_DIGEST"/g)?.length,
        2,
      );
    });

    it("records the published digest in the GitHub release", () => {
      assert.match(manifest, /outputs:\n\s+digest: \$\{\{ steps\.identity\.outputs\.digest \}\}/);
      assert.match(release, /RELEASE_DIGEST: \$\{\{ needs\.docker-manifest\.outputs\.digest \}\}/);
      assert.match(release, /ferrumedge\/ferrum-foundry@\{digest\}/);
    });

    it("persists the first run's planned digests for a later attempt to name", () => {
      // A partial publish must stay diagnosable: the per-platform digests the
      // build pushed are retained at the repository's maximum, and the
      // manifest job records the index digest they produce beside them, so a
      // later attempt can name what an earlier one wrote. See
      // docs/release-security.md -> "A half-published version is stranded".
      assert.match(
        build,
        /name: release-docker-digest-\$\{\{ matrix\.arch_dir \}\}\n\s+path: \/tmp\/digests\/\*\n\s+if-no-files-found: error\n\s+retention-days: 90/,
      );
      assert.match(
        manifest,
        /name: release-planned-digests\n\s+path: \/tmp\/release-plan\.txt\n\s+if-no-files-found: error\n\s+retention-days: 90/,
      );
      assert.match(
        manifest,
        /echo "index=\$RELEASE_DIGEST"\n[\s\S]*?echo "platform=sha256:\$digest"\n\s+done\n\s+\} > \/tmp\/release-plan\.txt/,
      );
    });

    it("records and uploads the plan before the first registry write", () => {
      const record = manifest.indexOf("Record the first run's planned digests");
      const upload = manifest.indexOf("Upload the first run's planned digests");
      const firstWrite = manifest.search(/imagetools create (?!--dry-run)/);
      assert.ok(record > 0 && record < upload, "the plan is recorded before it is uploaded");
      assert.ok(upload < firstWrite, "the plan upload precedes every registry write");
    });
  });

  it("publishes the release notes for foundry.version against the same pairing", () => {
    // The release step moves UNRELEASED.md to the version's own notes, which
    // the release workflow publishes; UNRELEASED.md then drafts the next one.
    const release = record.edge.release;
    const versioned = `docs/release-notes/v${record.foundry.version}.md`;
    const path = isPlaceholder(record.foundry.version) ? UNRELEASED_NOTES : versioned;
    assert.ok(existsSync(join(REPO_ROOT, path)), `${path} must exist`);
    const notes = repoFile(path);
    if (isPlaceholder(release.image)) {
      // The notes must not present the CI pin, which is not the pairing, as the pairing.
      assert.ok(!notes.includes(record.edge.image), "the draft must not pair with edge.image");
      assert.match(notes, /\| Ferrum Edge \| \*release step\*/);
    } else {
      assert.ok(notes.includes(release.image));
      assert.ok(notes.includes(release.source_commit));
      assert.ok(notes.includes(`Ferrum Edge ${release.version}`));
      for (const digest of Object.values(release.platform_manifests)) assert.ok(notes.includes(digest));
    }
    for (const rejected of record.edge.rejected_images ?? []) {
      assert.ok(notes.includes(rejected.evidence), `release notes must cite ${rejected.version}'s run`);
    }
    for (const dependency of record.edge_dependencies ?? []) {
      assert.ok(notes.includes(dependency.change), `release notes must state ${dependency.change}`);
    }
  });

  it("keeps a release-notes draft for the next release that pins nothing", () => {
    const draft = repoFile(UNRELEASED_NOTES);
    assert.equal(draft.match(EDGE_REFERENCE), null, "the draft names no Edge image until its release step");
    assert.ok(!draft.includes(`# Ferrum Foundry v${record.foundry.version}`));
  });

  it("documents the same pairing in the human-readable record", () => {
    const doc = repoFile("docs/compatibility.md");
    assert.ok(doc.includes(record.edge.image));
    assert.ok(doc.includes(record.edge.source_commit));
    for (const digest of Object.values(record.edge.platform_manifests)) assert.ok(doc.includes(digest));
    for (const rejected of record.edge.rejected_images ?? []) {
      assert.ok(doc.includes(rejected.image));
      assert.ok(doc.includes(rejected.evidence));
    }
  });
});

describe("findPairingDrift", () => {
  function fixture(files) {
    const root = mkdtempSync(join(tmpdir(), "supported-pairing-"));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  it("reports tags, bare names, other digests, and rejected digests in any form", () => {
    const rejecting = withRejected(record);
    const rejected = REJECTED_FIXTURE.image;
    const root = fixture({
      "README.md": `docker run ${record.edge.image}\n`,
      "docs/a.md": "docker run ferrumedge/ferrum-edge:latest\ndocker pull ferrumedge/ferrum-edge\n",
      "deploy/compose.yaml": `image: ferrumedge/ferrum-edge@sha256:${"c".repeat(64)}\n`,
      "docs/b.md": `the old digest ${rejected.split("@")[1]}\n`,
      "CHANGELOG.md": `- pinned ${rejected}\n`,
      "docs/release-notes/v0.1.0.md": "ferrumedge/ferrum-edge:v0.9.0\n",
      [UNRELEASED_NOTES]: "ferrumedge/ferrum-edge:v0.9.0\n",
      "node_modules/pkg/README.md": "ferrumedge/ferrum-edge:latest\n",
    });
    try {
      const found = findPairingDrift(rejecting, root)
        .map(({ file, line, found: what }) => `${file}:${line} ${what}`)
        .sort();
      assert.deepEqual(found, [
        `deploy/compose.yaml:1 ferrumedge/ferrum-edge@sha256:${"c".repeat(64)}`,
        "docs/a.md:1 ferrumedge/ferrum-edge:latest",
        "docs/a.md:2 ferrumedge/ferrum-edge",
        `docs/b.md:1 rejected ${rejected.split("@")[1]}`,
        `${UNRELEASED_NOTES}:1 ferrumedge/ferrum-edge:v0.9.0`,
      ].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not mistake the source repository URL for an image", () => {
    const root = fixture({
      "README.md": "See https://github.com/ferrum-edge/ferrum-edge/blob/main/openapi.yaml\n",
    });
    try {
      assert.deepEqual(findPairingDrift(record, root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
