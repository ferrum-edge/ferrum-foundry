import { extractApiErrorData, getCommittedWrite, type NamespaceScope } from "@/api/client";
import {
  GuardVerificationError,
  isPreconditionFailed,
  StaleResourceError,
  validatorOf,
  type GuardedOperation,
  type WriteGuard,
} from "@/api/conditionalWrite";
import { pluginConfigPlaceholderSites } from "@/api/maskedSecretSites";
import type { GatewayRole } from "@/lib/capabilities";
import * as pluginsApi from "@/api/plugins";
import * as proxiesApi from "@/api/proxies";
import { resourceFingerprint } from "@/lib/resourceBaseline";
import type {
  PluginConfig,
  PluginConfigCreate,
  Proxy,
} from "@/api/types";

/**
 * Every write names the read it is based on (`basis`). The gateway binding
 * sends that read's `ETag` as `If-Match`, so the plan's read-compare-write
 * steps are atomic on a gateway that implements the precondition: a `412`
 * surfaces here as the same "changed during the plan" outcome an
 * `updated_at` mismatch produces. `null` means there is no read to be
 * conditional on — a `POST` response, which Edge never tags.
 */
export interface PluginMembershipDependencies {
  /** The namespace every request of the plan is bound to. */
  readonly namespace: string;
  /**
   * The session's gateway role, which decides whether a snapshot read with
   * masked secrets can be written back on rollback. Unknown (`null` or
   * omitted) is treated as a non-admin role.
   */
  readonly role?: GatewayRole | null;
  listProxies: () => Promise<Proxy[]>;
  getProxy: (id: string) => Promise<Proxy>;
  updateProxy: (
    id: string,
    data: ReturnType<typeof proxiesApi.toUpdatePayload>,
    basis: Proxy | null,
  ) => Promise<Proxy>;
  getPlugin: (id: string) => Promise<PluginConfig>;
  createPlugin: (data: PluginConfigCreate) => Promise<PluginConfig>;
  updatePlugin: (
    id: string,
    data: PluginConfigCreate,
    basis: PluginConfig | null,
    /**
     * The association precondition's expected set (forge-ops #569): the
     * proxies the editor showed referencing this configuration (#630), and
     * for a rollback those plus the ones the failed save attached. The gateway
     * refuses the write if another proxy references it by the time the
     * write lands, so an attachment the operator never saw is never
     * silently detached.
     */
    expectedProxyIds: readonly string[],
  ) => Promise<PluginConfig>;
  deletePlugin: (
    id: string,
    basis: PluginConfig | null,
    expectedProxyIds: readonly string[],
  ) => Promise<void>;
  /**
   * Whether a write based on this read would be conditional: the gateway
   * issued a usable strong `ETag` with it. A destructive step the plan cannot
   * make conditional (an untagged or cached read) is not sent.
   */
  canCondition: (read: PluginConfig) => boolean;
}

/**
 * Gateway-backed dependencies bound to one namespace for the whole plan.
 *
 * A membership change is several requests — the proxy listing, per-proxy
 * preflight reads, the plugin write, the association updates, and on failure
 * the compensating rollbacks. Binding all of them to the scope captured when
 * the plan started is what keeps a rollback from landing in a different
 * namespace than the change it undoes.
 */
export function bindPluginMembership(
  scope: NamespaceScope,
  role: GatewayRole | null = null,
): PluginMembershipDependencies {
  return {
    namespace: scope.namespace,
    role,
    listProxies: () => proxiesApi.listAll(scope),
    getProxy: (id) => proxiesApi.get(scope, id),
    // A membership plan runs its own concurrency contract (#244): every write
    // is preceded by a fresh read whose `updated_at` must still match the
    // preflight snapshot, and a mismatch aborts the plan or refuses the
    // rollback. Each write is conditional on that fresh read's own tag
    // (`validatorOf`), which makes the comparison atomic. Layering the proxy
    // editor's baseline guard on top would compare a snapshot this plan never
    // took. See `docs/concurrent-edits.md`.
    updateProxy: (id, data, basis) =>
      proxiesApi.replace(scope, id, data, validatorOf(basis)),
    getPlugin: (id) => pluginsApi.getConfig(scope, id, true),
    createPlugin: (data) => pluginsApi.createConfig(scope, data),
    updatePlugin: (id, data, basis, expectedProxyIds) =>
      pluginsApi.updateConfig(scope, id, data, validatorOf(basis), expectedProxyIds),
    deletePlugin: (id, basis, expectedProxyIds) =>
      // A 404 is "already deleted", which the plan resolves itself.
      pluginsApi.removeConfig(scope, id, validatorOf(basis), expectedProxyIds, {
        handled: [404],
      }),
    canCondition: (read) => validatorOf(read) !== null,
  };
}

