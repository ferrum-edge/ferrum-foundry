import type {
  BuiltInCredentialType,
  Consumer,
  PluginConfig,
  Proxy,
} from "@/api/types";
import { pluginAppliesToProxy } from "@/lib/pluginProtocols";

const LOCAL_AUTH_CREDENTIALS: Readonly<Record<string, BuiltInCredentialType>> = {
  key_auth: "keyauth",
  jwt_auth: "jwt",
  hmac_auth: "hmac_auth",
  mtls_auth: "mtls_auth",
};

// Ordinary Consumer responses cannot express this type, even when configured.
// Never use its omission (or backup secrets) as evidence of access or absence.
const UNOBSERVABLE_LOCAL_AUTH = new Set(["basic_auth"]);
const BASIC_AUTH_UNKNOWN_REASON =
  "Basic-auth credential presence is unknown: ordinary Consumer responses omit basicauth";

const EXTERNAL_AUTH_PLUGINS = new Set([
  "jwks_auth",
  "oauth2_introspection",
  "oidc_relying_party",
  "ldap_auth",
  "spiffe_identity",
  "soap_ws_security",
]);

function soapEstablishesIdentity(plugin: PluginConfig): boolean {
  if (plugin.plugin_name !== "soap_ws_security") return true;
  return ["username_token", "x509_signature", "saml"].some((key) => {
    const value = plugin.config?.[key];
    if (!value || typeof value !== "object") return false;
    return (value as Record<string, unknown>).enabled !== false;
  });
}

function isAuthPlugin(plugin: PluginConfig): boolean {
  if (UNOBSERVABLE_LOCAL_AUTH.has(plugin.plugin_name)) return true;
  if (plugin.plugin_name in LOCAL_AUTH_CREDENTIALS) return true;
  return EXTERNAL_AUTH_PLUGINS.has(plugin.plugin_name) && soapEstablishesIdentity(plugin);
}

export type AccessDecision = "public" | "allowed" | "denied" | "conditional";

export interface EffectivePlugin extends PluginConfig {
  effectiveSource: "global" | "proxy" | "proxy_group";
}

export interface ConsumerAccessResult {
  consumer: Consumer;
  decision: AccessDecision;
  reasons: string[];
}

export interface ProxyPolicyAnalysis {
  proxy: Proxy;
  effectivePlugins: EffectivePlugin[];
  authPlugins: EffectivePlugin[];
  accessControlPlugins: EffectivePlugin[];
  consumers: ConsumerAccessResult[];
  conditional: boolean;
  reasons: string[];
  evaluatedAt: string;
  latestConfigUpdate?: string;
}

function priority(plugin: PluginConfig): number {
  return plugin.priority_override ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Enabled plugin configurations arranged so a single proxy's attached set
 * can be assembled without rescanning the whole collection.
 *
 * `globals` and `byId` together encode exactly what the previous
 * collection-wide filter did: an enabled global plugin attaches to every
 * proxy, while a proxy- or proxy-group-scoped plugin attaches only when the
 * proxy's own `plugins` list names its configuration (and, for a
 * proxy-scoped one, it targets that proxy). Shadowing of globals by a
 * same-name scoped instance depends on the proxy, so it is applied per proxy
 * from the index rather than stored in it. The index depends only on the
 * plugin collection, so it is memoized on that collection's identity and
 * rebuilt when the data changes.
 */
export interface PluginAttachmentIndex {
  /** Enabled global configurations, in collection order. */
  readonly globals: readonly PluginConfig[];
  /** Enabled proxy- and proxy-group-scoped configurations, by configuration id. */
  readonly byId: ReadonlyMap<string, PluginConfig>;
}

/** Build the attachment index for one complete plugin collection. */
export function buildPluginAttachmentIndex(
  pluginConfigs: PluginConfig[],
): PluginAttachmentIndex {
  const globals: PluginConfig[] = [];
  const byId = new Map<string, PluginConfig>();

  for (const plugin of pluginConfigs) {
    if (!plugin.enabled) continue;
    if (plugin.scope === "global") globals.push(plugin);
    else byId.set(plugin.id, plugin);
  }

  return { globals, byId };
}

