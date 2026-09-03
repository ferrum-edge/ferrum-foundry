import type {
  BuiltInCredentialType,
  Consumer,
  PluginConfig,
  Proxy,
} from "@/api/types";
import { pluginAppliesToProxy } from "@/lib/pluginProtocols";

const LOCAL_AUTH_CREDENTIALS: Readonly<Record<string, BuiltInCredentialType>> = {
  key_auth: "keyauth",
  basic_auth: "basicauth",
  jwt_auth: "jwt",
  hmac_auth: "hmac_auth",
  mtls_auth: "mtls_auth",
};

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
 * Every enabled plugin config attached to this proxy by global, direct, or
 * proxy-group scope, before the gateway's protocol filter is applied.
 */
function attachedPluginsForProxy(
  proxy: Proxy,
  pluginConfigs: PluginConfig[],
): EffectivePlugin[] {
  const associated = new Set(
    (proxy.plugins ?? []).map((association) => association.plugin_config_id),
  );

  return pluginConfigs
    .filter((plugin) => {
      if (!plugin.enabled) return false;
      if (plugin.scope === "global") return true;
      if (plugin.scope === "proxy") return plugin.proxy_id === proxy.id;
      return associated.has(plugin.id);
    })
    .map((plugin) => ({
      ...plugin,
      effectiveSource: plugin.scope,
    }))
    .sort((left, right) =>
      priority(left) - priority(right) || left.id.localeCompare(right.id),
    );
}

/**
 * Plugins the gateway actually runs for this proxy: attached by scope AND
 * applicable to the proxy's protocol. A stream (tcp/tcps/udp/dtls) proxy
 * never executes HTTP-only plugins, so counting them would overstate both
 * policy coverage and consumer exposure.
 */
export function effectivePluginsForProxy(
  proxy: Proxy,
  pluginConfigs: PluginConfig[],
): EffectivePlugin[] {
  return attachedPluginsForProxy(proxy, pluginConfigs).filter((plugin) =>
    pluginAppliesToProxy(plugin.plugin_name, proxy),
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
  return attachedPluginsForProxy(proxy, pluginConfigs).filter(
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
  const triggered = authPlugins.filter((plugin) => plugin.trigger != null);
  const priorityIndeterminate = authPlugins.length > 1 && authPlugins.some(
    (plugin) => plugin.priority_override == null,
  );

  if (matchingLocal.length === 0 && external.length === 0) {
    return {
      consumer,
      decision: "denied",
      reasons: ["Consumer has no credential for an effective authentication plugin"],
    };
  }

  if (external.length > 0 || triggered.length > 0 || acl.conditional || priorityIndeterminate) {
    const reasons = [...acl.reasons];
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