interface AppliedProxyChange {
  before: Proxy;
  after: Proxy;
}

export class PluginMembershipError extends Error {
  constructor(
    message: string,
    readonly recovery: string[],
    options?: ErrorOptions,
    readonly lastKnownConfig?: PluginConfigCreate,
  ) {
    super(
      recovery.length > 0
        ? `${message} Recovery details: ${recovery.join("; ")}`
        : message,
      options,
    );
    this.name = "PluginMembershipError";
  }
}

/**
 * A failed step as the plan reports it: the error and the gateway's detail.
 * A plugin write's failure is redacted (`plugins.createConfig`), so its detail
 * is safe to carry into the plan's own message, which the editor shows.
 */
/**
 * A save that left group scope committed, but its attachment could not be
 * verified afterwards (#610). Edge's scope `PUT` detached the group's members
 * in the same transaction; Foundry does not roll that back, because restoring
 * members or removing the new target could undo or cascade-delete another
 * operator's concurrent change. `saved` is the configuration the gateway
 * accepted (or a fresh read of it, after a committed-but-not-live answer), or
 * `undefined` when it could not be read.
 */
export class PluginSavedUnverifiedError extends PluginMembershipError {
  constructor(
    message: string,
    recovery: string[],
    options: ErrorOptions,
    readonly saved: PluginConfig | undefined,
    /**
     * `true` when `saved` is a later read rather than the `PUT` response (a
     * committed-but-not-live answer carries no body). Such a read may already
     * hold another operator's edit, or lag behind on Edge's cached fallback.
     */
    readonly savedFromLaterRead = false,
  ) {
    // The committed configuration doubles as the recovery snapshot.
    super(message, recovery, options, saved ? pluginsApi.toUpdatePayload(saved) : undefined);
    this.name = "PluginSavedUnverifiedError";
  }
}

/**
 * A save or delete refused because the plugin's proxy membership is no longer
 * what the editor showed (#630): a proxy the page never displayed now
 * references it. Nothing was written. Edge's association precondition
 * (`expected_proxy_ids`, forge-ops #569) refuses such a write with `412`; the
 * plan also checks its own listing first, so a gateway that predates the
 * precondition still never detaches a proxy the operator did not see.
 */
export class PluginMembershipChangedError extends PluginMembershipError {
  constructor(
    readonly pluginId: string,
    readonly operation: "save" | "delete",
    /** Proxies referencing the plugin that the editor did not show. */
    readonly unexpectedProxyIds: readonly string[],
    options?: ErrorOptions,
  ) {
    super(
      `Plugin ${pluginId}'s proxy membership changed since this page loaded: ` +
        `${unexpectedProxyIds.join(", ")} now ${unexpectedProxyIds.length === 1 ? "references" : "reference"} it. ` +
        `Nothing was ${operation === "delete" ? "deleted" : "saved"}. ` +
        "Reload to review the current membership before trying again.",
      [],
      options,
    );
    this.name = "PluginMembershipChangedError";
  }
}

/**
 * The proxies an editor shows referencing a plugin, which a save or delete
 * from that editor sends as `expected_proxy_ids` (#630): the group's members
 * for `proxy_group` (`groupMemberIds`, as the editor was seeded with them),
 * the target for `proxy`, none for `global`.
 */
export function observedMembership(
  plugin: Pick<PluginConfig | PluginConfigCreate, "scope" | "proxy_id">,
  groupMemberIds: readonly string[],
): string[] {
  if (plugin.scope === "proxy_group") return [...new Set(groupMemberIds)];
  if (plugin.scope === "proxy" && plugin.proxy_id) return [plugin.proxy_id];
  return [];
}

/**
 * Refuse when `proxies` shows a reference the editor never displayed. A
 * proxy the editor showed that no longer references the plugin is fine: the
 * write cannot detach it.
 */
function assertMembershipUnchanged(
  proxies: readonly Proxy[],
  pluginId: string,
  observed: readonly string[],
  operation: "save" | "delete",
  cause?: unknown,
): void {
  const seen = new Set(observed);
  const unexpected = referencingProxyIds(proxies, pluginId).filter((id) => !seen.has(id));
  if (unexpected.length === 0) return;
  throw new PluginMembershipChangedError(
    pluginId,
    operation,
    unexpected,
    cause === undefined ? undefined : { cause },
  );
}

function failureText(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const detail = "data" in error ? extractApiErrorData((error as { data?: unknown }).data) : "";
  return detail ? `${error.message}: ${detail}` : error.message;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "response" in error &&
    (error.response as Response | undefined)?.status === 404
  );
}