const attachmentIndexCache = new WeakMap<readonly PluginConfig[], PluginAttachmentIndex>();

/**
 * The attachment index for `pluginConfigs`, built once per collection.
 *
 * TanStack Query hands back the same array reference until the collection
 * changes, so a render that resolves this index for every proxy on screen
 * reuses one build instead of rescanning the collection per proxy. The
 * collection is treated as immutable, as everywhere else query data is read.
 */
export function pluginAttachmentIndex(
  pluginConfigs: PluginConfig[],
): PluginAttachmentIndex {
  const cached = attachmentIndexCache.get(pluginConfigs);
  if (cached) return cached;

  const built = buildPluginAttachmentIndex(pluginConfigs);
  attachmentIndexCache.set(pluginConfigs, built);
  return built;
}

// Size policy is conjunctive in the gateway: a global limiter keeps running
// beside a same-name scoped instance so the strictest bound still applies.
const ADDITIVE_PLUGIN_NAMES = new Set(["request_size_limiting", "response_size_limiting"]);

const ISTIO_ROUTE_TRANSFORM_PREFIXES: Readonly<Record<string, string>> = {
  request_transformer: "istio-vs-req-xform-",
  response_transformer: "istio-vs-resp-xform-",
};

/**
 * The exact no-static-rules transformer the gateway's Istio VirtualService
 * translator emits to apply per-route header overrides. It is additive to a
 * same-name global transformer; any other proxy-scoped transformer shadows
 * the global one as usual.
 */
function isIstioRouteTransformConsumer(plugin: PluginConfig, proxy: Proxy): boolean {
  if (plugin.scope !== "proxy" || plugin.proxy_id !== proxy.id) return false;
  const prefix = ISTIO_ROUTE_TRANSFORM_PREFIXES[plugin.plugin_name];
  if (prefix === undefined || plugin.id !== `${prefix}${proxy.id}`) return false;
  const rules = plugin.config?.rules;
  return (
    Array.isArray(rules) && rules.length === 0 && plugin.config?.apply_route_overrides === true
  );
}

/** Whether attaching this scoped configuration removes same-name globals. */
function shadowsGlobal(plugin: PluginConfig, proxy: Proxy): boolean {
  if (ADDITIVE_PLUGIN_NAMES.has(plugin.plugin_name)) return false;
  return !isIstioRouteTransformConsumer(plugin, proxy);
}

/**
 * Every enabled plugin config attached to this proxy by global, direct, or
 * proxy-group scope, before the gateway's protocol filter is applied.
 *
 * Mirrors the gateway's scope merge (Ferrum Edge v0.9.7 `plugin_cache.rs`,
 * `remove_shadowed_global_plugin` and `is_istio_route_transform_consumer`):
 * an enabled, attached proxy- or proxy-group-scoped configuration replaces
 * every global configuration with the same plugin name, except for the
 * request/response size limiters and the Istio route-transform consumer,
 * which are additive. A disabled or unattached scoped configuration shadows
 * nothing, because the gateway never merges it.
 */
function attachedPluginsForProxy(
  proxy: Proxy,
  index: PluginAttachmentIndex,
): EffectivePlugin[] {
  const associated = new Set(
    (proxy.plugins ?? []).map((association) => association.plugin_config_id),
  );
  const scoped: PluginConfig[] = [];
  const shadowed = new Set<string>();

  for (const id of associated) {
    const plugin = index.byId.get(id);
    if (!plugin) continue;
    // `proxy_id` records intent, not attachment: a proxy-scoped plugin runs
    // only when the proxy's own `plugins` list names it, like a group one.
    if (plugin.scope === "proxy" && plugin.proxy_id !== proxy.id) continue;
    scoped.push(plugin);
    if (shadowsGlobal(plugin, proxy)) shadowed.add(plugin.plugin_name);
  }

  const globals = shadowed.size === 0
    ? index.globals
    : index.globals.filter((plugin) => !shadowed.has(plugin.plugin_name));

  return [...globals, ...scoped]
    .map((plugin) => ({
      ...plugin,
      effectiveSource: plugin.scope,
    }))
    .sort((left, right) =>
      priority(left) - priority(right) || left.id.localeCompare(right.id),
    );
}

