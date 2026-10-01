/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – MCP tool catalog with per-tool policy             */
/*                                                                    */
/*  For a proxy with `mcp_gateway`: every tool the gateway node has    */
/*  cached (`GET /proxies/{id}/mcp/tools`), where it comes from, its   */
/*  annotations, the stored policy and grants, and what the node       */
/*  actually enforces. A tool's policy is edited inline and written to */
/*  the plugin configuration through the conditional-write path.       */
/* ------------------------------------------------------------------ */

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { committedWriteMessage, getApiErrorMessage, getCommittedWrite } from "@/api/client";
import { isStaleResourceError, type StaleResourceDetail, type WriteGuard } from "@/api/conditionalWrite";
import { maskedPlaceholderRefusal } from "@/api/maskedSecrets";
import { pluginConfigPlaceholderSites } from "@/api/maskedSecretSites";
import {
  McpToolPolicyError,
  newToolPolicyWriteGuard,
  toolPolicyWriteGuard,
  type McpToolCatalog,
  type McpToolCatalogTool,
} from "@/api/mcpTools";
import type { PluginConfig, PluginConfigCreate } from "@/api/types";
import { TagInput } from "@/components/forms/TagInput";
import { CapabilityNotice } from "@/components/shared/CapabilityGate";
import { MaskedSecretRefusal } from "@/components/shared/MaskedSecretRefusal";
import { ReadState, ReadStateNotice } from "@/components/shared/ReadState";
import { StaleWriteDialog } from "@/components/shared/StaleWriteDialog";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import type { EditorSession } from "@/hooks/useEditorIdentity";
import { useMcpToolCatalog, useUpdateMcpToolPolicy } from "@/hooks/useMcpTools";
import { usePluginConfig } from "@/hooks/usePlugins";
import type { CapabilityVerdict, GatewayRole } from "@/lib/capabilities";
import { formatDateTime } from "@/lib/format";
import {
  CATALOG_STATE_LABELS,
  catalogStateExplanation,
  EFFECTIVE_LABELS,
  mcpToolRows,
  policyAwaitingNode,
  TOOLS_REFRESH_LABELS,
  type McpToolRow,
} from "@/lib/mcpToolCatalog";
import {
  defaultToolAction,
  mcpGatewayMode,
  MCP_TOOL_ACTION_LABELS,
  validateToolPolicy,
  type McpToolAction,
  type McpToolPolicyEntry,
} from "@/lib/mcpToolPolicy";
import { useCapabilities } from "@/stores/capabilities";

type BadgeVariant = "default" | "orange" | "blue" | "green" | "red" | "yellow" | "purple";

const STATE_VARIANTS: Record<McpToolCatalog["catalog_state"], BadgeVariant> = {
  fresh: "green",
  stale: "yellow",
  not_refreshed: "default",
  unmediated: "blue",
  not_served: "yellow",
};

const EFFECTIVE_VARIANTS: Record<McpToolCatalogTool["policy"]["effective"], BadgeVariant> = {
  allow: "green",
  deny: "red",
  hide_from_discovery: "default",
  hidden_until_configured: "yellow",
  hidden_schema_changed: "yellow",
};

/** Companion products that stamp `provisioned-by` (Ferrum Contracts vocabulary). */
const PROVISIONERS: Record<string, string> = {
  "ferrum-nexus": "Ferrum Nexus",
  "ferrum-edge-git-forge-ops": "GitForgeOps",
  "ferrum-foundry": "Ferrum Foundry",
};

const DEFAULT_CHOICE = "default";

function GroupList({ label, groups }: { label: string; groups: readonly string[] }) {
  if (groups.length === 0) return null;
  return (
    <span className="text-xs text-text-muted">
      {label}:{" "}
      <span className="text-text-secondary break-all">{groups.join(", ")}</span>
    </span>
  );
}

function Annotations({ annotations }: { annotations: Record<string, unknown> | null }) {
  if (!annotations) return null;
  const hints: [string, string, BadgeVariant][] = [
    ["readOnlyHint", "Read-only", "green"],
    ["destructiveHint", "Destructive", "red"],
    ["idempotentHint", "Idempotent", "blue"],
    ["openWorldHint", "Open world", "purple"],
  ];
  const shown = hints.filter(([key]) => annotations[key] === true);
  if (shown.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1.5" aria-label="Annotations">
      {shown.map(([key, label, variant]) => (
        <Badge key={key} variant={variant}>
          {label}
        </Badge>
      ))}
    </span>
  );
}

