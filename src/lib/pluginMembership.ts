import type { NamespaceScope } from "@/api/client";
import * as pluginsApi from "@/api/plugins";
import * as proxiesApi from "@/api/proxies";
import type {
  PluginConfig,
  PluginConfigCreate,
  Proxy,
} from "@/api/types";

export interface PluginMembershipDependencies {
  listProxies: () => Promise<Proxy[]>;
  getProxy: (id: string) => Promise<Proxy>;
  updateProxy: (id: string, data: ReturnType<typeof proxiesApi.toUpdatePayload>) => Promise<Proxy>;
  getPlugin: (id: string) => Promise<PluginConfig>;
  createPlugin: (data: PluginConfigCreate) => Promise<PluginConfig>;
  updatePlugin: (id: string, data: PluginConfigCreate) => Promise<PluginConfig>;
  deletePlugin: (id: string) => Promise<void>;
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
    listProxies: () => proxiesApi.listAll(scope),
    getProxy: (id) => proxiesApi.get(scope, id),
    updateProxy: (id, data) => proxiesApi.update(scope, id, data),
    getPlugin: (id) => pluginsApi.getConfig(scope, id, true),
    createPlugin: (data) => pluginsApi.createConfig(scope, data),
    updatePlugin: (id, data) => pluginsApi.updateConfig(scope, id, data),
    deletePlugin: (id) => pluginsApi.removeConfig(scope, id),
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
    const after = await deps.updateProxy(snapshot.id, {
      ...proxiesApi.toUpdatePayload(current),
      plugins: desiredAssociations(current, pluginId, desired.has(current.id)),
    });
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
      await deps.updateProxy(current.id, proxiesApi.toUpdatePayload(change.before));
    } catch (error) {
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
    await deps.updatePlugin(before.id, pluginsApi.toUpdatePayload(before));
    return [];
  } catch (error) {
    return [
      `plugin ${before.id} rollback failed (${error instanceof Error ? error.message : "unknown error"})`,
    ];
  }
}

async function updatePluginIfUnchanged(
  snapshot: PluginConfig,
  data: PluginConfigCreate,
  deps: PluginMembershipDependencies,
): Promise<PluginConfig> {
  const current = await deps.getPlugin(snapshot.id);
  if (current.updated_at !== snapshot.updated_at) {
    throw new PluginMembershipError(
      `Plugin ${snapshot.id} changed during membership preflight`,
      [],
    );
  }
  return deps.updatePlugin(snapshot.id, data);
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
          await deps.deletePlugin(created.id);
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

export async function updatePluginWithMembership(
  pluginId: string,
  data: PluginConfigCreate,
  desiredProxyIds: string[],
  deps: PluginMembershipDependencies,
): Promise<PluginConfig> {
  validateScope(data, desiredProxyIds);
  const beforePlugin = await deps.getPlugin(pluginId);
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
    updatedPlugin = await updatePluginIfUnchanged(beforePlugin, data, deps);
    if (nextIsGroup) {
      await applyAssociationPlan(plan.proxies, pluginId, desired, deps, applied);
    }
    return updatedPlugin;
  } catch (error) {
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

export async function deletePluginWithMembership(
  pluginId: string,
  deps: PluginMembershipDependencies,
): Promise<void> {
  const plugin = await deps.getPlugin(pluginId);
  const proxies = await deps.listProxies();
  const applied: AppliedProxyChange[] = [];
  try {
    if (plugin.scope === "proxy_group") {
      await applyAssociationPlan(proxies, pluginId, new Set(), deps, applied);
    }
    // The final detach may already have deleted the group. Only an observed
    // 404 confirms success; authentication/transport errors must still fail.
    if (await getPluginIfPresent(pluginId, deps)) {
      await deps.deletePlugin(pluginId);
    }
  } catch (error) {
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