/**
 * Plugins the gateway actually runs for this proxy: attached by scope, not
 * shadowed by a same-name scoped instance, AND applicable to the proxy's
 * protocol. A stream (tcp/tcps/udp/dtls) proxy
 * never executes HTTP-only plugins, so counting them would overstate both
 * policy coverage and consumer exposure.
 */
export function effectivePluginsForProxy(
  proxy: Proxy,
  pluginConfigs: PluginConfig[],
): EffectivePlugin[] {
  return attachedPluginsForProxy(proxy, pluginAttachmentIndex(pluginConfigs)).filter(
    (plugin) => pluginAppliesToProxy(plugin.plugin_name, proxy),
  );
}

/**
 * The counterpart of {@link effectivePluginsForProxy}: enabled global,
 * direct, and proxy-group plugins that are attached to this proxy but which
 * the gateway skips because they are HTTP-only. Always empty for an HTTP
 * proxy; the UI shows them so an attachment never silently disappears.
 */
export function inapplicablePluginsForProxy(
  proxy: Proxy,
  pluginConfigs: PluginConfig[],
): EffectivePlugin[] {
  return attachedPluginsForProxy(proxy, pluginAttachmentIndex(pluginConfigs)).filter(
    (plugin) => !pluginAppliesToProxy(plugin.plugin_name, proxy),
  );
}

