/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Upstream API functions                           */
/* ------------------------------------------------------------------ */

import { proxyApi, scoped, SILENT_ERRORS, type NamespaceScope } from "./client";
import type {
  PaginatedResponse,
  PaginationParams,
  Upstream,
  UpstreamCreate,
} from "./types";
import { collectAllPages } from "./pagination";
import {
  conditionalPut,
  guardedReplace,
  readTagged,
  type WriteGuard,
} from "./conditionalWrite";
import {
  baselineSnapshot,
  pickSnapshot,
  UPSTREAM_BASELINE_OMIT,
  type BaselineSnapshot,
} from "@/lib/resourceBaseline";

const upstreamWrites = new Map<string, Promise<void>>();

async function serializeWrite<T>(scope: NamespaceScope, id: string, write: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([scope.namespace, id]);
  const result = (upstreamWrites.get(key) ?? Promise.resolve()).then(write);
  const tail = result.then(() => undefined, () => undefined);
  upstreamWrites.set(key, tail);
  try {
    return await result;
  } finally {
    if (upstreamWrites.get(key) === tail) upstreamWrites.delete(key);
  }
}

function withUpstreamId(data: UpstreamCreate, id?: string): UpstreamCreate {
  const resolvedId = id ?? data.id;
  return resolvedId ? { ...data, id: resolvedId } : data;
}

export async function list(
  scope: NamespaceScope,
  params: PaginationParams = {},
  signal?: AbortSignal,
): Promise<PaginatedResponse<Upstream>> {
  const searchParams: Record<string, string> = {};
  if (params.offset !== undefined) searchParams.offset = String(params.offset);
  if (params.limit !== undefined) searchParams.limit = String(params.limit);

  return proxyApi
    .get("upstreams", scoped(scope, { searchParams, signal }))
    .json<PaginatedResponse<Upstream>>();
}

/** Every page is fetched under `scope`, however long the collection takes. */
export async function listAll(
  scope: NamespaceScope,
  signal?: AbortSignal,
): Promise<Upstream[]> {
  return collectAllPages(
    (offset, limit, pageSignal) => list(scope, { offset, limit }, pageSignal),
    undefined,
    signal,
  );
}

export async function get(scope: NamespaceScope, id: string): Promise<Upstream> {
  return (await readTagged<Upstream>(scope, `upstreams/${id}`)).value;
}

/**
 * Resolve one upstream that another resource references.
 *
 * A dangling `upstream_id` on a list row is a fact about that row, not a fault
 * to report in the global error dialog, so this read opts out of the popup and
 * the caller renders the reference as unresolved. Kept separate from `get` so
 * the detail page's own read keeps reporting its failures.
 */
export async function getReference(
  scope: NamespaceScope,
  id: string,
  signal?: AbortSignal,
): Promise<Upstream> {
  return proxyApi
    .get(
      `upstreams/${id}`,
      scoped(scope, { signal, context: { [SILENT_ERRORS]: true } }),
    )
    .json<Upstream>();
}

/** Strip server- and mesh-owned fields from a fetched full-replace resource. */
export function toUpdatePayload(upstream: Upstream): UpstreamCreate {
  const {
    created_at,
    updated_at,
    namespace,
    api_spec_id,
    port_overrides,
    source_locality,
    source_labels,
    locality_lb_setting,
    locality_lb_strict,
    ...rest
  } = upstream;
  void created_at;
  void updated_at;
  void namespace;
  void api_spec_id;
  void port_overrides;
  void source_locality;
  void source_labels;
  void locality_lb_setting;
  void locality_lb_strict;
  return rest;
}

/**
 * Merge a complete form-owned change set over every other writable field.
 * Nested form sections intentionally replace their whole canonical object so
 * explicit clears cannot be confused with preservation.
 */
export function mergeFormUpdatePayload(
  upstream: Upstream,
  changes: UpstreamCreate,
): UpstreamCreate {
  const base = toUpdatePayload(upstream);
  const merged: UpstreamCreate = {
    ...base,
    ...changes,
    targets: changes.targets,
  };

  const clearWhenAbsent: Array<keyof UpstreamCreate> = [
    "name",
    "hash_on",
    "hash_on_cookie_config",
    "health_checks",
    "service_discovery",
    "subsets",
    "backend_tls_client_cert_path",
    "backend_tls_client_key_path",
    "backend_tls_server_ca_cert_path",
    "backend_tls_sni",
  ];
  for (const field of clearWhenAbsent) {
    if (!(field in changes)) {
      (merged as Record<string, unknown>)[field] = null;
    }
  }
  if (!("backend_tls_san_allow_list" in changes)) {
    merged.backend_tls_san_allow_list = [];
  }

  return merged;
}

