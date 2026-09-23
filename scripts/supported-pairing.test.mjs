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
  edgeReleaseErrors,
  findPairingDrift,
  isPlaceholder,
  missingRequiredReferences,
  readSupportedPairing,
  validatePairing,
} from "./supported-pairing.mjs";

const record = readSupportedPairing();

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

  it("records v0.9.5 as evaluated and rejected, with the CI run that showed it", () => {
    const rejected = record.edge.rejected_images.find((entry) => entry.version === "v0.9.5");
    assert.ok(rejected, "v0.9.5 must stay recorded as rejected");
    assert.equal(
      rejected.image,
      "ferrumedge/ferrum-edge@sha256:eca46c84bca92d6ef467979f8846537f7ab56c0cdc137befff465526a10fe10f",
    );
    assert.match(rejected.evidence, /^https:\/\/github\.com\/ferrum-edge\/ferrum-foundry\/actions\/runs\/\d+$/);
    assert.match(rejected.finding, /Deployment Starter/);
    assert.notEqual(record.edge.release.version, "v0.9.5");
  });

  it("names its previous release and never claims a Foundry artifact it cannot know yet", () => {
    assert.equal(record.foundry.previous_release, "v0.1.0");
    if (record.status === "candidate") {
      // The commit, digest, and CI run of a release exist only once it is cut.
      for (const field of ["source_commit", "image", "ci_evidence"]) {
        assert.ok(isPlaceholder(record.foundry[field]), `foundry.${field} before release`);
      }
    }
    assert.deepEqual(record.foundry.platforms, ["linux/amd64", "linux/arm64"]);
  });

  it("keeps the unreleased If-Match dependency explicit while Edge has not shipped it", () => {
    const dependency = record.edge_dependencies.find((entry) => entry.change === "ferrum-edge#5661");
    assert.ok(dependency, "ferrum-edge#5661 must stay listed until a pinned release includes it");
    assert.match(dependency.status, /not in v0\.9\.5, any published image, or edge\.image/);
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

    const repinned = structuredClone(valid);
    repinned.edge.image = repinned.edge.rejected_images[0].image;
    assert.ok(validatePairing(repinned).includes("edge.image is listed as rejected"));

    const repaired = structuredClone(valid);
    repaired.edge.release.version = repaired.edge.rejected_images[0].version;
    assert.ok(validatePairing(repaired).some((error) => error.includes("evaluated and rejected")));

    const guessed = structuredClone(valid);
    guessed.edge.release.image = "ferrumedge/ferrum-edge:latest";
    assert.ok(validatePairing(guessed).some((error) => error.startsWith("edge.release.image")));
  });

  it("is release-ready only when edge.image is the recorded Edge release", () => {
    const recorded = structuredClone(valid);
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

  it("allows placeholders only until the record is marked released", () => {
    const released = structuredClone(valid);
    released.status = "released";
    released.foundry.version = `${PLACEHOLDER_PREFIX}: version`;
    assert.ok(validatePairing(released).some((error) => error.includes("foundry.version is still")));

    const filled = structuredClone(released);
    Object.assign(filled.foundry, {
      version: "0.2.0",
      source_commit: "a".repeat(40),
      image: `ferrumedge/ferrum-foundry@sha256:${"b".repeat(64)}`,
      ci_evidence: "https://github.com/ferrum-edge/ferrum-foundry/actions/runs/123",
    });
    // A released record also needs the Edge release it was qualified against.
    assert.ok(validatePairing(filled).some((error) => error.startsWith("edge.release.image")));
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

  it("drafts the next release notes against the same pairing", () => {
    // Between releases the draft is UNRELEASED.md; the release step renames it
    // to the version's own notes, which the release workflow publishes.
    const path = existsSync(join(REPO_ROOT, UNRELEASED_NOTES))
      ? UNRELEASED_NOTES
      : `docs/release-notes/v${record.foundry.version}.md`;
    const notes = repoFile(path);
    const release = record.edge.release;
    if (isPlaceholder(release.image)) {
      // The notes must not present the interim development build as the pairing.
      assert.ok(!notes.includes(record.edge.image), "the draft must not pair with edge.image");
      assert.match(notes, /\| Ferrum Edge \| \*release step\*/);
    } else {
      assert.ok(notes.includes(release.image));
      assert.ok(notes.includes(`Ferrum Edge ${release.version}`));
    }
    for (const rejected of record.edge.rejected_images ?? []) {
      assert.ok(notes.includes(rejected.evidence), `release notes must cite ${rejected.version}'s run`);
    }
    for (const dependency of record.edge_dependencies ?? []) {
      assert.ok(notes.includes(dependency.change), `release notes must state ${dependency.change}`);
    }
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
    const rejected = record.edge.rejected_images[0].image;
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
      const found = findPairingDrift(record, root)
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