function ToolSource({ tool }: { tool: McpToolCatalogTool }) {
  const { source } = tool;
  if (source.type === "openapi") {
    return (
      <span className="text-xs text-text-muted break-all">
        Generated from OpenAPI operation{" "}
        <span className="font-mono text-text-secondary">
          {source.method} {source.path}
        </span>{" "}
        ({source.operation_name}) · server {source.server_id}
      </span>
    );
  }
  return (
    <span className="text-xs text-text-muted break-all">
      Upstream MCP server {source.server_id} · lists it as{" "}
      <span className="font-mono text-text-secondary">{source.upstream_name}</span>
    </span>
  );
}

/** What the stored configuration says, in words. */
function configuredSummary(row: McpToolRow, config: Record<string, unknown> | undefined): string {
  if (row.configured === undefined || !config) {
    return row.tool
      ? `${MCP_TOOL_ACTION_LABELS[row.tool.policy.action]}${row.tool.policy.configured ? "" : " (default)"}`
      : "Unknown";
  }
  if (row.unparsedEntry) return "Entry Foundry cannot edit; see the plugin configuration";
  if (row.configured === null) return `${MCP_TOOL_ACTION_LABELS[defaultToolAction(config)]} (default)`;
  return MCP_TOOL_ACTION_LABELS[row.configured.action];
}

function rowGroups(row: McpToolRow): { allowed: string[] | null; denied: string[] } {
  if (row.configured !== undefined) {
    if (row.configured?.action !== "allow") return { allowed: null, denied: [] };
    return {
      allowed: row.configured.allowed_groups ?? null,
      denied: row.configured.denied_groups ?? [],
    };
  }
  return { allowed: row.tool?.allowed_groups ?? null, denied: row.tool?.denied_groups ?? [] };
}

interface EditTarget {
  name: string;
  isNew: boolean;
  guard: WriteGuard<PluginConfig | PluginConfigCreate>;
}

interface ToolPolicyEditorProps {
  name: string;
  isNew: boolean;
  initial: McpToolPolicyEntry | null;
  config: Record<string, unknown>;
  saving: boolean;
  errors: string[];
  onSave: (name: string, entry: McpToolPolicyEntry | null) => void;
  onCancel: () => void;
}

