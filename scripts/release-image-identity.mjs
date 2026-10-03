/* ------------------------------------------------------------------ */
/*  Release image identity (GHSA-rw8r-hrr2-vpc2)                       */
/* ------------------------------------------------------------------ */

/**
 * A release version tag (`vX.Y.Z`, `X.Y.Z`) names one image, built from one
 * commit, for good. The release workflow asks each registry what such a tag
 * names before it writes it, and never reassigns one:
 *
 * - `preflight` runs before any build or registry login. A version tag that
 *   already exists in either registry must carry this run's commit as the
 *   `org.opencontainers.image.revision` of every platform image, or the
 *   release stops.
 * - `compare` runs in the manifest job, before each tag is written, with the
 *   digest of the multi-architecture index this run would publish. It prints
 *   `absent` (the tag may be created) or `published` (the tag already names
 *   exactly that digest, so a rerun writes nothing). Any other digest is a
 *   failure.
 *
 * Both registries are read anonymously, as any consumer would pull: a manifest
 * HEAD for existence and digest, and GETs only to read the revision label of a
 * tag that already exists. Anything but a clean answer fails closed.
 *
 *   IMAGE_REPOSITORIES="ferrumedge/ferrum-foundry ghcr.io/ferrum-edge/ferrum-foundry" \
 *   RELEASE_TAG=v1.2.3 RELEASE_VERSION=1.2.3 SOURCE_REVISION=<40 hex> \
 *     node scripts/release-image-identity.mjs preflight
 *   node scripts/release-image-identity.mjs compare <repository> <sha256:digest> <tag>
 */

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export const REVISION_LABEL = "org.opencontainers.image.revision";

const DOCKER_HUB = "registry-1.docker.io";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const REPOSITORY_PATH = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

/** `ferrumedge/ferrum-foundry` or `ghcr.io/owner/name` → registry host and path. */
export function parseRepository(reference) {
  const parts = String(reference).split("/");
  const explicitHost = parts.length > 1 && /[.:]/.test(parts[0]);
  const host = explicitHost ? parts[0] : DOCKER_HUB;
  const rest = explicitHost ? parts.slice(1) : parts;
  if (!explicitHost && rest.length === 1) rest.unshift("library");
  const path = rest.join("/");
  if (!REPOSITORY_PATH.test(path)) throw new Error(`Not an image repository: ${reference}`);
  return { reference: String(reference), host, path };
}

function requireTag(tag) {
  if (!TAG.test(tag ?? "")) throw new Error(`Not an image tag: ${tag}`);
  return tag;
}

function requireDigest(digest, what) {
  if (!DIGEST.test(digest ?? "")) throw new Error(`${what} is not a sha256 digest: ${digest}`);
  return digest;
}

export function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The parameters of a `WWW-Authenticate: Bearer ...` challenge. */
export function parseBearerChallenge(header) {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) throw new Error(`Registry asked for unsupported authentication: ${header ?? "none"}`);
  const params = {};
  for (const [, key, value] of match[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)) {
    params[key.toLowerCase()] = value;
  }
  if (!params.realm || new URL(params.realm).protocol !== "https:") {
    throw new Error("Registry token realm must be an https URL");
  }
  return params;
}

