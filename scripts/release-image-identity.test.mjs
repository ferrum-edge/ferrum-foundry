import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MANIFEST_ACCEPT,
  REVISION_LABEL,
  compareTag,
  parseBearerChallenge,
  parseRepository,
  preflight,
  registryClient,
  sha256Digest,
} from "./release-image-identity.mjs";

const THIS_COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const REALM = "https://auth.registry.test/token";

function bytes(value) {
  return Buffer.from(JSON.stringify(value));
}

/** A two-platform release index with attestations, as the release workflow publishes. */
function releaseImage(revisions) {
  const objects = new Map();
  const put = (content) => {
    const digest = sha256Digest(content);
    objects.set(digest, content);
    return digest;
  };
  const entries = Object.entries(revisions).map(([architecture, revision]) => {
    const labels = revision === null ? {} : { [REVISION_LABEL]: revision };
    const config = put(bytes({ os: "linux", architecture, config: { Labels: labels } }));
    const manifest = put(bytes({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: config },
      layers: [],
    }));
    return { digest: manifest, platform: { os: "linux", architecture } };
  });
  const attestation = put(bytes({ schemaVersion: 2, config: { digest: `sha256:${"0".repeat(64)}` } }));
  const index = put(bytes({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      ...entries,
      {
        digest: attestation,
        platform: { os: "unknown", architecture: "unknown" },
        annotations: {
          "vnd.docker.reference.digest": entries[0].digest,
          "vnd.docker.reference.type": "attestation-manifest",
        },
      },
    ],
  }));
  return { index, objects };
}

/**
 * A registry that demands an anonymous bearer token, serves `tags`, and
 * records every request. `status` forces an answer for a manifest path.
 */
function fakeRegistry({ host, path, tags = {}, objects = new Map(), status = {} }) {
  const calls = [];
  const issued = "anonymous-pull-token";
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    calls.push({ method, url: url.href, headers });
    if (url.href.startsWith(REALM)) {
      return new Response(JSON.stringify({ token: issued }), { status: 200 });
    }
    assert.equal(url.host, host);
    const prefix = `/v2/${path}/`;
    assert.ok(url.pathname.startsWith(prefix), url.pathname);
    if (headers.Authorization !== `Bearer ${issued}`) {
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate":
            `Bearer realm="${REALM}",service="registry.test",scope="repository:${path}:pull"`,
        },
      });
    }
    const [kind, ref] = url.pathname.slice(prefix.length).split("/");
    if (status[ref]) return new Response(null, { status: status[ref] });
    const digest = kind === "manifests" && tags[ref] ? tags[ref] : ref;
    const content = objects.get(digest);
    if (!content || (kind === "manifests" && !tags[ref] && !ref.startsWith("sha256:"))) {
      return new Response(null, { status: 404 });
    }
    return new Response(method === "HEAD" ? null : content, {
      status: 200,
      headers: kind === "manifests" ? { "docker-content-digest": digest } : {},
    });
  };
  return { fetchImpl, calls };
}

describe("parseRepository", () => {
  it("resolves Docker Hub and GHCR repositories", () => {
    assert.deepEqual(parseRepository("ferrumedge/ferrum-foundry"), {
      reference: "ferrumedge/ferrum-foundry",
      host: "registry-1.docker.io",
      path: "ferrumedge/ferrum-foundry",
    });
    assert.deepEqual(parseRepository("ghcr.io/ferrum-edge/ferrum-foundry"), {
      reference: "ghcr.io/ferrum-edge/ferrum-foundry",
      host: "ghcr.io",
      path: "ferrum-edge/ferrum-foundry",
    });
  });

  it("refuses a reference that is not a repository", () => {
    assert.throws(() => parseRepository("ferrumedge/Ferrum Foundry"), /Not an image repository/);
    assert.throws(() => parseRepository("ghcr.io/../x"), /Not an image repository/);
  });
});

