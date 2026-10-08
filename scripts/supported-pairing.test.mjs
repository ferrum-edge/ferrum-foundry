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

  it("pins the verified v0.9.14 distribution for hosted qualification", () => {
    const image =
      "ferrumedge/ferrum-edge@sha256:15442f1b1d1758023fe871fe57be50f19caf34bbe6c499a6812f4ffd0da5e3f8";
    const sourceCommit = "9bd4d5f9caa4ebe8f0ea13e76d8a6e2172eaca7d";
    const manifests = {
      "linux/amd64": "sha256:12a8cd56090c0d4511bb3015b240e606b1b87989c644157566b8f6b6f635b3c2",
      "linux/arm64": "sha256:19d2886ed8c192cb0daba48ef0a27a0cd0526449dac74bf9438502322aabd9f2",
    };
    assert.equal(record.edge.image, image);
    assert.equal(record.edge.source_commit, sourceCommit);
    assert.deepEqual(record.edge.platform_manifests, manifests);
    assert.match(record.edge.build, /v0\.9\.14/);

    const release = record.edge.release;
    assert.equal(release.version, "v0.9.14");
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
        "sha256:29f156bb0d77933ba6820d39350ddfaea907eb117ee007a44b1a49c2fd8c4d70",
      "ferrum-cni-linux-x86_64":
        "sha256:d8270da265779da67083b289e0ef7f1287f7f8ee2d4d58654dcc234e142d54a2",
      "ferrum-edge-linux-aarch64":
        "sha256:f23ba7c9fff1d1d924f3047f48e4669d080e1b6acc8214361185af661901c3e9",
      "ferrum-edge-linux-x86_64":
        "sha256:d0e89b11dbc29f29e6ea8cab4355b7c551638d370fb4c6a52a0ba7444fc6c020",
      "ferrum-edge-macos-aarch64":
        "sha256:e195aa0b74fba6b2f9b9c8e2bf92c0b351c874617499c5b638305c61ea624411",
      "ferrum-edge-macos-x86_64":
        "sha256:e0db84859e9ec6d294ba21ded9cb767ac1994c8a42d35e636c1d90c3c160adcc",
      "ferrum-edge-windows-x86_64.exe":
        "sha256:b22e5cc4b18973aa834166acdfb825690cc829260753db6867449c420d942e6b",
    });
    assert.deepEqual(release.openapi, {
      info_version: "0.2.0",
      sha256: "6d286649ae744691e2eeb7d16607c538ca02e31bdeaafe98ab07fc861e7b9da4",
    });
    assert.equal(
      release.github_release,
      "https://github.com/ferrum-edge/ferrum-edge/releases/tag/v0.9.14",
    );
    assert.equal(release.distribution.ci_evidence, record.edge.source_evidence);
    assert.equal(release.distribution.status, "VERIFIED_DISTRIBUTION");
    assert.equal(release.distribution.default_image_binaries_match_release_assets, true);
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
    assert.match(semantics, /5db1d77a8/);
    assert.match(semantics, /#409/);
  });

  it("records the Foundry candidate preparation against the verified Edge distribution", () => {
    assert.equal(record.foundry.version, "0.5.3");
    assert.equal(record.foundry.previous_release, "v0.5.2");
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
    ]) {
      const bytes = repoFile(`docs/release-notes/v${version}.compatibility.json`);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
    }
    const previous = JSON.parse(repoFile("docs/release-notes/v0.5.2.compatibility.json"));
    assert.equal(previous.status, "released");
    assert.equal(previous.foundry.version, "0.5.2");
    assert.equal(previous.foundry.source_commit, "ebd09e8d82f773b6840b1edda67fbac287c3f7a0");
    assert.equal(
      previous.foundry.image,
      "ferrumedge/ferrum-foundry@sha256:b1728fdc0694a195e2a21e7666ca09dd0cf9205c81041cc963b0e104750ce79a",
    );
    assert.equal(previous.edge.release.version, "v0.9.13");
    assert.notEqual(previous.edge.image, record.edge.image);
    assert.notDeepEqual(record.qualification, previous.qualification);
    if (record.qualification.status === "qualified") {
      for (const field of ["ci_evidence", "source_commit", "tested_commit"]) {
        assert.notEqual(record.qualification[field], previous.qualification[field]);
      }
    }
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
    assert.throws(() => requireReleaseReady(pending), /hosted qualification is still pending/);
    const reused = structuredClone(qualifiedFixture.record);
    reused.qualification = structuredClone(previous.qualification);
    assert.throws(() => requireReleaseReady(reused, qualifiedFixture.evidence), /run does not match/);
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
  // by an evidence record. The live record remains pending and cannot release.
  const { record: candidate, evidence } = qualifiedFixture;

  it("passes the unreleased candidate the release workflow tags", () => {
    assert.deepEqual(requireReleaseReady(candidate, evidence), {
      ready: true,
      edge: candidate.edge.release.version,
      image: candidate.edge.image,
    });
  });

  it("refuses a URL without verified hosted evidence", () => {
    assert.throws(() => requireReleaseReady(candidate), /run does not match/);
    const failed = structuredClone(evidence);
    failed.run.conclusion = "failure";
    assert.throws(() => requireReleaseReady(candidate, failed), /completed and successful/);
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
      () => requireReleaseReady(unqualified, evidence),
      /does not name a qualified Ferrum Edge release/,
    );
  });

  it("refuses a draft pairing even when the verified Edge distribution is pinned", () => {
    for (const qualification of [
      { status: "pending", ci_evidence: null },
      { status: "qualified", ci_evidence: null },
    ]) {
      assert.throws(
        () => requireReleaseReady({ ...candidate, qualification }, evidence),
        /hosted qualification is still pending/,
      );
    }
  });

  it("wires the release-ready command to requireReleaseReady, not an inline check", () => {
    // requireReleaseReady is the seam the tests above exercise; this pins that
    // main() actually calls it rather than reverting to an inline edge check.
    assert.match(
      repoFile("scripts/supported-pairing.mjs"),
      /command === "release-ready"\) \{\n\s+const evidence = await readHostedQualification\(record\);\n\s+console\.log\(JSON\.stringify\(requireReleaseReady\(record, evidence\)\)\)/,
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
    const metadata = workflow.slice(
      workflow.indexOf("  release-metadata:"),
      workflow.indexOf("  quality-gates:"),
    );
    assert.match(metadata, /permissions:\n\s+actions: read\n\s+contents: read\n/);
    const pairingStep = metadata.slice(metadata.indexOf("Require the supported pairing"));
    assert.match(pairingStep, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.doesNotMatch(metadata, /actions: write|contents: write/);
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