/**
 * Run a write that is conditional on a read the plan just compared, turning
 * the gateway's `412` into the plan's own refusal. Anything else propagates.
 */
async function unlessChanged<T>(write: () => Promise<T>, changed: () => Error): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isPreconditionFailed(error)) throw changed();
    throw error;
  }
}

/**
 * Refuse a plan whose plugin no longer holds what the editor was showing.
 * Checked against every read the plan writes on, so the `If-Match` that read
 * carries makes the check atomic with the write.
 */
function assertEditorBaseline(
  plugin: PluginConfig,
  guard: WriteGuard<PluginConfig | PluginConfigCreate> | null,
  operation: GuardedOperation,
  proposed: PluginConfigCreate | null,
  namespace: string,
): void {
  if (!guard) return;
  const current = guard.select(plugin);
  if (resourceFingerprint(current) === resourceFingerprint(guard.baseline)) return;
  throw new StaleResourceError({
    resource: "plugin configuration",
    operation,
    id: plugin.id,
    namespace,
    original: guard.baseline,
    current,
    proposed: proposed ? guard.select(proposed) : guard.baseline,
  });
}

async function getPluginIfPresent(
  pluginId: string,
  deps: PluginMembershipDependencies,
): Promise<PluginConfig | undefined> {
  try {
    return await deps.getPlugin(pluginId);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function referencesPlugin(proxy: Proxy, pluginId: string): boolean {
  return (proxy.plugins ?? []).some(
    (association) => association.plugin_config_id === pluginId,
  );
}

/** The expected referencing set a plugin write carries, from one proxy listing. */
function referencingProxyIds(proxies: readonly Proxy[], pluginId: string): string[] {
  return proxies
    .filter((proxy) => referencesPlugin(proxy, pluginId))
    .map((proxy) => proxy.id);
}

async function recoveryState(
  pluginId: string,
  deps: PluginMembershipDependencies,
): Promise<string[]> {
  const details: string[] = [];
  try {
    const plugin = await getPluginIfPresent(pluginId, deps);
    details.push(
      plugin
        ? `plugin ${pluginId} exists with scope ${plugin.scope}`
        : `plugin ${pluginId} is missing (GET returned 404); recreate it from the saved configuration before attaching proxies`,
    );
  } catch {
    details.push(`plugin ${pluginId} existence could not be verified`);
  }
  try {
    const remaining = referencingProxyIds(await deps.listProxies(), pluginId);
    details.push(`remaining proxy references: ${remaining.join(", ") || "none"}`);
  } catch {
    details.push("remaining proxy references could not be verified");
  }
  return details;
}

function validateScope(data: PluginConfigCreate, desiredProxyIds: string[]): void {
  if (data.scope === "proxy_group" && desiredProxyIds.length === 0) {
    throw new PluginMembershipError(
      "Proxy-group plugins require at least one proxy",
      [],
    );
  }
  if (data.scope === "proxy" && !data.proxy_id) {
    throw new PluginMembershipError("Proxy-scoped plugins require a proxy", []);
  }
  if (data.scope !== "proxy" && data.proxy_id) {
    throw new PluginMembershipError(
      `${data.scope} plugins cannot carry proxy_id`,
      [],
    );
  }
  if (data.scope !== "proxy_group" && desiredProxyIds.length > 0) {
    throw new PluginMembershipError(
      "Only proxy-group plugins may have association membership",
      [],
    );
  }
}

function uniqueIds(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length || unique.some((id) => !id.trim())) {
    throw new PluginMembershipError(
      "Proxy-group membership contains duplicate or blank proxy IDs",
      [],
    );
  }
  return unique;
}

async function loadPlan(
  desiredProxyIds: string[],
  deps: PluginMembershipDependencies,
): Promise<{ proxies: Proxy[]; desired: Set<string> }> {
  const ids = uniqueIds(desiredProxyIds);
  const proxies = await deps.listProxies();
  const known = new Set(proxies.map((proxy) => proxy.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new PluginMembershipError(
      `Unknown proxy IDs in membership: ${missing.join(", ")}`,
      [],
    );
  }
  return { proxies, desired: new Set(ids) };
}

function desiredAssociations(
  proxy: Proxy,
  pluginId: string,
  shouldInclude: boolean,
): Proxy["plugins"] {
  const withoutPlugin = (proxy.plugins ?? []).filter(
    (association) => association.plugin_config_id !== pluginId,
  );
  return shouldInclude
    ? [...withoutPlugin, { plugin_config_id: pluginId }]
    : withoutPlugin;
}

function associationNeedsChange(
  proxy: Proxy,
  pluginId: string,
  shouldInclude: boolean,
): boolean {
  const matches = (proxy.plugins ?? []).filter(
    (association) => association.plugin_config_id === pluginId,
  ).length;
  // One existing association already expresses the requested membership,
  // regardless of its position among unrelated plugins. Duplicate entries are
  // still normalized through the update path.
  return shouldInclude ? matches !== 1 : matches !== 0;
}

async function applyAssociationPlan(
  proxies: Proxy[],
  pluginId: string,
  desired: Set<string>,
  deps: PluginMembershipDependencies,
  applied: AppliedProxyChange[] = [],
): Promise<AppliedProxyChange[]> {
  const changed = proxies.filter((proxy) =>
    associationNeedsChange(proxy, pluginId, desired.has(proxy.id)),
  );
  // Removing the final group reference deletes its configuration on Edge.
  // Establish every destination before detaching any source.
  changed.sort((a, b) => Number(desired.has(b.id)) - Number(desired.has(a.id)));
  for (const snapshot of changed) {
    const current = await deps.getProxy(snapshot.id);
    if (current.updated_at !== snapshot.updated_at) {
      throw new PluginMembershipError(
        `Proxy ${snapshot.id} changed during membership preflight`,
        [],
      );
    }
    const after = await unlessChanged(
      () =>
        deps.updateProxy(
          snapshot.id,
          {
            ...proxiesApi.toUpdatePayload(current),
            plugins: desiredAssociations(current, pluginId, desired.has(current.id)),
          },
          current,
        ),
      () =>
        new PluginMembershipError(
          `Proxy ${snapshot.id} changed during membership preflight`,
          [],
        ),
    );
    applied.push({ before: current, after });
  }

  return applied;
}

async function rollbackAssociations(
  applied: AppliedProxyChange[],
  pluginId: string,
  deps: PluginMembershipDependencies,
): Promise<string[]> {
  const failures: string[] = [];
  const changes = [...applied].reverse().sort(
    (a, b) =>
      Number(referencesPlugin(b.before, pluginId)) -
      Number(referencesPlugin(a.before, pluginId)),
  );
  for (const change of changes) {
    // Never remove a reference this plan added (#618). If it is the last one
    // of a group, Edge deletes the configuration, and nothing read here can
    // rule that out: another operator can detach the other members, or move
    // the plugin out of group scope and back, and edit it before the write;
    // even a 404 can be Edge's stale cached fallback. Nothing conditions the
    // cascade on the plugin's revision, so the reference is left as it is.
    if (!referencesPlugin(change.before, pluginId)) {
      failures.push(
        `proxy ${change.after.id} was attached by the failed save and left attached; ` +
          `detaching it could delete plugin ${pluginId}. Detach it once the group's members are confirmed`,
      );
      continue;
    }
    try {
      const current = await deps.getProxy(change.after.id);
      if (current.updated_at !== change.after.updated_at) {
        failures.push(
          `proxy ${current.id} changed after Foundry updated it; association was not overwritten`,
        );
        continue;
      }
      const plugin = await getPluginIfPresent(pluginId, deps);
      if (referencesPlugin(change.before, pluginId) && !plugin) {
        failures.push(
          `proxy ${current.id} was not reattached because plugin ${pluginId} is missing`,
        );
        continue;
      }
      await deps.updateProxy(current.id, proxiesApi.toUpdatePayload(change.before), current);
    } catch (error) {
      if (isPreconditionFailed(error)) {
        failures.push(
          `proxy ${change.before.id} changed after Foundry updated it; association was not overwritten`,
        );
        continue;
      }
      failures.push(
        `proxy ${change.before.id} rollback failed (${error instanceof Error ? error.message : "unknown error"})`,
      );
    }
  }
  return failures;
}

/**
 * The references a failed save's rollback may write over (#630): the
 * membership the editor showed, plus the ones this plan established — the
 * proxies its association writes attached and, for a move to proxy scope,
 * the target Edge attached in the plugin `PUT`'s transaction. Restoring a
 * global or proxy scope detaches every other reference, so the rollback's
 * `expected_proxy_ids` is this set, never a listing taken at restore time,
 * which would name (and so detach) a proxy another operator attached after
 * the plugin `PUT`.
 */
function rollbackFence(
  observed: readonly string[],
  applied: readonly AppliedProxyChange[],
  pluginId: string,
  data: PluginConfigCreate,
): string[] {
  const ids = new Set(observed);
  for (const change of applied) {
    if (referencesPlugin(change.after, pluginId)) ids.add(change.after.id);
  }
  if (data.scope === "proxy" && data.proxy_id) ids.add(data.proxy_id);
  return [...ids];
}

function unaccountedReferences(
  proxies: readonly Proxy[],
  pluginId: string,
  fence: readonly string[],
): string[] {
  const accounted = new Set(fence);
  return referencingProxyIds(proxies, pluginId).filter((id) => !accounted.has(id));
}

function notRestoredOver(before: PluginConfig, unaccounted: readonly string[]): string {
  const one = unaccounted.length === 1;
  const why = before.scope === "proxy_group"
    ? "and Foundry does not restore over a reference it did not account for"
    : `and restoring scope ${before.scope} would detach ${one ? "it" : "them"}`;
  return (
    `plugin ${before.id} was not restored: ${unaccounted.join(", ")} ` +
    `${one ? "references" : "reference"} it without having been part of this save, ${why}, ` +
    `so ${unaccounted.join(", ")} ${one ? "was" : "were"} left attached. Review the ` +
    "membership, then restore the previous configuration manually if it is still wanted"
  );
}

/**
 * Put `before` back. A `before` read through a masked projection carries a
 * placeholder for each withheld secret; writing it would be refused
 * (ferrum-edge#5925), or on an older gateway store the placeholder as the
 * secret. When a placeholder sits at a site Edge refuses for the session's
 * role, the rollback is not attempted: it is reported, naming the fields that
 * could not be restored, for manual recovery. An admin's snapshot is raw, so
 * it is always restored.
 */
async function rollbackPlugin(
  before: PluginConfig,
  after: PluginConfig,
  deps: PluginMembershipDependencies,
  fence: readonly string[],
): Promise<string[]> {
  const masked = pluginConfigPlaceholderSites(before.plugin_name, before.config, deps.role)
    .blocking;
  if (masked.length > 0) {
    return [
      `plugin ${before.id} was not restored: its previous configuration was read with ` +
        `${masked.join(", ")} hidden from your role, and Ferrum Edge refuses those ` +
        "placeholders. Manual recovery is needed: restore the previous configuration " +
        "with the real values, or have an admin do it",
    ];
  }
  try {
    const current = await getPluginIfPresent(after.id, deps);
    if (!current) {
      return [`plugin ${after.id} was not restored because it is missing`];
    }
    if (current.updated_at !== after.updated_at) {
      return [`plugin ${after.id} changed after Foundry updated it; config was not overwritten`];
    }
    const unaccounted = unaccountedReferences(await deps.listProxies(), before.id, fence);
    if (unaccounted.length > 0) return [notRestoredOver(before, unaccounted)];
    await deps.updatePlugin(before.id, pluginsApi.toUpdatePayload(before), current, fence);
    return [];
  } catch (error) {
    if (isPreconditionFailed(error)) {
      // Edge's association precondition: a proxy attached after that listing.
      const proxies = await deps.listProxies().catch(() => undefined);
      const unaccounted = proxies ? unaccountedReferences(proxies, before.id, fence) : [];
      if (unaccounted.length > 0) return [notRestoredOver(before, unaccounted)];
      return [`plugin ${after.id} changed after Foundry updated it; config was not overwritten`];
    }
    return [
      `plugin ${before.id} rollback failed (${error instanceof Error ? error.message : "unknown error"})`,
    ];
  }
}

async function updatePluginIfUnchanged(
  snapshot: PluginConfig,
  data: PluginConfigCreate,
  deps: PluginMembershipDependencies,
  guard: WriteGuard<PluginConfig | PluginConfigCreate> | null,
  expectedProxyIds: readonly string[],
): Promise<PluginConfig> {
  const changed = () =>
    new PluginMembershipError(
      `Plugin ${snapshot.id} changed during membership preflight`,
      [],
    );
  const current = await deps.getPlugin(snapshot.id);
  assertEditorBaseline(current, guard, "save", data, deps.namespace);
  if (current.updated_at !== snapshot.updated_at) throw changed();
  try {
    return await deps.updatePlugin(snapshot.id, data, current, expectedProxyIds);
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
    // Something was written between that read and the PUT. If it touched what
    // the editor opened against, the operator needs the comparison, not a
    // generic plan failure; if a proxy the editor never showed now references
    // the plugin (the association precondition), they need to reload.
    const latest = await getPluginIfPresent(snapshot.id, deps);
    if (latest) assertEditorBaseline(latest, guard, "save", data, deps.namespace);
    const proxies = await deps.listProxies().catch(() => undefined);
    if (proxies) assertMembershipUnchanged(proxies, snapshot.id, expectedProxyIds, "save", error);
    throw changed();
  }
}

/**
 * Make the documented proxy-scoped end state true, and prove it.
 *
 * `openapi.yaml` is explicit that a proxy-scoped plugin "applies only when the
 * target proxy lists it in `plugins` — `proxy_id` alone never attaches it",
 * and that the gateway appends the association in the same transaction as the
 * write, idempotently. Every Edge 0.9.x release does that (ferrum-edge#4611),
 * which leaves nothing for this to do: the read below already finds the
 * association and no second write happens.
 *
 * That transaction also advances the proxy's `updated_at`. The plan does not
 * trip over it: this function never compares the proxy with anything read
 * before the plugin write. Its read happens after it, and the one write it may
 * send is conditional on that same read (`basis`), so the gateway's own bump
 * is simply part of the state the plan starts from.
 *
 * A gateway that does **not** attach answers `201` for a plugin that never
 * runs. The visible consequence is an operator attaching key authentication
 * to a route through the UI and being told it worked while the route keeps
 * serving anonymous traffic, which the critical-journey suite catches at the
 * data plane (#380). So the association is verified after every proxy-scoped
 * write and reconciled when it is missing, and a reconciliation that fails is
 * reported rather than swallowed: Foundry never reports a plugin as attached
 * without having read it back.
 */
async function reconcileProxyScopedAssociation(
  pluginId: string,
  desiredProxyId: string,
  deps: PluginMembershipDependencies,
): Promise<void> {
  const proxy = await deps.getProxy(desiredProxyId);
  if (referencesPlugin(proxy, pluginId)) return;

  await unlessChanged(
    () =>
      deps.updateProxy(
        proxy.id,
        {
          ...proxiesApi.toUpdatePayload(proxy),
          plugins: desiredAssociations(proxy, pluginId, true),
        },
        proxy,
      ),
    () =>
      new PluginMembershipError(
        `Proxy ${desiredProxyId} changed while plugin ${pluginId} was being attached`,
        [],
      ),
  );

  const confirmed = await deps.getProxy(desiredProxyId);
  if (!referencesPlugin(confirmed, pluginId)) {
    throw new PluginMembershipError(
      `Plugin ${pluginId} could not be attached to proxy ${desiredProxyId}`,
      [
        `proxy ${desiredProxyId} does not list plugin ${pluginId} after the association write; the plugin exists but does not run`,
      ],
    );
  }
}

/**
 * The mirror image: a plugin that stops being proxy-scoped must stop being
 * attached. The gateway reconciles this too; this verifies it and repairs the
 * one proxy the plugin used to name, never any other.
 */
async function detachFormerProxyScope(
  pluginId: string,
  formerProxyId: string,
  deps: PluginMembershipDependencies,
): Promise<void> {
  const proxy = await deps.getProxy(formerProxyId).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (!proxy || !referencesPlugin(proxy, pluginId)) return;

  await unlessChanged(
    () =>
      deps.updateProxy(
        proxy.id,
        {
          ...proxiesApi.toUpdatePayload(proxy),
          plugins: desiredAssociations(proxy, pluginId, false),
        },
        proxy,
      ),
    () =>
      new PluginMembershipError(
        `Proxy ${formerProxyId} changed while plugin ${pluginId} was being detached`,
        [],
      ),
  );
}

/**
 * What a failed create reports: the new plugin is kept where it got to (#608).
 * No cleanup can be made safe. Detaching group members one by one can let the
 * last detach cascade-delete a configuration another operator edited
 * meanwhile (#609), and a `DELETE` conditional on the plugin cannot see an
 * association another operator made or remade on a proxy, which changes
 * neither the plugin's revision nor its `ETag`.
 */
async function keptCreatedPlugin(
  created: PluginConfig,
  deps: PluginMembershipDependencies,
): Promise<string[]> {
  return [
    `plugin ${created.id} was created and kept; remove it, or finish attaching it, from the plugin page`,
    ...await recoveryState(created.id, deps),
  ];
}

export async function createPluginWithMembership(
  data: PluginConfigCreate,
  desiredProxyIds: string[],
  deps: PluginMembershipDependencies,
): Promise<PluginConfig> {
  validateScope(data, desiredProxyIds);
  const plan = await loadPlan(
    data.scope === "proxy_group" ? desiredProxyIds : [],
    deps,
  );
  const created = await deps.createPlugin(data);

  if (data.scope === "proxy" && data.proxy_id) {
    try {
      await reconcileProxyScopedAssociation(created.id, data.proxy_id, deps);
      return created;
    } catch (error) {
      // The attachment was not proven. Say so, with what the gateway now
      // holds, rather than report a policy as configured.
      const failure = failureText(error);
      throw new PluginMembershipError(
        `Plugin creation did not converge (${failure}); the new plugin was kept`,
        await keptCreatedPlugin(created, deps),
        { cause: error },
        pluginsApi.toUpdatePayload(created),
      );
    }
  }

  if (data.scope !== "proxy_group") return created;

  try {
    await applyAssociationPlan(plan.proxies, created.id, plan.desired, deps);
    return created;
  } catch (error) {
    const failure = failureText(error);
    const recovery = await keptCreatedPlugin(created, deps);
    throw new PluginMembershipError(
      `Plugin creation did not converge (${failure}); the new plugin was kept`,
      recovery,
      { cause: error },
      pluginsApi.toUpdatePayload(created),
    );
  }
}

/**
 * `guard` is the plugin editor's baseline. The plan refuses with
 * `StaleResourceError`, before anything is written, if the configuration no
 * longer holds what the editor opened — checked at the preflight read and
 * again at the read the plugin `PUT` is conditional on. `null` only for a
 * caller with no editor to compare.
 *
 * `observedProxyIds` is the membership the editor showed
 * (`observedMembership`), not a fresh listing (#630). It is the plugin
 * `PUT`'s `expected_proxy_ids`, and the plan refuses with
 * `PluginMembershipChangedError`, before anything is written, when its own
 * listing already shows a proxy outside it.
 */
export async function updatePluginWithMembership(
  pluginId: string,
  data: PluginConfigCreate,
  desiredProxyIds: string[],
  deps: PluginMembershipDependencies,
  guard: WriteGuard<PluginConfig | PluginConfigCreate> | null,
  observedProxyIds: readonly string[],
): Promise<PluginConfig> {
  validateScope(data, desiredProxyIds);
  const observed = [...new Set(observedProxyIds)];
  const beforePlugin = await deps.getPlugin(pluginId);
  assertEditorBaseline(beforePlugin, guard, "save", data, deps.namespace);
  const plan = await loadPlan(
    data.scope === "proxy_group" ? desiredProxyIds : [],
    deps,
  );
  assertMembershipUnchanged(plan.proxies, pluginId, observed, "save");
  const nextIsGroup = data.scope === "proxy_group";
  const desired = nextIsGroup ? plan.desired : new Set<string>();

  const applied: AppliedProxyChange[] = [];
  let updatedPlugin: PluginConfig | undefined;

  try {
    // Edge atomically reconciles associations when PUT changes scope to global
    // or proxy. Do not detach first or remove the proxy-scoped target it adds.
    // Group membership remains operator-managed through proxy PUTs.
    updatedPlugin = await updatePluginIfUnchanged(
      beforePlugin,
      data,
      deps,
      guard,
      observed,
    );
    if (nextIsGroup) {
      await applyAssociationPlan(plan.proxies, pluginId, desired, deps, applied);
    } else if (data.scope === "proxy" && data.proxy_id) {
      await reconcileProxyScopedAssociation(pluginId, data.proxy_id, deps);
      if (beforePlugin.scope === "proxy" && beforePlugin.proxy_id &&
          beforePlugin.proxy_id !== data.proxy_id) {
        await detachFormerProxyScope(pluginId, beforePlugin.proxy_id, deps);
      }
    } else if (beforePlugin.scope === "proxy" && beforePlugin.proxy_id) {
      await detachFormerProxyScope(pluginId, beforePlugin.proxy_id, deps);
    }
    return updatedPlugin;
  } catch (error) {
    // Refused before the plugin write: nothing was changed, so there is
    // nothing to roll back, and the editor needs the comparison, not a
    // recovery report.
    if (
      (error instanceof StaleResourceError || error instanceof PluginMembershipChangedError) &&
      !updatedPlugin
    ) {
      throw error;
    }
    const failure = failureText(error);
    // A committed-but-not-live answer to the plugin PUT is a committed save.
    const committedPut = !updatedPlugin && getCommittedWrite(error) !== null;
    if ((updatedPlugin || committedPut) && beforePlugin.scope === "proxy_group" && !nextIsGroup) {
      // The scope change committed, and with it Edge detached every member.
      // Leave the gateway's committed state alone and say what to check.
      const members = plan.proxies
        .filter((proxy) => referencesPlugin(proxy, pluginId))
        .map((proxy) => proxy.id);
      const saved = updatedPlugin ??
        await getPluginIfPresent(pluginId, deps).catch(() => undefined);
      throw new PluginSavedUnverifiedError(
        `Plugin ${pluginId} was saved with scope ${data.scope}` +
          (committedPut ? " (committed, not yet proven live)" : "") +
          `, but its attachment could not be verified (${failure}). Nothing was rolled back.`,
        [
          `before this save the group's members were: ${members.join(", ") || "none"}`,
          ...(() => {
            // Edge keeps the association on the new proxy-scope target.
            const detached = members.filter((id) => !(data.scope === "proxy" && id === data.proxy_id));
            return [`the scope change detached: ${detached.join(", ") || "none"}`];
          })(),
          ...(data.scope === "proxy" && data.proxy_id
            ? [`check that proxy ${data.proxy_id} lists plugin ${pluginId}`]
            : []),
          ...await recoveryState(pluginId, deps),
        ],
        { cause: error },
        saved,
        !updatedPlugin,
      );
    }
    const recovery: string[] = [];
    const fence = rollbackFence(observed, applied, pluginId, data);
    if (updatedPlugin && beforePlugin.scope !== "proxy_group") {
      // Restore non-group scope first: its atomic reconciliation removes group
      // attachments without ever orphaning a group config.
      recovery.push(...await rollbackPlugin(beforePlugin, updatedPlugin, deps, fence));
    } else {
      recovery.push(...await rollbackAssociations(applied, pluginId, deps));
      if (updatedPlugin) {
        recovery.push(...await rollbackPlugin(beforePlugin, updatedPlugin, deps, fence));
      }
    }
    recovery.push(...await recoveryState(pluginId, deps));
    throw new PluginMembershipError(
      `Plugin update did not converge (${failure}); compensating rollback was attempted`,
      recovery,
      { cause: error },
      pluginsApi.toUpdatePayload(beforePlugin),
    );
  }
}

/**
 * `guard` is the plugin editor's baseline: a configuration that changed since
 * the page loaded is not deleted (`StaleResourceError`, operation `delete`).
 * `null` only with nothing on screen.
 *
 * The delete is one `DELETE`, conditional on the read the baseline was
 * compared with. Edge removes the configuration from every proxy that lists
 * it in the same transaction, so group membership needs no detaching first.
 * Detaching first would let the last detach cascade-delete the configuration
 * before the baseline could be checked against it again (#609); here the
 * gateway refuses the `DELETE` with `412` if anything was written since.
 *
 * `observedProxyIds` is the membership the page showed
 * (`observedMembership`), sent as `expected_proxy_ids` (#630). A fresh
 * listing would only cover the moments between it and the `DELETE`: a proxy
 * attached after the page loaded would be listed, expected, and silently
 * detached. A proxy outside it refuses the delete
 * (`PluginMembershipChangedError`), whether the plan's own listing shows it
 * or Edge's precondition answers `412`.
 */
export async function deletePluginWithMembership(
  pluginId: string,
  deps: PluginMembershipDependencies,
  guard: WriteGuard<PluginConfig | PluginConfigCreate> | null,
  observedProxyIds: readonly string[],
): Promise<void> {
  const observed = [...new Set(observedProxyIds)];
  const plugin = await deps.getPlugin(pluginId);
  // Never an unconditional DELETE, and never a comparison against a read that
  // may lag the stored configuration: an untagged read refuses before either
  // (policy #542).
  if (!deps.canCondition(plugin)) throw new GuardVerificationError("delete");
  assertEditorBaseline(plugin, guard, "delete", null, deps.namespace);
  // The delete detaches every referencing proxy in Edge's transaction; the
  // expected set names only the ones the page showed, so a proxy attached
  // since refuses the delete instead of being silently detached. This
  // listing refuses it early, and on a gateway without the precondition.
  assertMembershipUnchanged(await deps.listProxies(), pluginId, observed, "delete");
  try {
    await deps.deletePlugin(pluginId, plugin, observed);
  } catch (error) {
    // Already gone: the outcome the operator asked for.
    if (isNotFound(error)) return;
    // Committed, not yet proven live: a completed delete. The caller resolves
    // it as one (`removeCommitted`) instead of reporting a failure.
    if (getCommittedWrite(error)) throw error;
    if (isPreconditionFailed(error)) {
      // Something was written since the compared read. If it touched what
      // the page showed, the operator needs the comparison.
      const latest = await getPluginIfPresent(pluginId, deps).catch(() => undefined);
      if (latest) assertEditorBaseline(latest, guard, "delete", null, deps.namespace);
      // Edge's association precondition: a proxy the page never showed now
      // references the plugin.
      const proxies = await deps.listProxies().catch(() => undefined);
      if (proxies) assertMembershipUnchanged(proxies, pluginId, observed, "delete", error);
      throw new PluginMembershipError(
        `Plugin ${pluginId} changed during deletion; it was not deleted`,
        await recoveryState(pluginId, deps),
        { cause: error },
      );
    }
    throw new PluginMembershipError(
      `Plugin deletion failed (${failureText(error)})`,
      await recoveryState(pluginId, deps),
      { cause: error },
      pluginsApi.toUpdatePayload(plugin),
    );
  }
}