describe("parseBearerChallenge", () => {
  it("reads the realm, service, and scope", () => {
    assert.deepEqual(
      parseBearerChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"'),
      { realm: "https://ghcr.io/token", service: "ghcr.io", scope: "repository:a/b:pull" },
    );
  });

  it("refuses a non-bearer challenge and a plaintext realm", () => {
    assert.throws(() => parseBearerChallenge('Basic realm="x"'), /unsupported authentication/);
    assert.throws(() => parseBearerChallenge(undefined), /unsupported authentication/);
    assert.throws(() => parseBearerChallenge('Bearer realm="http://auth.test/token"'), /https/);
  });
});

describe("compareTag", () => {
  const repository = "ghcr.io/ferrum-edge/ferrum-foundry";
  const target = { host: "ghcr.io", path: "ferrum-edge/ferrum-foundry" };

  it("reports a tag that does not exist yet as absent", async () => {
    const registry = fakeRegistry(target);
    const client = registryClient(repository, registry.fetchImpl);
    assert.equal(await compareTag(client, "v1.2.3", `sha256:${"1".repeat(64)}`), "absent");
  });

  it("treats a tag that already names this run's digest as published, writing nothing", async () => {
    const { index, objects } = releaseImage({ amd64: THIS_COMMIT, arm64: THIS_COMMIT });
    const registry = fakeRegistry({ ...target, tags: { "v1.2.3": index }, objects });
    const client = registryClient(repository, registry.fetchImpl);
    assert.equal(await compareTag(client, "v1.2.3", index), "published");
    assert.ok(registry.calls.every((call) => ["GET", "HEAD"].includes(call.method)));
    // Existence and digest come from a HEAD, which Docker Hub does not count as a pull.
    assert.ok(registry.calls.filter((call) => call.url.includes("/manifests/")).every((call) => call.method === "HEAD"));
  });

  it("refuses a tag that names any other digest", async () => {
    const { index, objects } = releaseImage({ amd64: THIS_COMMIT, arm64: THIS_COMMIT });
    const registry = fakeRegistry({ ...target, tags: { "1.2.3": index }, objects });
    const client = registryClient(repository, registry.fetchImpl);
    await assert.rejects(
      compareTag(client, "1.2.3", `sha256:${"1".repeat(64)}`),
      /already names sha256:[0-9a-f]{64}, not this run's .*never reassigned/,
    );
  });

  it("fails closed when the registry cannot answer", async () => {
    const registry = fakeRegistry({ ...target, status: { "v1.2.3": 500 } });
    const client = registryClient(repository, registry.fetchImpl);
    await assert.rejects(compareTag(client, "v1.2.3", `sha256:${"1".repeat(64)}`), /answered 500/);

    const denied = fakeRegistry({ ...target, status: { "v1.2.3": 403 } });
    await assert.rejects(
      compareTag(registryClient(repository, denied.fetchImpl), "v1.2.3", `sha256:${"1".repeat(64)}`),
      /answered 403/,
    );
  });

  it("refuses a malformed expected digest or tag before asking the registry", async () => {
    const registry = fakeRegistry(target);
    const client = registryClient(repository, registry.fetchImpl);
    await assert.rejects(compareTag(client, "v1.2.3", "latest"), /not a sha256 digest/);
    await assert.rejects(compareTag(client, "../v1", `sha256:${"1".repeat(64)}`), /Not an image tag/);
    assert.equal(registry.calls.length, 0);
  });

  it("fetches an anonymous pull token for the repository on the registry's challenge", async () => {
    const registry = fakeRegistry(target);
    const client = registryClient(repository, registry.fetchImpl);
    await compareTag(client, "v1.2.3", `sha256:${"1".repeat(64)}`);
    const [first, token, retry] = registry.calls;
    assert.equal(first.headers.Authorization, undefined);
    assert.equal(first.headers.Accept, MANIFEST_ACCEPT);
    const tokenUrl = new URL(token.url);
    assert.equal(tokenUrl.searchParams.get("service"), "registry.test");
    assert.equal(tokenUrl.searchParams.get("scope"), "repository:ferrum-edge/ferrum-foundry:pull");
    assert.equal(retry.headers.Authorization, "Bearer anonymous-pull-token");
  });
});

