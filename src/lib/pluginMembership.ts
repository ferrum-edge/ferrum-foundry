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

const defaultDependencies: PluginMembershipDependencies = {
  listProxies: proxiesApi.listAll,
  getProxy: proxiesApi.get,
  updateProxy: proxiesApi.update,
  getPlugin: pluginsApi.getConfig,
  createPlugin: pluginsApi.createConfig,
  updatePlugin: pluginsApi.updateConfig,
  deletePlugin: pluginsApi.removeConfig,
};

interface AppliedProxyChange {
  before: Proxy;
  after: Proxy;
}

export class PluginMembershipError extends Error {
  constructor(
    message: string,
    readonly recovery: string[],
    options?: ErrorOptions,
  ) {
    super(
      recovery.length > 0
        ? `${message} Manual recovery required: ${recovery.join("; ")}`
        : message,
      options,
    );
    this.name = "PluginMembershipError";
  }
}

function validateScope(data: PluginConfigCreate, desiredProxyIds: string[]): void {
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
  deps: PluginMembershipDependencies,
): Promise<string[]> {
  const failures: string[] = [];
  for (const change of [...applied].reverse()) {
    try {
      const current = await deps.getProxy(change.after.id);
      if (current.updated_at !== change.after.updated_at) {
        failures.push(
          `proxy ${current.id} changed after Foundry updated it; association was not overwritten`,
        );
        continue;
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
    const current = await deps.getPlugin(after.id);
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
  desiredProxyIds: string[] = [],
  deps: PluginMembershipDependencies = defaultDependencies,
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
    const recovery = await rollbackAssociations(applied, deps);
    if (recovery.length === 0) {
      try {
        const current = await deps.getPlugin(created.id);
        if (current.updated_at !== created.updated_at) {
          recovery.push(
            `orphan plugin ${created.id} changed concurrently and was not deleted`,
          );
        } else {
          await deps.deletePlugin(created.id);
        }
      } catch (deleteError) {
        recovery.push(
          `orphan plugin ${created.id} could not be deleted (${deleteError instanceof Error ? deleteError.message : "unknown error"})`,
        );
      }
    } else {
      recovery.push(`plugin ${created.id} was retained to avoid dangling associations`);
    }
    throw new PluginMembershipError(
      `Plugin creation did not converge (${failure}); rollback was attempted`,
      recovery,
      { cause: error },
    );
  }
}

export async function updatePluginWithMembership(
  pluginId: string,
  data: PluginConfigCreate,
  desiredProxyIds: string[] = [],
  deps: PluginMembershipDependencies = defaultDependencies,
): Promise<PluginConfig> {
  validateScope(data, desiredProxyIds);
  const beforePlugin = await deps.getPlugin(pluginId);
  const plan = await loadPlan(
    data.scope === "proxy_group" ? desiredProxyIds : [],
    deps,
  );
  const previousWasGroup = beforePlugin.scope === "proxy_group";
  const nextIsGroup = data.scope === "proxy_group";
  const desired = nextIsGroup ? plan.desired : new Set<string>();

  const applied: AppliedProxyChange[] = [];
  let updatedPlugin: PluginConfig | undefined;

  try {
    // Leaving group scope must remove incompatible associations first.
    if (previousWasGroup && !nextIsGroup) {
      await applyAssociationPlan(plan.proxies, pluginId, desired, deps, applied);
      updatedPlugin = await updatePluginIfUnchanged(beforePlugin, data, deps);
      return updatedPlugin;
    }

    // Entering or retaining group scope establishes the group config before
    // attaching references; failures compensate both layers below.
    updatedPlugin = await updatePluginIfUnchanged(beforePlugin, data, deps);
    if (nextIsGroup) {
      await applyAssociationPlan(plan.proxies, pluginId, desired, deps, applied);
    }
    return updatedPlugin;
  } catch (error) {
    const failure = error instanceof Error ? error.message : "unknown error";
    const recovery = await rollbackAssociations(applied, deps);
    if (updatedPlugin && (!nextIsGroup || previousWasGroup || recovery.length === 0)) {
      recovery.push(...await rollbackPlugin(beforePlugin, updatedPlugin, deps));
    } else if (updatedPlugin && nextIsGroup && !previousWasGroup) {
      recovery.push(
        `plugin ${pluginId} was retained in proxy_group scope to avoid invalid dangling associations`,
      );
    }
    throw new PluginMembershipError(
      `Plugin update did not converge (${failure}); compensating rollback was attempted`,
      recovery,
      { cause: error },
    );
  }
}

export async function deletePluginWithMembership(
  pluginId: string,
  deps: PluginMembershipDependencies = defaultDependencies,
): Promise<void> {
  const plugin = await deps.getPlugin(pluginId);
  const proxies = await deps.listProxies();
  const applied: AppliedProxyChange[] = [];
  try {
    if (plugin.scope === "proxy_group") {
      await applyAssociationPlan(proxies, pluginId, new Set(), deps, applied);
    }
    await deps.deletePlugin(pluginId);
  } catch (error) {
    const failure = error instanceof Error ? error.message : "unknown error";
    const recovery = await rollbackAssociations(applied, deps);
    throw new PluginMembershipError(
      `Plugin deletion failed (${failure}); membership rollback was attempted`,
      recovery,
      { cause: error },
    );
  }
}