/** Inline editor for one `policy.tools` entry. */
function ToolPolicyEditor({
  name: initialName,
  isNew,
  initial,
  config,
  saving,
  errors,
  onSave,
  onCancel,
}: ToolPolicyEditorProps) {
  const [name, setName] = useState(initialName);
  const [choice, setChoice] = useState<string>(initial?.action ?? DEFAULT_CHOICE);
  const [allowed, setAllowed] = useState<string[]>(initial?.allowed_groups ?? []);
  const [denied, setDenied] = useState<string[]>(initial?.denied_groups ?? []);
  const [touched, setTouched] = useState(false);

  const entry: McpToolPolicyEntry | null =
    choice === DEFAULT_CHOICE
      ? null
      : {
          action: choice as McpToolAction,
          allowed_groups: choice === "allow" ? allowed : null,
          denied_groups: choice === "allow" ? denied : null,
        };
  const problems = validateToolPolicy(config, name, entry);
  const shown = touched ? [...problems, ...errors] : errors;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problems.length > 0) return;
    onSave(name, entry);
  };

  const fallback = MCP_TOOL_ACTION_LABELS[defaultToolAction(config)];
  return (
    <form
      onSubmit={submit}
      aria-label={`Policy for ${initialName || "a new tool"}`}
      className="mt-3 space-y-3 rounded-lg border border-orange/30 bg-bg-secondary p-3"
    >
      {isNew && (
        <Input
          label="Tool name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="namespace.tool"
          helpText="The public, namespaced name as tools/list publishes it."
        />
      )}
      <Select
        label="Action"
        value={choice}
        onValueChange={setChoice}
        options={[
          { value: DEFAULT_CHOICE, label: `Default (${fallback}, no entry)` },
          { value: "allow", label: MCP_TOOL_ACTION_LABELS.allow },
          { value: "deny", label: MCP_TOOL_ACTION_LABELS.deny },
          { value: "hide_from_discovery", label: MCP_TOOL_ACTION_LABELS.hide_from_discovery },
        ]}
      />
      {choice === "allow" && (
        <>
          <TagInput
            label="Allowed groups"
            values={allowed}
            onChange={(values) => setAllowed(values.map(String))}
            placeholder="Every mapped consumer when empty"
            helpText="A consumer must hold at least one of these acl_groups. Leave empty to admit every consumer the action allows."
            variant="green"
          />
          <TagInput
            label="Denied groups"
            values={denied}
            onChange={(values) => setDenied(values.map(String))}
            placeholder="None"
            helpText="A consumer holding any of these is never granted the tool. Any group requires a gateway-mapped consumer."
            variant="red"
          />
        </>
      )}
      {shown.length > 0 && (
        <ul role="alert" className="list-disc pl-5 text-xs text-danger space-y-1">
          {shown.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={saving}>
          Save policy
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

interface ToolRowViewProps {
  row: McpToolRow;
  config: Record<string, unknown> | undefined;
  editAllowed: boolean;
  editing: boolean;
  noticeId: string | undefined;
  onEdit: () => void;
  editor: ReactNode;
}

function ToolRowView({ row, config, editAllowed, editing, noticeId, onEdit, editor }: ToolRowViewProps) {
  const { tool } = row;
  const groups = rowGroups(row);
  const awaiting = config ? policyAwaitingNode(row, config) : false;
  return (
    <li className="py-3" data-tool={row.name}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="font-mono text-sm text-text-primary break-all">{row.name}</p>
          {tool?.title && <p className="text-sm text-text-secondary">{tool.title}</p>}
          {tool?.description && <p className="text-xs text-text-muted">{tool.description}</p>}
          {tool ? (
            <ToolSource tool={tool} />
          ) : (
            <p className="text-xs text-warning">
              Configured, but not in this node&apos;s catalog.
            </p>
          )}
        </div>
        {!editing && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onEdit}
            disabled={!editAllowed}
            aria-describedby={editAllowed ? undefined : noticeId}
            aria-label={`Edit policy for ${row.name}`}
          >
            Edit policy
          </Button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {tool && <Annotations annotations={tool.annotations} />}
        <span className="text-xs text-text-muted">
          Configured:{" "}
          <span className="text-text-secondary">{configuredSummary(row, config)}</span>
        </span>
        {tool && (
          <Badge variant={EFFECTIVE_VARIANTS[tool.policy.effective]}>
            {EFFECTIVE_LABELS[tool.policy.effective]}
          </Badge>
        )}
        {tool && (
          <span className="text-xs text-text-muted">
            {tool.policy.listed ? "Listed" : "Not listed"} ·{" "}
            {tool.policy.callable ? "callable" : "not callable"}
          </span>
        )}
        {awaiting && <Badge variant="yellow">Saved, not yet live on this node</Badge>}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4">
        {groups.allowed === null ? (
          (row.configured?.action === "allow" || (row.configured === undefined && tool?.policy.action === "allow")) && (
            <span className="text-xs text-text-muted">Every consumer the action allows</span>
          )
        ) : (
          <GroupList label="Allowed groups" groups={groups.allowed} />
        )}
        <GroupList label="Denied groups" groups={groups.denied} />
      </div>
      {editing && editor}
    </li>
  );
}

function ServerList({ catalog }: { catalog: McpToolCatalog }) {
  if (catalog.servers.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Servers</h4>
      <ul className="space-y-1.5">
        {catalog.servers.map((server) => (
          <li key={server.server_id} className="text-xs text-text-muted">
            <span className="font-mono text-text-secondary">{server.server_id}</span>
            {" · "}
            {server.kind === "openapi" ? "OpenAPI bridge" : "MCP"} · namespace{" "}
            <span className="font-mono">{server.namespace}</span>
            {server.upstream_url && (
              <>
                {" · "}
                <span className="font-mono break-all">{server.upstream_url}</span>
              </>
            )}
            {" · "}
            <Badge
              variant={
                server.tools_refresh === "ok"
                  ? "green"
                  : server.tools_refresh === "failed"
                    ? "red"
                    : server.tools_refresh === "stale"
                      ? "yellow"
                      : "default"
              }
            >
              {TOOLS_REFRESH_LABELS[server.tools_refresh]}
            </Badge>
            {!server.enabled && <> · disabled</>}
            {server.enabled && !server.expose_tools && <> · tools not exposed</>}
            {server.refresh_error && (
              <p className="text-danger mt-0.5">{server.refresh_error}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface InstanceProps {
  catalog: McpToolCatalog;
  tools: McpToolCatalogTool[];
  capability: CapabilityVerdict;
  role: GatewayRole | null;
  gatewayMode: string | null;
  session: EditorSession;
  enabled: boolean;
}

/** One `mcp_gateway` instance: its catalog state, servers, and tools. */
function McpGatewayInstance({
  catalog,
  tools,
  capability,
  role,
  gatewayMode,
  session,
  enabled,
}: InstanceProps) {
  const { toast } = useToast();
  const pluginQuery = usePluginConfig(catalog.plugin_config_id, enabled);
  const plugin = pluginQuery.data;
  const updatePolicy = useUpdateMcpToolPolicy();
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [editorErrors, setEditorErrors] = useState<string[]>([]);
  const [refusal, setRefusal] = useState<unknown>(null);
  const [conflict, setConflict] = useState<StaleResourceDetail | null>(null);
  const [editorGeneration, setEditorGeneration] = useState(0);

  const config = plugin?.config;
  const rows = useMemo(() => mcpToolRows(tools, config), [tools, config]);
  const masked = useMemo(
    () =>
      plugin
        ? pluginConfigPlaceholderSites(plugin.plugin_name, plugin.config, role).blocking
        : [],
    [plugin, role],
  );
  const aggregate = config !== undefined && mcpGatewayMode(config) === "aggregate_router";
  const editAllowed = capability.allowed && plugin !== undefined && aggregate && masked.length === 0;
  const noticeId = `mcp-policy-notice-${catalog.plugin_config_id}`;
  const provisioner = plugin?.labels?.["provisioned-by"];

  const startEdit = (name: string, isNew: boolean) => {
    if (!plugin) return;
    setEditorErrors([]);
    setRefusal(null);
    // The guard is the entry the operator is looking at now, not a later
    // refetch, so a concurrent change to it is refused rather than reverted.
    setEditing({
      name,
      isNew,
      guard: isNew ? newToolPolicyWriteGuard(name) : toolPolicyWriteGuard(plugin, name),
    });
  };

  const save = session.bind(async (name: string, entry: McpToolPolicyEntry | null) => {
    if (!editing || !plugin) return;
    if (editing.isNew && rows.some((row) => row.name === name)) {
      setEditorErrors([`${name} is already listed; use its Edit policy button.`]);
      return;
    }
    // A new entry is judged against "no entry", so one written meanwhile by
    // someone else is refused rather than overwritten.
    const guard = editing.isNew ? newToolPolicyWriteGuard(name) : editing.guard;
    setEditorErrors([]);
    setRefusal(null);
    try {
      await updatePolicy.mutateAsync({
        pluginId: catalog.plugin_config_id,
        toolName: name,
        entry,
        guard,
      });
      setEditing(null);
      toast("success", `Policy for ${name} saved. The catalog shows it once this node has loaded it.`);
    } catch (err: unknown) {
      if (isStaleResourceError(err)) {
        setConflict(err.detail);
        return;
      }
      const committed = getCommittedWrite(err);
      if (committed) {
        setEditing(null);
        toast("warning", committedWriteMessage(`Policy for ${name} saved`, committed));
        return;
      }
      if (maskedPlaceholderRefusal(err)) {
        setRefusal(err);
        return;
      }
      if (err instanceof McpToolPolicyError) {
        setEditorErrors([err.message]);
        return;
      }
      toast("error", await getApiErrorMessage(err, "Failed to save the tool policy"));
    }
  });

  const discardAndReload = async () => {
    setConflict(null);
    setEditing(null);
    await pluginQuery.refetch();
    setEditorGeneration((generation) => generation + 1);
  };

  const editorFor = (row: McpToolRow) =>
    editing !== null && config && editing.name === row.name && !editing.isNew ? (
      <ToolPolicyEditor
        key={`${row.name}-${editorGeneration}`}
        name={row.name}
        isNew={false}
        initial={row.configured ?? null}
        config={config}
        saving={updatePolicy.isPending}
        errors={editorErrors}
        onSave={(name, entry) => void save(name, entry)}
        onCancel={() => setEditing(null)}
      />
    ) : null;

  return (
    <Card role="region" aria-label={`mcp_gateway ${catalog.plugin_config_id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">
            mcp_gateway{" "}
            <Link
              to="/plugins/$pluginId"
              params={{ pluginId: catalog.plugin_config_id }}
              className="font-mono text-xs text-orange hover:text-orange-light break-all"
            >
              {catalog.plugin_config_id}
            </Link>
          </h3>
          {catalog.endpoint_path && (
            <p className="text-xs text-text-muted">
              Endpoint <span className="font-mono">{catalog.endpoint_path}</span>
              {catalog.mode ? ` · ${catalog.mode}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={STATE_VARIANTS[catalog.catalog_state]}>
            {CATALOG_STATE_LABELS[catalog.catalog_state]}
          </Badge>
          {catalog.enabled === false && <Badge variant="red">config.enabled: false</Badge>}
        </div>
      </div>

      <p className="mt-2 text-sm text-text-secondary" data-catalog-state={catalog.catalog_state}>
        {catalogStateExplanation(catalog.catalog_state, gatewayMode)}
      </p>
      <p className="mt-1 text-xs text-text-muted">
        Tools refreshed {formatDateTime(catalog.refreshed_at, "never on this node")}
        {catalog.cache_ttl_seconds !== undefined && ` · cache TTL ${catalog.cache_ttl_seconds}s`}
        {catalog.catalog_version != null && ` · catalog version ${catalog.catalog_version}`}
        {catalog.cached_sessions !== undefined && ` · ${catalog.cached_sessions} cached session(s)`}
      </p>
      {catalog.policy && catalog.discovery && (
        <p className="mt-1 text-xs text-text-muted">
          Default action {catalog.policy.default_action} · denied tools{" "}
          {catalog.policy.hide_denied_tools ? "hidden" : "listed"} · new tools{" "}
          {catalog.discovery.on_new_tool === "hide_until_configured" ? "hidden until configured" : "allowed"}{" "}
          · changed schemas{" "}
          {catalog.discovery.on_schema_change === "hide_until_configured" ? "hidden until configured" : "allowed"}
        </p>
      )}
      {catalog.tools_unavailable && (
        <p className="mt-2 text-sm text-danger" role="alert">
          Every upstream failed its tools/list with no last good catalog, so agents get JSON-RPC
          -32006 from tools/list.
        </p>
      )}

      <div className="mt-4 space-y-3">
        <ServerList catalog={catalog} />

        <ReadStateNotice query={pluginQuery} label="mcp_gateway configuration" />

        <div id={noticeId} className="space-y-2">
          <CapabilityNotice verdict={capability} />
          {plugin && !aggregate && (
            <p className="text-xs text-text-muted">
              Tool policy applies only to an aggregate_router instance.
            </p>
          )}
          {plugin && capability.allowed && aggregate && masked.length > 0 && (
            <div role="status" className="rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
              <p className="text-sm font-medium text-warning">Tool policy cannot be saved by your role</p>
              <p className="text-xs text-text-muted mt-1">
                This configuration has values hidden from your role ({masked.join(", ")}). A
                policy save resends the whole configuration, and Ferrum Edge refuses those
                placeholders. Re-enter or clear them on the{" "}
                <Link
                  to="/plugins/$pluginId"
                  params={{ pluginId: catalog.plugin_config_id }}
                  className="text-orange hover:text-orange-light"
                >
                  plugin page
                </Link>{" "}
                first (clearing deletes the stored secret), or have an admin make the change.
              </p>
            </div>
          )}
        </div>
        {provisioner && (
          <p className="text-xs text-text-muted">
            Provisioned by {PROVISIONERS[provisioner] ?? provisioner}. A policy save keeps that
            label; if {PROVISIONERS[provisioner] ?? provisioner} still manages this configuration, it
            may replace a change made here.
          </p>
        )}
        {plugin && plugin.scope !== "proxy" && (
          <p className="text-xs text-text-muted">
            This is a {plugin.scope === "global" ? "global" : "proxy-group"} configuration: a
            policy change applies to every proxy it runs on.
          </p>
        )}

        <MaskedSecretRefusal error={refusal} />

        {rows.length === 0 ? (
          <p className="text-sm text-text-muted">
            {catalog.catalog_state === "unmediated"
              ? "No tools: this instance has no catalog."
              : "No tools on this node, and the configuration names none."}
          </p>
        ) : (
          <ul className="divide-y divide-border/50" aria-label="Tools">
            {rows.map((row) => (
              <ToolRowView
                key={row.name}
                row={row}
                config={config}
                editAllowed={editAllowed && editing === null}
                editing={editing !== null && editing.name === row.name && !editing.isNew}
                noticeId={editAllowed ? undefined : noticeId}
                onEdit={() => startEdit(row.name, false)}
                editor={editorFor(row)}
              />
            ))}
          </ul>
        )}

        {editing?.isNew && config ? (
          <ToolPolicyEditor
            key={`new-${editorGeneration}`}
            name=""
            isNew
            initial={null}
            config={config}
            saving={updatePolicy.isPending}
            errors={editorErrors}
            onSave={(name, entry) => void save(name, entry)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          aggregate && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => startEdit("", true)}
              disabled={!editAllowed || editing !== null}
              aria-describedby={editAllowed ? undefined : noticeId}
            >
              Add a tool policy by name
            </Button>
          )
        )}
      </div>

      <StaleWriteDialog
        conflict={conflict}
        onKeepEditing={() => setConflict(null)}
        onDiscardAndReload={() => void discardAndReload()}
      />
    </Card>
  );
}

interface McpToolsPanelProps {
  proxyId: string;
  /** False until the Tools tab is opened, and while the proxy is being deleted. */
  enabled: boolean;
  session: EditorSession;
  /** Rendered once the proxy is known to have `mcp_gateway`. */
  governance?: ReactNode;
}

export function McpToolsPanel({ proxyId, enabled, session, governance }: McpToolsPanelProps) {
  const query = useMcpToolCatalog(proxyId, enabled);
  const { capabilities, facts } = useCapabilities();
  const response = query.data;

  return (
    <ReadState queries={[query]} label="MCP tool catalog">
      {response === null ? (
        <Card>
          <div className="text-center py-8 space-y-2">
            <p className="text-text-secondary">No enabled mcp_gateway plugin applies to this proxy.</p>
            <p className="text-text-muted text-sm">
              Attach an mcp_gateway configuration to publish tools to agents through this proxy.
            </p>
            <Link
              to="/plugins/new"
              className="inline-block text-orange hover:text-orange-light font-medium transition-colors"
            >
              Create a plugin
            </Link>
          </div>
        </Card>
      ) : response ? (
        <div className="space-y-3">
          <Card padding="compact">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-text-secondary">
                {response.data.length} tool{response.data.length === 1 ? "" : "s"} cached on this
                gateway node · refreshed {formatDateTime(response.refreshed_at, "never")}
                {response.stale ? " · stale" : ""}
              </p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                loading={query.isFetching}
                onClick={() => void query.refetch()}
              >
                Reload catalog
              </Button>
            </div>
            <p className="text-xs text-text-muted mt-1">
              Read from the catalog this node already cached: Ferrum Edge never contacts an
              upstream or starts a refresh for this view. The catalog is node-local, and an
              upstream that tailors tools per principal shows one session&apos;s view.
            </p>
          </Card>
          {governance}
          {response.catalogs.map((catalog) => (
            <McpGatewayInstance
              key={catalog.plugin_config_id}
              catalog={catalog}
              tools={response.data.filter(
                (tool) => tool.plugin_config_id === catalog.plugin_config_id,
              )}
              capability={capabilities.pluginConfigs}
              role={facts.role}
              gatewayMode={facts.mode}
              session={session}
              enabled={enabled}
            />
          ))}
        </div>
      ) : null}
    </ReadState>
  );
}