describe("preflight", () => {
  const repositories = ["ferrumedge/ferrum-foundry"];
  const target = { host: "registry-1.docker.io", path: "ferrumedge/ferrum-foundry" };
  const tags = ["v1.2.3", "1.2.3"];

  it("passes a release whose version tags do not exist yet", async () => {
    const registry = fakeRegistry(target);
    const report = await preflight({ repositories, tags, revision: THIS_COMMIT, fetchImpl: registry.fetchImpl });
    assert.deepEqual(report, [
      "ferrumedge/ferrum-foundry:v1.2.3 does not exist yet",
      "ferrumedge/ferrum-foundry:1.2.3 does not exist yet",
    ]);
  });

  it("lets a rerun of the same commit through to the digest comparison", async () => {
    const { index, objects } = releaseImage({ amd64: THIS_COMMIT, arm64: THIS_COMMIT });
    const registry = fakeRegistry({ ...target, tags: { "v1.2.3": index, "1.2.3": index }, objects });
    const report = await preflight({ repositories, tags, revision: THIS_COMMIT, fetchImpl: registry.fetchImpl });
    assert.equal(report.length, 2);
    for (const line of report) assert.match(line, /from this commit/);
  });

  it("refuses version tags already published from another commit", async () => {
    const { index, objects } = releaseImage({ amd64: OTHER_COMMIT, arm64: OTHER_COMMIT });
    const registry = fakeRegistry({ ...target, tags: { "1.2.3": index }, objects });
    await assert.rejects(
      preflight({ repositories, tags, revision: THIS_COMMIT, fetchImpl: registry.fetchImpl }),
      (error) => {
        assert.match(error.message, /ferrumedge\/ferrum-foundry:1\.2\.3 is already published/);
        assert.match(error.message, new RegExp(`linux/amd64 from ${OTHER_COMMIT}`));
        assert.match(error.message, /never reassigned/);
        assert.doesNotMatch(error.message, /:v1\.2\.3 is already/);
        return true;
      },
    );
  });

  it("refuses when any one platform image comes from another commit or carries no revision", async () => {
    for (const arm64 of [OTHER_COMMIT, null]) {
      const { index, objects } = releaseImage({ amd64: THIS_COMMIT, arm64 });
      const registry = fakeRegistry({ ...target, tags: { "v1.2.3": index }, objects });
      await assert.rejects(
        preflight({ repositories, tags, revision: THIS_COMMIT, fetchImpl: registry.fetchImpl }),
        new RegExp(`linux/arm64 from ${arm64 ?? "an unlabelled build"}`),
      );
    }
  });

  it("ignores attestation manifests when reading revisions", async () => {
    const { index, objects } = releaseImage({ amd64: THIS_COMMIT, arm64: THIS_COMMIT });
    const registry = fakeRegistry({ ...target, tags: { "v1.2.3": index }, objects });
    await preflight({ repositories, tags, revision: THIS_COMMIT, fetchImpl: registry.fetchImpl });
    const index_ = JSON.parse(objects.get(index).toString("utf8"));
    const attestation = index_.manifests.at(-1).digest;
    assert.ok(!registry.calls.some((call) => call.url.endsWith(`/manifests/${attestation}`)));
  });

  it("refuses content that does not match its digest", async () => {
    const { index, objects } = releaseImage({ amd64: THIS_COMMIT, arm64: THIS_COMMIT });
    const manifest = JSON.parse(objects.get(index).toString("utf8")).manifests[0].digest;
    const config = JSON.parse(objects.get(manifest).toString("utf8")).config.digest;
    objects.set(config, bytes({ config: { Labels: { [REVISION_LABEL]: THIS_COMMIT } }, forged: true }));
    const registry = fakeRegistry({ ...target, tags: { "v1.2.3": index }, objects });
    await assert.rejects(
      preflight({ repositories, tags, revision: THIS_COMMIT, fetchImpl: registry.fetchImpl }),
      /content does not match/,
    );
  });

  it("requires a full source commit, repositories, and tags", async () => {
    const registry = fakeRegistry(target);
    const fetchImpl = registry.fetchImpl;
    await assert.rejects(preflight({ repositories, tags, revision: "abc123", fetchImpl }), /full commit SHA/);
    await assert.rejects(preflight({ repositories: [], tags, revision: THIS_COMMIT, fetchImpl }), /repositories/);
    await assert.rejects(preflight({ repositories, tags: [], revision: THIS_COMMIT, fetchImpl }), /release tags/);
  });
});
