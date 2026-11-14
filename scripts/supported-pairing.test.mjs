import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { hostedQualificationFixture } from "./fixtures/hosted-qualification.mjs";

const RELEASE_ENVIRONMENT_PATTERN = /^ {4}environment: release$/m;
const FERRUMEDGE_FERRUM_EDGE_SHA256_PATTERN = /^ferrumedge\/ferrum-edge@sha256:[0-9a-f]{64}$/;
const SEMVER_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const V0_9_20_PATTERN = /v0\.9\.20/;
const EDGE_COMMIT_5DB1D77A8_PATTERN = /5db1d77a8/;
const EDGE_ISSUE_409_PATTERN = /#409/;
const HOSTED_QUALIFICATION_IS_STILL_PENDING_PATTERN = /hosted qualification is still pending/;
const RUN_DOES_NOT_MATCH_PATTERN = /run does not match/;
const RELEASED_RETAINED_IN_FERRUM_EDGE_PATTERN = /(?:released|retained) in Ferrum Edge (.+)$/;
const LIST_SEPARATOR_PATTERN = /,\s*(?:and\s+)?|\s+and\s+/;
const COMPLETED_AND_SUCCESSFUL_PATTERN = /completed and successful/;
const IS_NOT_AN_UNRELEASED_CANDIDATE_PATTERN = /is not an unreleased candidate/;
const TAG_THE_COMMIT_THAT_PREPARED_PATTERN = /Tag the commit that prepared this version/;
const DOES_NOT_NAME_A_QUALIFIED_PATTERN = /does not name a qualified Ferrum Edge release/;
const COMMAND_RELEASE_READY_CONST_EVIDENCE_PATTERN =
  /command === "release-ready"\) \{\n\s+const evidence = await readHostedQualification\(record\);\n\s+console\.log\(JSON\.stringify\(requireReleaseReady\(record, evidence\)\)\)/;
const DOCKER_RUN_PATTERN = /docker run [^\n]*\\\n(?:[^\n]*\\\n)*[^\n]*\n/g;
const FERRUM_MODE_DATABASE_PATTERN = /FERRUM_MODE=database/;
const FERRUM_EDGE_IMAGE_PATTERN = /"\$FERRUM_EDGE_IMAGE"\s*$/;
const NODE_SCRIPTS_SUPPORTED_PAIRING_MJS_PATTERN =
  /node scripts\/supported-pairing\.mjs edge-image/;
const NODE_SCRIPTS_SUPPORTED_PAIRING_MJS_RELEASE_PATTERN =
  /node scripts\/supported-pairing\.mjs release-ready\n/;
const READ_ONLY_PERMISSIONS_PATTERN = /permissions:\n\s+actions: read\n\s+contents: read\n/;
const GH_TOKEN_SECRETS_GITHUB_TOKEN_PATTERN = /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/;
const WRITE_PERMISSION_PATTERN = /actions: write|contents: write/;
const NEXT_JOB_PATTERN = /\n {2}[a-z-]+:\n/;
const GIT_FETCH_NO_TAGS_ORIGIN_PATTERN =
  /git fetch --no-tags origin "\+refs\/tags\/\$\{RELEASE_TAG\}:refs\/release-check\/tag"/;
const GH_API_REPOS_GITHUB_REPOSITORY_RELEASES_PATTERN =
  /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/releases\/tags\/\$\{RELEASE_TAG\}"/;
const GREP_QUIET_HTTP_404_PATTERN = /grep --quiet 'HTTP 404'/;
const RUN_NODE_SCRIPTS_RELEASE_IMAGE_PATTERN =
  /run: node scripts\/release-image-identity\.mjs preflight\n/;
const IMAGE_REPOSITORIES_FERRUMEDGE_FERRUM_FOUNDRY_PATTERN =
  /IMAGE_REPOSITORIES: ferrumedge\/ferrum-foundry ghcr\.io\/\$\{\{ github\.repository \}\}\n/;
const SOURCE_REVISION_GITHUB_SHA_PATTERN = /SOURCE_REVISION: \$\{\{ github\.sha \}\}\n/;
const LOGIN_ACTION_SECRETS_DOCKERHUB_PATTERN = /login-action|secrets\.DOCKERHUB/;
const NEEDS_PATTERN = /needs: \[quality-gates, release-metadata\]/;
const IMAGETOOLS_CREATE_DRY_RUN_PATTERN = /imagetools create (?!--dry-run)/;
const IMAGETOOLS_CREATE_DRY_RUN_2_PATTERN = /imagetools create --dry-run/;
const FOR_REPOSITORY_IN_FERRUMEDGE_FERRUM_PATTERN =
  /for repository in ferrumedge\/ferrum-foundry "\$GHCR_REPOSITORY"; do/;
const FOR_TAG_IN_RELEASE_TAG_RELEASE_VERSION_PATTERN =
  /for tag in "\$RELEASE_TAG" "\$RELEASE_VERSION"; do/;
const RELEASE_IMAGE_IDENTITY_MJS_COMPARE_PATTERN =
  /release-image-identity\.mjs" compare "\$repository" "\$release_digest" "\$tag"/;
const DOCKER_BUILDX_IMAGETOOLS_CREATE_DRY_PATTERN =
  /^\s*docker buildx imagetools create (?!--dry-run)(.*)$/gm;
const CHANNEL_TAGS_PATTERN = /channel_tags\+?=\((.*)\)$/gm;
const TAG_IS_THIS_COMMIT =
  /if \[\[ "\$tag_commit" != "\$GITHUB_SHA" \]\]; then\n\s+echo [^\n]*\n\s+exit 1/;
const ABSENT_TAG_GUARDED_CREATE_PATTERN =
  /if \[\[ "\$state" == "absent" \]\]; then\n\s+docker buildx imagetools create -t "\$IMAGE_REPOSITORY:\$tag" "\$@"/g;
const UNPUBLISHED_STATE_GUARD_PATTERN = /if \[\[ "\$state" != "published" \]\]; then/g;
const PUBLISH_VERSION_TAG_RELEASE_TAG_IMAGES_PATTERN =
  /publish_version_tag "\$RELEASE_TAG" "\$\{images\[@\]\}"/g;
const PUBLISH_VERSION_TAG_RELEASE_VERSION_PATTERN =
  /publish_version_tag "\$RELEASE_VERSION" "\$IMAGE_REPOSITORY@\$RELEASE_DIGEST"/g;
const IDENTITY_DIGEST_OUTPUT_PATTERN =
  /outputs:\n\s+digest: \$\{\{ steps\.identity\.outputs\.digest \}\}/;
const RELEASE_DIGEST_NEEDS_DOCKER_MANIFEST_PATTERN =
  /RELEASE_DIGEST: \$\{\{ needs\.docker-manifest\.outputs\.digest \}\}/;
const FERRUMEDGE_FERRUM_FOUNDRY_DIGEST_PATTERN = /ferrumedge\/ferrum-foundry@\{digest\}/;
const NAME_RELEASE_DOCKER_DIGEST_MATRIX_PATTERN =
  /name: release-docker-digest-\$\{\{ matrix\.arch_dir \}\}\n\s+path: \/tmp\/digests\/\*\n\s+if-no-files-found: error\n\s+retention-days: 90/;
const NAME_RELEASE_PLANNED_DIGESTS_PATH_PATTERN =
  /name: release-planned-digests\n\s+path: \/tmp\/release-plan\.txt\n\s+if-no-files-found: error\n\s+retention-days: 90/;
const ECHO_INDEX_RELEASE_DIGEST_PLATFORM_PATTERN =
  /echo "index=\$RELEASE_DIGEST"\n[\s\S]*?echo "platform=sha256:\$digest"\n\s+done\n\s+\} > \/tmp\/release-plan\.txt/;