export async function create(
  scope: NamespaceScope,
  data: UpstreamCreate,
): Promise<Upstream> {
  return proxyApi
    .post("upstreams", scoped(scope, { json: withUpstreamId(data) }))
    .json<Upstream>();
}

/** Reduce an upstream, or an upstream payload, to the content a save replaces. */
export function toBaseline(
  upstream: Upstream | UpstreamCreate,
): BaselineSnapshot {
  return baselineSnapshot(upstream, UPSTREAM_BASELINE_OMIT);
}

/** Guard for the whole-resource settings form. */
export function upstreamWriteGuard(
  seed: Upstream,
): WriteGuard<Upstream | UpstreamCreate> {
  return { baseline: toBaseline(seed), select: toBaseline };
}

/**
 * Guard for the targets editor, which replaces only `targets`.
 *
 * Scoping the comparison to that one field is deliberate: `updateTargets`
 * composes with a settings save from this same client by design (#235/#254),
 * and comparing the whole upstream would turn that supported composition into
 * a conflict. A concurrent *target* change is still caught, which is the only
 * thing this write can lose.
 */
export function targetsWriteGuard(
  seed: Upstream,
): WriteGuard<Upstream | UpstreamCreate> {
  const select = (value: Upstream | UpstreamCreate) =>
    pickSnapshot(value, ["targets"]);
  return { baseline: select(seed), select };
}

/** A guard that compares nothing, for a write that owns only what it sends. */
const UNCOMPARED: WriteGuard<Upstream | UpstreamCreate> = {
  baseline: {},
  select: () => ({}),
};

/**
 * Full-replacement update of the upstream settings.
 *
 * `guard` carries the content the editor opened against; pass `null` only for
 * a write that cannot lose a concurrent change. A guarded save is sent with
 * `If-Match` from the read it verified. See `docs/concurrent-edits.md`.
 */
export async function update(
  scope: NamespaceScope,
  id: string,
  data: UpstreamCreate,
  guard: WriteGuard<Upstream | UpstreamCreate> | null,
): Promise<Upstream> {
  const payload = withUpstreamId(data, id);
  const path = `upstreams/${id}`;
  if (!guard) {
    return serializeWrite(scope, id, () => conditionalPut<Upstream>(scope, path, payload, null));
  }

  return serializeWrite(scope, id, () =>
    guardedReplace<Upstream, UpstreamCreate>({
      resource: "upstream",
      id,
      namespace: scope.namespace,
      guard,
      read: () => readTagged<Upstream>(scope, path),
      propose: () => payload,
      write: (body, ifMatch) => conditionalPut<Upstream>(scope, path, body, ifMatch),
    }),
  );
}

/**
 * Targets own only the target list; all settings come from a current read.
 *
 * The same read that supplies those settings is what the guard compares and
 * what `If-Match` is taken from, so a guarded target write costs no extra
 * request, and a settings change committed after that read makes the gateway
 * refuse the write rather than revert it. The guard then re-reads, finds the
 * targets unchanged, and re-sends with the new settings. `guard` must be built
 * from the list the operator actually edited (`targetsWriteGuard(upstream)` on
 * the render whose targets produced this array), not from a later refetch.
 */
export async function updateTargets(
  scope: NamespaceScope,
  id: string,
  targets: UpstreamCreate["targets"],
  guard: WriteGuard<Upstream | UpstreamCreate> | null,
): Promise<Upstream> {
  const path = `upstreams/${id}`;
  const propose = (current: Upstream): UpstreamCreate =>
    withUpstreamId({ ...toUpdatePayload(current), targets }, id);

  return serializeWrite(scope, id, async () => {
    return guardedReplace<Upstream, UpstreamCreate>({
      resource: "upstream targets",
      id,
      namespace: scope.namespace,
      // Unguarded, the targets write still rebuilds every setting from the
      // read it is sent against, so it is conditional on that read's tag.
      // `targets` itself is simply replaced: nothing is compared.
      guard: guard ?? UNCOMPARED,
      read: () => readTagged<Upstream>(scope, path),
      propose,
      write: (body, ifMatch) => conditionalPut<Upstream>(scope, path, body, ifMatch),
    });
  });
}

export async function remove(scope: NamespaceScope, id: string): Promise<void> {
  await serializeWrite(scope, id, async () => {
    await proxyApi.delete(`upstreams/${id}`, scoped(scope));
  });
}
