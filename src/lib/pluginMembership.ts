import type { NamespaceScope } from "@/api/client";
import {
  isPreconditionFailed,
  StaleResourceError,
  validatorOf,
  type GuardedOperation,
  type WriteGuard,
} from "@/api/conditionalWrite";
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
  ) => Promise<PluginConfig>;
  deletePlugin: (id: string, basis: PluginConfig | null) => Promise<void>;
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
): PluginMembershipDependencies {
  return {
    namespace: scope.namespace,
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
    updatePlugin: (id, data, basis) =>
      pluginsApi.updateConfig(scope, id, data, validatorOf(basis)),
    deletePlugin: (id, basis) =>
      pluginsApi.removeConfig(scope, id, validatorOf(basis)),
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
    const remaining = (await deps.listProxies())
      .filter((proxy) => referencesPlugin(proxy, pluginId))
      .map((proxy) => proxy.id);
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
  disposablePlugin?: PluginConfig,
): Promise<string[]> {
  const failures: string[] = [];
  const changes = [...applied].reverse().sort(
    (a, b) =>
      Number(referencesPlugin(b.before, pluginId)) -
      Number(referencesPlugin(a.before, pluginId)),
  );
  for (const change of changes) {
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
      if (
        plugin?.scope === "proxy_group" &&
        plugin.updated_at !== disposablePlugin?.updated_at &&
        !referencesPlugin(change.before, pluginId)
      ) {
        const hasOtherReference = (await deps.listProxies()).some(
          (proxy) => proxy.id !== current.id && referencesPlugin(proxy, pluginId),
        );
        if (!hasOtherReference) {
          failures.push(
            `proxy ${current.id} was retained as the last reference to preserve plugin ${pluginId}`,
          );
          continue;
        }
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

async function rollbackPlugin(
  before: PluginConfig,
  after: PluginConfig,
  deps: PluginMembershipDependencies,
): Promise<string[]> {
  try {
    const current = await getPluginIfPresent(after.id, deps);
    if (!current) {
      return [`plugin ${after.id} was not restored because it is missing`];
    }
    if (current.updated_at !== after.updated_at) {
      return [`plugin ${after.id} changed after Foundry updated it; config was not overwritten`];
    }
    await deps.updatePlugin(before.id, pluginsApi.toUpdatePayload(before), current);
    return [];
  } catch (error) {
    if (isPreconditionFailed(error)) {
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
    return await deps.updatePlugin(snapshot.id, data, current);
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
    // Something was written between that read and the PUT. If it touched what
    // the editor opened against, the operator needs the comparison, not a
    // generic plan failure.
    const latest = await getPluginIfPresent(snapshot.id, deps);
    if (latest) assertEditorBaseline(latest, guard, "save", data, deps.namespace);
    throw changed();
  }
}

/**
 * Make the documented proxy-scoped end state true, and prove it.
 *
 * `openapi.yaml` is explicit that a proxy-scoped plugin "applies only when the
 * target proxy lists it in `plugins` — `proxy_id` alone never attaches it",
 * and that the gateway appends the association in the same transaction as the
 * write, idempotently. A gateway that does that leaves nothing for this to do:
 * the read below already finds the association and no second write happens.
 *
 * A gateway that does **not** — the pinned contract image is one — answers
 * `201` for a plugin that never runs. The visible consequence is an operator
 * attaching key authentication to a route through the UI and being told it
 * worked while the route keeps serving anonymous traffic, which the
 * critical-journey suite catches at the data plane (#380). So the association
 * is verified after every proxy-scoped write and reconciled when it is
 * missing, and a reconciliation that fails is reported rather than swallowed:
 * Foundry never reports a plugin as attached without having read it back.
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
      // The plugin exists but does not run. Leaving it behind would look like
      // a configured policy, so remove it and say what happened.
      const failure = error instanceof Error ? error.message : "unknown error";
      const recovery: string[] = [];
      try {
        // The create response carries no tag, so this delete is unconditional.
        await deps.deletePlugin(created.id, null);
      } catch {
        recovery.push(
          `orphan plugin ${created.id} could not be deleted; it exists but is not attached to any proxy`,
        );
      }
      throw new PluginMembershipError(
        `Plugin creation did not converge (${failure})`,
        recovery,
        { cause: error },
        pluginsApi.toUpdatePayload(created),
      );
    }
  }

  if (data.scope !== "proxy_group") return created;

  const applied: AppliedProxyChange[] = [];
  try {
    await applyAssociationPlan(
      plan.proxies,
      created.id,
      plan.desired,
      deps,
      applied,
    );
    return created;
  } catch (error) {
    const failure = error instanceof Error ? error.message : "unknown error";
    const recovery = await rollbackAssociations(applied, created.id, deps, created);
    if (recovery.length === 0) {
      try {
        const current = await getPluginIfPresent(created.id, deps);
        if (current && current.updated_at !== created.updated_at) {
          recovery.push(
            `orphan plugin ${created.id} changed concurrently and was not deleted`,
          );
        } else if (current) {
          await deps.deletePlugin(created.id, current);
        }
      } catch (deleteError) {
        recovery.push(
          `orphan plugin ${created.id} could not be deleted (${deleteError instanceof Error ? deleteError.message : "unknown error"})`,
        );
      }
    }
    if (recovery.length > 0) {
      recovery.push(...await recoveryState(created.id, deps));
    }
    throw new PluginMembershipError(
      `Plugin creation did not converge (${failure}); rollback was attempted`,
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
 */
export async function updatePluginWithMembership(
  pluginId: string,
  data: PluginConfigCreate,
  desiredProxyIds: string[],
  deps: PluginMembershipDependencies,
  guard: WriteGuard<PluginConfig | PluginConfigCreate> | null,
): Promise<PluginConfig> {
  validateScope(data, desiredProxyIds);
  const beforePlugin = await deps.getPlugin(pluginId);
  assertEditorBaseline(beforePlugin, guard, "save", data, deps.namespace);
  const plan = await loadPlan(
    data.scope === "proxy_group" ? desiredProxyIds : [],
    deps,
  );
  const nextIsGroup = data.scope === "proxy_group";
  const desired = nextIsGroup ? plan.desired : new Set<string>();

  const applied: AppliedProxyChange[] = [];
  let updatedPlugin: PluginConfig | undefined;

  try {
    // Edge atomically reconciles associations when PUT changes scope to global
    // or proxy. Do not detach first or remove the proxy-scoped target it adds.
    // Group membership remains operator-managed through proxy PUTs.
    updatedPlugin = await updatePluginIfUnchanged(beforePlugin, data, deps, guard);
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
    if (error instanceof StaleResourceError && !updatedPlugin) throw error;
    const failure = error instanceof Error ? error.message : "unknown error";
    const recovery: string[] = [];
    if (updatedPlugin && beforePlugin.scope !== "proxy_group") {
      // Restore non-group scope first: its atomic reconciliation removes group
      // attachments without ever orphaning a group config.
      recovery.push(...await rollbackPlugin(beforePlugin, updatedPlugin, deps));
    } else {
      recovery.push(...await rollbackAssociations(applied, pluginId, deps));
      if (updatedPlugin) {
        recovery.push(...await rollbackPlugin(beforePlugin, updatedPlugin, deps));
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
 * It is checked before any association is detached and again at the read the
 * final `DELETE` is conditional on. `null` only with nothing on screen.
 */
export async function deletePluginWithMembership(
  pluginId: string,
  deps: PluginMembershipDependencies,
  guard: WriteGuard<PluginConfig | PluginConfigCreate> | null,
): Promise<void> {
  const plugin = await deps.getPlugin(pluginId);
  assertEditorBaseline(plugin, guard, "delete", null, deps.namespace);
  const proxies = await deps.listProxies();
  const applied: AppliedProxyChange[] = [];
  try {
    if (plugin.scope === "proxy_group") {
      await applyAssociationPlan(proxies, pluginId, new Set(), deps, applied);
    }
    // The final detach may already have deleted the group. Only an observed
    // 404 confirms success; authentication/transport errors must still fail.
    const present = await getPluginIfPresent(pluginId, deps);
    if (present) {
      assertEditorBaseline(present, guard, "delete", null, deps.namespace);
      await unlessChanged(
        () => deps.deletePlugin(pluginId, present),
        () =>
          new PluginMembershipError(
            `Plugin ${pluginId} changed during deletion; it was not deleted`,
            [],
          ),
      );
    }
  } catch (error) {
    // Nothing detached yet: the refusal is the whole outcome.
    if (error instanceof StaleResourceError && applied.length === 0) throw error;
    const failure = error instanceof Error ? error.message : "unknown error";
    const recovery = await rollbackAssociations(applied, pluginId, deps);
    recovery.push(...await recoveryState(pluginId, deps));
    throw new PluginMembershipError(
      `Plugin deletion failed (${failure}); membership rollback was attempted`,
      recovery,
      { cause: error },
      pluginsApi.toUpdatePayload(plugin),
    );
  }
}