const FERRUM_EDGE_RELEASE_STEP_PATTERN = /\| Ferrum Edge \| \*release step\*/;

const record = readSupportedPairing();
const qualifiedFixture = hostedQualificationFixture(record);

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
    assert.match(record.edge.image, FERRUMEDGE_FERRUM_EDGE_SHA256_PATTERN);
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
        SEMVER_TAG_PATTERN,
        "a recorded release is a published Edge version",
      );
    }
  });

  it("pins the verified v0.9.20 distribution for hosted qualification", () => {
    const image =
      "ferrumedge/ferrum-edge@sha256:32a0b0574bb2ed105d315888fab12e33242e1cec3ae9f1ae34c1fb4d0c9a2689";
    const sourceCommit = "e4a606a00352674daaef08636e3e359e6c48ba18";
    const manifests = {
      "linux/amd64": "sha256:d3e3e7e8409d0583b23e0fa4eee4b85c7b20885a314d4ada2ca8aad66bd33e1c",
      "linux/arm64": "sha256:406d8335e60f15ee024141762a7b280bea4abe76fef37ac26b65c45085ae7426",
    };
    assert.equal(record.edge.image, image);
    assert.equal(record.edge.source_commit, sourceCommit);
    assert.deepEqual(record.edge.platform_manifests, manifests);
    assert.match(record.edge.build, V0_9_20_PATTERN);

    const release = record.edge.release;
    assert.equal(release.version, "v0.9.20");
    assert.equal(release.image, image);
    assert.equal(release.source_commit, sourceCommit);
    assert.deepEqual(release.platform_manifests, manifests);
    assert.deepEqual(edgeReleaseErrors(record), []);
    assert.ok(!record.edge.rejected_images.some((entry) => entry.image === record.edge.image));
  });

  it("records exact published assets without inventing registry identity evidence", () => {
    const release = record.edge.release;
    assert.deepEqual(release.binary_sha256, {
      "ferrum-cni-linux-aarch64":
        "sha256:47e7e991af1f565b7cc5abcb1f90862daf5a43aa2cc99d948c890991671f0161",
      "ferrum-cni-linux-x86_64":
        "sha256:03cb1d4fb757ea669ae1f46328cf757ad4979d56882205c924cae3487ba114a8",
      "ferrum-edge-linux-aarch64":
        "sha256:7cb5a849fabd6d02ea83af965ac9249de35cc718400625ae528a95c9276cee2f",
      "ferrum-edge-linux-x86_64":
        "sha256:9d357a41ae61cf85d697f01c84beff15f2b8af8bcfd70dd1c50f32397fee66ac",
      "ferrum-edge-macos-aarch64":
        "sha256:c36b586507bd1ed072fbd9f3e2222ef07b2427f460a2ed923f21dbb973eb7061",
      "ferrum-edge-macos-x86_64":
        "sha256:6e5950a31a54552389b25559024f5fa2fe3c4b4fb59803c4f3df3983bc087371",
      "ferrum-edge-windows-x86_64.exe":
        "sha256:6cd00219e86b4f6429437c5d09513284b64532e1c660287044fc44e326a839f1",
    });
    assert.deepEqual(release.openapi, {
      info_version: "0.2.0",
      sha256: "8fa7232d96e1094578dee03cfa1966a4fdd9df77b8e027a9625f56ce6bfd355e",
    });
    assert.equal(
      release.github_release,
      "https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.20",
    );
    assert.equal(release.distribution.ci_evidence, record.edge.source_evidence);
    assert.equal(release.distribution.status, "VERIFIED_DISTRIBUTION");
    // The image layers were not downloaded for this pin, so no byte comparison
    // of the default image's binaries with the release assets is claimed.
    assert.equal(release.distribution.default_image_binaries_match_release_assets, null);
    assert.equal(release.distribution.revision_label, null);
    assert.equal(release.distribution.ghcr_anonymous_access, false);
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
    assert.match(semantics, EDGE_COMMIT_5DB1D77A8_PATTERN);
    assert.match(semantics, EDGE_ISSUE_409_PATTERN);
  });

  it("records the Foundry candidate against the verified Edge distribution", () => {
    assert.equal(record.foundry.version, "0.5.6");
    assert.equal(record.foundry.previous_release, "v0.5.5");
    assert.equal(record.status, "candidate");
    assert.equal(record.qualification.status, "pending");
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

  it("preserves immutable release bytes and never reuses prior qualification for a moved pin", () => {
    for (const [version, digest] of [
      ["0.4.0", "937d06bd98cb3338358f3afa8697eafb17154b423d65da5a8335ee26e70ff9a6"],
      ["0.5.0", "78ca12374fccd5e77d5353916550b5199b508dac718f25d06be570d5e92a39f5"],
      ["0.5.1", "ec09719c04ec65c39279674a85abbfa24b3788544e61a1c51f0a5ecf7ea8a70f"],
      ["0.5.2", "dae44af942b989245ae642c86a9044fdb5b263317c30b283b1a50988d90c5cbf"],
      ["0.5.3", "8e57ea00308afa3aedd04aafcf6e63e7601c7cb1837b7b5787c65cb4a7fd15d4"],
      ["0.5.4", "f69fa7e84ad1f2e89f3a73d64629e87e4bab64de9f7c8f1758941ef461c16647"],
      ["0.5.5", "58fb1d567eddf0a0dc10088164cf8602080a6fb4f47c746c5024da4a8f75313f"],
    ]) {
      const bytes = repoFile(`docs/release-notes/v${version}.compatibility.json`);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
    }
    // The latest release tested Foundry v0.5.5 against Edge v0.9.15; its
    // evidence cannot qualify the candidate's moved pin.
    const currentRelease = JSON.parse(repoFile("docs/release-notes/v0.5.5.compatibility.json"));
    assert.equal(currentRelease.status, "released");
    assert.equal(currentRelease.foundry.version, "0.5.5");
    assert.equal(currentRelease.foundry.source_commit, "359e1cd4efab110475b294452dfeeaefc7a4d5e6");
    assert.equal(
      currentRelease.foundry.image,
      "ferrumedge/ferrum-foundry@sha256:5bdfa947adead6895e9dbdc4b4db5ed7e960bd7fc5ebb9872ac722ced86a8b0f",
    );
    assert.equal(currentRelease.edge.release.version, "v0.9.15");
    assert.notEqual(currentRelease.edge.image, record.edge.image);
    assert.notDeepEqual(record.qualification, currentRelease.qualification);
    assert.ok(
      currentRelease.edge.release.requirements.some(
        (requirement) =>
          requirement.includes("with every job green:") && requirement.includes("Deployment Starter"),
      ),
      "the immutable qualification evidence names the green Deployment Starter job",
    );
    // The prior qualification tested a different source and Edge image.
    const previous = JSON.parse(repoFile("docs/release-notes/v0.5.4.compatibility.json"));
    assert.equal(previous.status, "released");
    assert.equal(previous.foundry.version, "0.5.4");
    assert.equal(previous.foundry.source_commit, "0a855ddeef1e4a998a60a2e0c61e71510365b70e");
    assert.equal(
      previous.foundry.image,
      "ferrumedge/ferrum-foundry@sha256:645061444dc4d824aa256796e3891618e9f8446e7b3eb95c184a3147209975e1",
    );
    assert.equal(previous.edge.release.version, "v0.9.14");
    assert.ok(
      previous.edge.release.requirements.some(
        (requirement) =>
          requirement.includes("with every job green:") && requirement.includes("Deployment Starter"),
      ),
      "the immutable qualification evidence names the green Deployment Starter job",
    );
    assert.notEqual(previous.edge.image, record.edge.image);
    assert.notDeepEqual(record.qualification, previous.qualification);
    if (record.qualification.status === "qualified") {
      for (const field of ["ci_evidence", "source_commit", "tested_commit"]) {
        assert.notEqual(record.qualification[field], previous.qualification[field]);
      }
    }
    const v053 = JSON.parse(repoFile("docs/release-notes/v0.5.3.compatibility.json"));
    assert.equal(v053.status, "released");
    assert.equal(v053.foundry.source_commit, "74a7be374f5c6fcf1284737907e43d8808bb95c6");
    assert.equal(
      v053.foundry.image,
      "ferrumedge/ferrum-foundry@sha256:1edef8251f7786f10ebb67dd333cf9e75f7bf54f7af17ad4452227df3ac9a742",
    );
    assert.equal(v053.edge.release.version, "v0.9.14");
    assert.equal(v053.edge.image, previous.edge.image);
    const v052 = JSON.parse(repoFile("docs/release-notes/v0.5.2.compatibility.json"));
    assert.equal(v052.foundry.source_commit, "ebd09e8d82f773b6840b1edda67fbac287c3f7a0");
    assert.equal(v052.edge.release.version, "v0.9.13");
    const v051 = JSON.parse(repoFile("docs/release-notes/v0.5.1.compatibility.json"));
    assert.equal(v051.foundry.source_commit, "1dc43bd1bbd4c2c89ca14e2a603aa478ab1a0d18");
    assert.equal(v051.edge.release.version, "v0.9.12");
    const v050 = JSON.parse(repoFile("docs/release-notes/v0.5.0.compatibility.json"));
    assert.equal(v050.foundry.source_commit, "7ab9ddb732ebd890fb02928d6e4b22470ceab3f7");
    assert.equal(v050.edge.release.version, "v0.9.11");
    assert.deepEqual(record.tested, previous.tested);
    assert.deepEqual(record.best_effort, previous.best_effort);

    // Published upstream distribution cannot make a pending Foundry source releasable.
    const pending = structuredClone(qualifiedFixture.record);
    pending.qualification = {
      status: "pending",
      ci_evidence: null,
      source_commit: null,
      tested_commit: null,
      run_attempt: null,
    };
    assert.throws(() => requireReleaseReady(pending), HOSTED_QUALIFICATION_IS_STILL_PENDING_PATTERN);
    const reused = structuredClone(qualifiedFixture.record);
    reused.qualification = structuredClone(previous.qualification);
    assert.throws(() => requireReleaseReady(reused, qualifiedFixture.evidence), RUN_DOES_NOT_MATCH_PATTERN);
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
    assert.deepEqual(changes, ["ferrum-edge#5661", "ferrum-edge#5726", "ferrum-edge#6744"]);
    // The status's last clause lists the releases that carry the change
    // ("released in Ferrum Edge vA" or "retained in Ferrum Edge vA and vB");
    // edge.release must be one of them, whatever the others are.
    for (const dependency of record.edge_dependencies) {
      const clause = dependency.status.split(";").at(-1);
      const carriedBy = RELEASED_RETAINED_IN_FERRUM_EDGE_PATTERN.exec(clause)?.[1] ?? "";
      assert.ok(
        carriedBy.split(LIST_SEPARATOR_PATTERN).includes(record.edge.release.version),
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
    released.qualification = structuredClone(qualifiedFixture.record.qualification);
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
  // Fictitious successful hosted evidence for the pending tree, followed only
  // by an evidence record, applied to a candidate copy of the live record. The
  // live record itself is already released and cannot release again.
  const { record: candidate, evidence } = qualifiedFixture;

  it("passes the unreleased candidate the release workflow tags", () => {
    assert.deepEqual(requireReleaseReady(candidate, evidence), {
      ready: true,
      edge: candidate.edge.release.version,
      image: candidate.edge.image,
    });
  });

  it("refuses a URL without verified hosted evidence", () => {
    assert.throws(() => requireReleaseReady(candidate), RUN_DOES_NOT_MATCH_PATTERN);
    const failed = structuredClone(evidence);
    failed.run.conclusion = "failure";
    assert.throws(() => requireReleaseReady(candidate, failed), COMPLETED_AND_SUCCESSFUL_PATTERN);
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
        () => requireReleaseReady(published, evidence),
        (error) => {
          assert.match(error.message, IS_NOT_AN_UNRELEASED_CANDIDATE_PATTERN);
          assert.match(error.message, TAG_THE_COMMIT_THAT_PREPARED_PATTERN);
          return true;
        },
      );
    }
  });

  it("refuses an unqualified Edge release before it checks the candidate status", () => {
    const unqualified = structuredClone(candidate);
    unqualified.edge.release.image = `${PLACEHOLDER_PREFIX}: edge release image`;
    assert.throws(
      () => requireReleaseReady(unqualified, evidence),
      DOES_NOT_NAME_A_QUALIFIED_PATTERN,
    );
  });

  it("refuses a draft pairing even when the verified Edge distribution is pinned", () => {
    for (const qualification of [
      { status: "pending", ci_evidence: null },
      { status: "qualified", ci_evidence: null },
    ]) {
      assert.throws(
        () => requireReleaseReady({ ...candidate, qualification }, evidence),
        HOSTED_QUALIFICATION_IS_STILL_PENDING_PATTERN,
      );
    }
  });

  it("wires the release-ready command to requireReleaseReady, not an inline check", () => {
    // requireReleaseReady is the seam the tests above exercise; this pins that
    // main() actually calls it rather than reverting to an inline edge check.
    assert.match(
      repoFile("scripts/supported-pairing.mjs"),
      COMMAND_RELEASE_READY_CONST_EVIDENCE_PATTERN,
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
    const runs = [...workflow.matchAll(DOCKER_RUN_PATTERN)]
      .map(([block]) => block)
      .filter((block) => FERRUM_MODE_DATABASE_PATTERN.test(block));
    assert.ok(runs.length >= 3, "the contract, read-only parity, and container gateways");
    for (const block of runs) assert.match(block, FERRUM_EDGE_IMAGE_PATTERN);
    assert.match(workflow, NODE_SCRIPTS_SUPPORTED_PAIRING_MJS_PATTERN);
  });

  it("has the release workflow refuse a tag until the Edge release is qualified", () => {
    const workflow = repoFile(".github/workflows/release.yml");
    assert.match(workflow, NODE_SCRIPTS_SUPPORTED_PAIRING_MJS_RELEASE_PATTERN);
    const metadata = workflow.slice(
      workflow.indexOf("  release-metadata:"),
      workflow.indexOf("  quality-gates:"),
    );
    assert.match(metadata, READ_ONLY_PERMISSIONS_PATTERN);
    const pairingStep = metadata.slice(metadata.indexOf("Require the supported pairing"));
    assert.match(pairingStep, GH_TOKEN_SECRETS_GITHUB_TOKEN_PATTERN);
    assert.doesNotMatch(metadata, WRITE_PERMISSION_PATTERN);
  });

  describe("the release workflow never reassigns a release (GHSA-rw8r-hrr2-vpc2)", () => {
    const workflow = repoFile(".github/workflows/release.yml");
    const job = (name) => {
      const start = workflow.indexOf(`\n  ${name}:\n`);
      assert.ok(start >= 0, `release.yml has a ${name} job`);
      const next = workflow.slice(start + 1).search(NEXT_JOB_PATTERN);
      return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
    };
    const metadata = job("release-metadata");
    const build = job("docker");
    const manifest = job("docker-manifest");
    const release = job("create-release");

    it("holds every publishing job behind the protected release environment", () => {
      // Required reviewers gate only jobs that name the environment, so a job
      // that pushes or releases without it would publish unapproved.
      for (const publishing of [build, manifest, release]) {
        assert.match(publishing, RELEASE_ENVIRONMENT_PATTERN);
      }
      assert.doesNotMatch(metadata, RELEASE_ENVIRONMENT_PATTERN);
    });

    it("binds the tag to this run's commit before building, publishing, and releasing", () => {
      assert.match(metadata, TAG_IS_THIS_COMMIT);
      for (const later of [manifest, release]) {
        assert.match(later, GIT_FETCH_NO_TAGS_ORIGIN_PATTERN);
        assert.match(later, TAG_IS_THIS_COMMIT);
      }
      // The manifest job re-checks after waiting for earlier runs, before any login.
      const recheck = manifest.search(TAG_IS_THIS_COMMIT);
      assert.ok(recheck > manifest.indexOf("Wait for earlier release runs"));
      assert.ok(recheck < manifest.indexOf("docker/login-action"));
      assert.ok(release.search(TAG_IS_THIS_COMMIT) < release.indexOf("gh release create"));
    });

    it("refuses an existing GitHub release and foreign registry tags before any build", () => {
      assert.match(metadata, GH_API_REPOS_GITHUB_REPOSITORY_RELEASES_PATTERN);
      assert.match(metadata, GREP_QUIET_HTTP_404_PATTERN);
      assert.match(metadata, RUN_NODE_SCRIPTS_RELEASE_IMAGE_PATTERN);
      assert.match(metadata, IMAGE_REPOSITORIES_FERRUMEDGE_FERRUM_FOUNDRY_PATTERN);
      assert.match(metadata, SOURCE_REVISION_GITHUB_SHA_PATTERN);
      assert.doesNotMatch(metadata, LOGIN_ACTION_SECRETS_DOCKERHUB_PATTERN);
      assert.match(build, NEEDS_PATTERN);
    });

    it("compares both version tags in both registries before writing either registry", () => {
      const identity = manifest.indexOf("Refuse to reassign published release version tags");
      const firstWrite = manifest.search(IMAGETOOLS_CREATE_DRY_RUN_PATTERN);
      assert.ok(identity > 0 && identity < firstWrite, "the comparison precedes every registry write");
      const step = manifest.slice(identity, manifest.indexOf("Create and push multi-arch manifest (Docker Hub)"));
      assert.match(step, IMAGETOOLS_CREATE_DRY_RUN_2_PATTERN);
      assert.match(step, FOR_REPOSITORY_IN_FERRUMEDGE_FERRUM_PATTERN);
      assert.match(step, FOR_TAG_IN_RELEASE_TAG_RELEASE_VERSION_PATTERN);
      assert.match(step, RELEASE_IMAGE_IDENTITY_MJS_COMPARE_PATTERN);
    });

    it("writes a version tag only when absent and only as this run's digest", () => {
      const writes = [...manifest.matchAll(DOCKER_BUILDX_IMAGETOOLS_CREATE_DRY_PATTERN)]
        .map(([, args]) => args.trim());
      assert.deepEqual(writes, [
        '-t "$IMAGE_REPOSITORY:$tag" "$@"',
        '"${channel_tags[@]}" "$IMAGE_REPOSITORY@$RELEASE_DIGEST"',
        '-t "$IMAGE_REPOSITORY:$tag" "$@"',
        '"${channel_tags[@]}" "$IMAGE_REPOSITORY@$RELEASE_DIGEST"',
      ]);
      // Only X.Y and latest are channels; X.Y.Z is a version tag.
      const channels = [...manifest.matchAll(CHANNEL_TAGS_PATTERN)].map(([, tags]) => tags);
      assert.deepEqual(channels.sort(), [
        "",
        "",
        '-t "$IMAGE_REPOSITORY:$RELEASE_MAJOR_MINOR"',
        '-t "$IMAGE_REPOSITORY:$RELEASE_MAJOR_MINOR"',
        '-t "$IMAGE_REPOSITORY:latest"',
        '-t "$IMAGE_REPOSITORY:latest"',
      ].sort());
      assert.equal(manifest.match(ABSENT_TAG_GUARDED_CREATE_PATTERN)?.length, 2);
      assert.equal(manifest.match(UNPUBLISHED_STATE_GUARD_PATTERN)?.length, 2);
      assert.equal(manifest.match(PUBLISH_VERSION_TAG_RELEASE_TAG_IMAGES_PATTERN)?.length, 2);
      assert.equal(
        manifest.match(PUBLISH_VERSION_TAG_RELEASE_VERSION_PATTERN)?.length,
        2,
      );
    });

    it("records the published digest in the GitHub release", () => {
      assert.match(manifest, IDENTITY_DIGEST_OUTPUT_PATTERN);
      assert.match(release, RELEASE_DIGEST_NEEDS_DOCKER_MANIFEST_PATTERN);
      assert.match(release, FERRUMEDGE_FERRUM_FOUNDRY_DIGEST_PATTERN);
    });

    it("persists the first run's planned digests for a later attempt to name", () => {
      // A partial publish must stay diagnosable: the per-platform digests the
      // build pushed are retained at the repository's maximum, and the
      // manifest job records the index digest they produce beside them, so a
      // later attempt can name what an earlier one wrote. See
      // docs/release-security.md -> "A half-published version is stranded".
      assert.match(
        build,
        NAME_RELEASE_DOCKER_DIGEST_MATRIX_PATTERN,
      );
      assert.match(
        manifest,
        NAME_RELEASE_PLANNED_DIGESTS_PATH_PATTERN,
      );
      assert.match(
        manifest,
        ECHO_INDEX_RELEASE_DIGEST_PLATFORM_PATTERN,
      );
    });

    it("records and uploads the plan before the first registry write", () => {
      const record = manifest.indexOf("Record the first run's planned digests");
      const upload = manifest.indexOf("Upload the first run's planned digests");
      const firstWrite = manifest.search(IMAGETOOLS_CREATE_DRY_RUN_PATTERN);
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
      assert.match(notes, FERRUM_EDGE_RELEASE_STEP_PATTERN);
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