function stringList(config: Record<string, unknown>, key: string): string[] {
  const value = config[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function aclDecision(
  consumer: Consumer,
  plugins: EffectivePlugin[],
): { denied: boolean; conditional: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const groups = new Set(consumer.acl_groups ?? []);
  const conditionalPlugins = plugins.filter((plugin) => plugin.trigger != null);

  for (const plugin of plugins.filter((candidate) => candidate.trigger == null)) {
    const config = plugin.config ?? {};
    const deniedConsumers = stringList(config, "disallowed_consumers");
    const deniedGroups = stringList(config, "disallowed_groups");
    const allowedConsumers = stringList(config, "allowed_consumers");
    const allowedGroups = stringList(config, "allowed_groups");

    if (deniedConsumers.includes(consumer.username)) {
      return {
        denied: true,
        conditional: conditionalPlugins.length > 0,
        reasons: [`${plugin.id} explicitly denies consumer ${consumer.username}`],
      };
    }
    const deniedGroup = deniedGroups.find((group) => groups.has(group));
    if (deniedGroup) {
      return {
        denied: true,
        conditional: conditionalPlugins.length > 0,
        reasons: [`${plugin.id} denies ACL group ${deniedGroup}`],
      };
    }

    if (allowedConsumers.length > 0 || allowedGroups.length > 0) {
      const usernameAllowed = allowedConsumers.includes(consumer.username);
      const groupAllowed = allowedGroups.some((group) => groups.has(group));
      if (!usernameAllowed && !groupAllowed) {
        return {
          denied: true,
          conditional: conditionalPlugins.length > 0,
          reasons: [`${plugin.id} has an allow-list that does not match this consumer`],
        };
      }
      reasons.push(`${plugin.id} allow-list matches`);
    }
  }

  if (conditionalPlugins.length > 0) {
    reasons.push("Request-dependent access-control trigger requires runtime evaluation");
  }
  return { denied: false, conditional: conditionalPlugins.length > 0, reasons };
}

function hasCredential(consumer: Consumer, type: BuiltInCredentialType): boolean {
  const entries = consumer.credentials?.[type];
  return Array.isArray(entries) && entries.length > 0;
}

export function resolveConsumerAccess(
  proxy: Proxy,
  effectivePlugins: EffectivePlugin[],
  consumer: Consumer,
): ConsumerAccessResult {
  void proxy;
  const authPlugins = effectivePlugins.filter(isAuthPlugin);
  if (authPlugins.length === 0) {
    return {
      consumer,
      decision: "public",
      reasons: ["No recognized effective authentication plugin"],
    };
  }

  const acl = aclDecision(
    consumer,
    effectivePlugins.filter((plugin) => plugin.plugin_name === "access_control"),
  );
  if (acl.denied) {
    return { consumer, decision: "denied", reasons: acl.reasons };
  }

  const matchingLocal = authPlugins.filter((plugin) => {
    const credential = LOCAL_AUTH_CREDENTIALS[plugin.plugin_name];
    return credential ? hasCredential(consumer, credential) : false;
  });
  const external = authPlugins.filter((plugin) =>
    EXTERNAL_AUTH_PLUGINS.has(plugin.plugin_name),
  );
  const unknownLocal = matchingLocal.length === 0 && authPlugins.some((plugin) =>
    UNOBSERVABLE_LOCAL_AUTH.has(plugin.plugin_name),
  );
  const triggered = authPlugins.filter((plugin) => plugin.trigger != null);
  const priorityIndeterminate = authPlugins.length > 1 && authPlugins.some(
    (plugin) => plugin.priority_override == null,
  );

  if (matchingLocal.length === 0 && external.length === 0 && !unknownLocal) {
    return {
      consumer,
      decision: "denied",
      reasons: ["Consumer has no credential for an effective authentication plugin"],
    };
  }

  if (unknownLocal || external.length > 0 || triggered.length > 0 || acl.conditional || priorityIndeterminate) {
    const reasons = [...acl.reasons];
    if (unknownLocal) reasons.push(BASIC_AUTH_UNKNOWN_REASON);
    if (external.length > 0) {
      reasons.push(
        `External identity mapping must be evaluated at request time (${external.map((p) => p.plugin_name).join(", ")})`,
      );
    }
    if (triggered.length > 0) {
      reasons.push("One or more authentication plugins have request-dependent triggers");
    }
    if (priorityIndeterminate) {
      reasons.push("Authentication execution order is not exposed for every plugin instance");
    }
    if (matchingLocal.length > 0) {
      reasons.push(
        `Consumer has a matching local credential (${matchingLocal.map((p) => p.plugin_name).join(", ")})`,
      );
    }
    return { consumer, decision: "conditional", reasons };
  }

  return {
    consumer,
    decision: "allowed",
    reasons: [
      ...acl.reasons,
      `Matching credential for ${matchingLocal.map((plugin) => plugin.plugin_name).join(", ")}`,
    ],
  };
}

export function analyzeProxyPolicy(
  proxy: Proxy,
  pluginConfigs: PluginConfig[],
  consumers: Consumer[],
  evaluatedAt = new Date().toISOString(),
): ProxyPolicyAnalysis {
  const effectivePlugins = effectivePluginsForProxy(proxy, pluginConfigs);
  const authPlugins = effectivePlugins.filter(isAuthPlugin);
  const accessControlPlugins = effectivePlugins.filter(
    (plugin) => plugin.plugin_name === "access_control",
  );
  const reasons: string[] = [];

  if (authPlugins.some((plugin) => UNOBSERVABLE_LOCAL_AUTH.has(plugin.plugin_name))) {
    reasons.push(BASIC_AUTH_UNKNOWN_REASON);
  }
  if (effectivePlugins.some((plugin) => plugin.trigger != null)) {
    reasons.push("Request-dependent plugin triggers make access conditional");
  }
  if (authPlugins.some((plugin) => EXTERNAL_AUTH_PLUGINS.has(plugin.plugin_name))) {
    reasons.push("External identities cannot be mapped conclusively from stored consumers");
  }
  if (authPlugins.length > 1 && authPlugins.some((plugin) => plugin.priority_override == null)) {
    reasons.push("Authentication execution order is not fully exposed by the admin API");
  }

  const latestConfigUpdate = effectivePlugins
    .map((plugin) => plugin.updated_at)
    .filter(Boolean)
    .sort()
    .at(-1);

  return {
    proxy,
    effectivePlugins,
    authPlugins,
    accessControlPlugins,
    consumers: consumers.map((consumer) =>
      resolveConsumerAccess(proxy, effectivePlugins, consumer),
    ),
    conditional: reasons.length > 0,
    reasons,
    evaluatedAt,
    latestConfigUpdate,
  };
}