/** An anonymous, pull-only reader of one image repository. */
export function registryClient(repository, fetchImpl = globalThis.fetch) {
  const { reference, host, path } = parseRepository(repository);
  let token;

  async function authenticate(challenge) {
    const { realm, service, scope } = parseBearerChallenge(challenge);
    const url = new URL(realm);
    if (service) url.searchParams.set("service", service);
    url.searchParams.set("scope", scope || `repository:${path}:pull`);
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`${reference}: anonymous token request failed (${response.status})`);
    }
    const body = await response.json();
    const issued = body?.token ?? body?.access_token;
    if (typeof issued !== "string" || issued.length === 0) {
      throw new Error(`${reference}: the registry issued no token`);
    }
    return issued;
  }

  async function request(method, resource, accept) {
    const url = `https://${host}/v2/${path}/${resource}`;
    const send = () =>
      fetchImpl(url, {
        method,
        redirect: "follow",
        headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
    let response = await send();
    if (response.status === 401 && token === undefined) {
      token = await authenticate(response.headers.get("www-authenticate"));
      response = await send();
    }
    return response;
  }

  /** The digest a tag names now, or null when the registry has no such tag. */
  async function tagDigest(tag) {
    requireTag(tag);
    const response = await request("HEAD", `manifests/${tag}`, MANIFEST_ACCEPT);
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(
        `${reference}:${tag}: registry answered ${response.status}; cannot tell whether it exists`,
      );
    }
    return requireDigest(response.headers.get("docker-content-digest"), `${reference}:${tag}`);
  }

  async function getVerified(kind, ref, accept, expectedDigest) {
    const response = await request("GET", `${kind}/${ref}`, accept);
    if (response.status !== 200) {
      throw new Error(`${reference}: GET ${kind}/${ref} answered ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = sha256Digest(bytes);
    if (expectedDigest && digest !== expectedDigest) {
      throw new Error(`${reference}: ${kind}/${ref} content does not match ${expectedDigest}`);
    }
    return { digest, json: JSON.parse(bytes.toString("utf8")) };
  }

  /** The revision label of every platform image a tag names. */
  async function revisions(tag, digest) {
    const top = await getVerified("manifests", requireTag(tag), MANIFEST_ACCEPT, digest);
    const images = Array.isArray(top.json.manifests)
      ? top.json.manifests
          .filter((entry) => !isAttestation(entry))
          .map((entry) => ({
            digest: requireDigest(entry.digest, "platform manifest"),
            platform: platformOf(entry),
          }))
      : [{ digest: top.digest, platform: "single" }];
    if (images.length === 0) {
      throw new Error(`${reference}:${tag} names an index with no platform images`);
    }
    const found = [];
    for (const image of images) {
      const manifest = image.digest === top.digest
        ? top
        : await getVerified("manifests", image.digest, MANIFEST_ACCEPT, image.digest);
      const configDigest = requireDigest(
        manifest.json?.config?.digest,
        `${reference}:${tag} config`,
      );
      const config = await getVerified("blobs", configDigest, "*/*", configDigest);
      const revision = config.json?.config?.Labels?.[REVISION_LABEL] ?? null;
      found.push({ platform: image.platform, revision });
    }
    return found;
  }

  return { reference, tagDigest, revisions };
}

function isAttestation(entry) {
  const platform = entry?.platform ?? {};
  return entry?.annotations?.["vnd.docker.reference.type"] === "attestation-manifest"
    || (platform.os === "unknown" && platform.architecture === "unknown");
}

function platformOf(entry) {
  const platform = entry?.platform ?? {};
  return [platform.os ?? "missing", platform.architecture ?? "missing", platform.variant]
    .filter(Boolean)
    .join("/");
}

/**
 * `absent` when the tag does not exist, `published` when it already names
 * `expected`. Any other digest throws: a release version tag is never moved.
 */
export async function compareTag(client, tag, expected) {
  requireDigest(expected, "expected release digest");
  const current = await client.tagDigest(tag);
  if (current === null) return "absent";
  if (current === expected) return "published";
  throw new Error(
    `${client.reference}:${tag} already names ${current}, not this run's ${expected}. `
      + "A release version tag is never reassigned; publish a new version instead.",
  );
}

/**
 * Refuse a release whose version tags already exist in any registry with a
 * different source revision than this run's commit. Returns one line per tag.
 */
export async function preflight({ repositories, tags, revision, fetchImpl = globalThis.fetch }) {
  if (!COMMIT.test(revision ?? "")) {
    throw new Error(`SOURCE_REVISION is not a full commit SHA: ${revision}`);
  }
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw new Error("No image repositories to check");
  }
  if (!Array.isArray(tags) || tags.length === 0) throw new Error("No release tags to check");
  const report = [];
  const refused = [];
  for (const repository of repositories) {
    const client = registryClient(repository, fetchImpl);
    for (const tag of tags) {
      const digest = await client.tagDigest(tag);
      if (digest === null) {
        report.push(`${client.reference}:${tag} does not exist yet`);
        continue;
      }
      const images = await client.revisions(tag, digest);
      const foreign = images.filter((image) => image.revision !== revision);
      if (foreign.length > 0) {
        const from = foreign.map(
          (image) => `${image.platform} from ${image.revision ?? "an unlabelled build"}`,
        );
        refused.push(
          `${client.reference}:${tag} is already published as ${digest} (${from.join(", ")})`,
        );
      } else {
        report.push(
          `${client.reference}:${tag} is already published as ${digest} from this commit; `
            + "the manifest job writes nothing unless this run's digest is identical",
        );
      }
    }
  }
  if (refused.length > 0) {
    throw new Error([
      `Release version tags already name images built from another commit than ${revision}:`,
      ...refused.map((line) => `  ${line}`),
      "A release version tag is never reassigned; publish a new version instead.",
    ].join("\n"));
  }
  return report;
}

async function main([command, ...args]) {
  if (command === "preflight") {
    const repositories = (process.env.IMAGE_REPOSITORIES ?? "").split(/\s+/).filter(Boolean);
    const tags = [process.env.RELEASE_TAG, process.env.RELEASE_VERSION].map(requireTag);
    const report = await preflight({ repositories, tags, revision: process.env.SOURCE_REVISION });
    for (const line of report) console.log(line);
    return;
  }
  if (command === "compare" && args.length === 3) {
    const [repository, expected, tag] = args;
    console.log(await compareTag(registryClient(repository), tag, expected));
    return;
  }
  throw new Error(
    "usage: release-image-identity.mjs preflight | compare <repository> <sha256:digest> <tag>",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
