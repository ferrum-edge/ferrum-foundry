/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – AI governance on an MCP proxy                     */
/* ------------------------------------------------------------------ */

import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { EffectivePlugin } from "@/lib/effectivePolicy";
import {
  MCP_UNAWARE_GOVERNANCE_WARNING,
  type McpGovernanceControl,
  summarizeMcpGovernance,
  UNGOVERNED_MCP_WARNING,
} from "@/lib/mcpGovernance";

function badgeLabel(control: McpGovernanceControl): string {
  if (control.instances.length === 0) return "Not attached";
  if (control.gap) return "Attached, not MCP-aware";
  if (control.partial) return "Attached, partial";
  return "Attached";
}

function badgeVariant(control: McpGovernanceControl): "default" | "yellow" | "green" {
  if (control.instances.length === 0) return "default";
  return control.gap || control.partial ? "yellow" : "green";
}

/**
 * Which of the recommended agent-facing controls run on this proxy, from its
 * effective plugins (global, proxy, and proxy-group scope, after shadowing),
 * and a warning when none of them governs MCP tool calls.
 */
export function McpGovernanceCard({ plugins }: { plugins: readonly EffectivePlugin[] }) {
  const summary = summarizeMcpGovernance(plugins);
  const warning = !summary.governed
    ? UNGOVERNED_MCP_WARNING
    : !summary.mcpGoverned
      ? MCP_UNAWARE_GOVERNANCE_WARNING
      : null;

  return (
    <Card role="region" aria-label="AI governance">
      <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
        AI governance
      </h3>
      <p className="text-xs text-text-muted mt-1">
        Plugins that run in front of mcp_gateway on this proxy. Everything here sees tool-call
        attempts, including calls the gateway then refuses.
      </p>
      {warning && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-warning"
        >
          {warning}
        </p>
      )}
      <ul className="mt-3 divide-y divide-border/50">
        {summary.controls.map((control) => (
          <li key={control.key} className="py-2.5" data-governance={control.key}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-text-primary">{control.label}</span>
              <Badge variant={badgeVariant(control)}>{badgeLabel(control)}</Badge>
            </div>
            <p className="text-xs text-text-muted mt-0.5">{control.role}</p>
            {control.gap && <p className="text-xs text-warning mt-1">{control.gap}</p>}
            {control.instances
              .filter((instance) => instance.mcpAware && instance.partial)
              .map(({ plugin, partial }) => (
                <p key={plugin.id} className="text-xs text-warning mt-1">
                  {plugin.id}: {partial}
                </p>
              ))}
            {control.partial && (
              <p className="text-xs text-warning mt-1">
                No {control.label.toLowerCase()} counts every tool call on{" "}
                {control.uncovered.join(", ")}.
              </p>
            )}
            {control.instances.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-2">
                {control.instances.map(({ plugin, conditional }) => (
                  <Link
                    key={plugin.id}
                    to="/plugins/$pluginId"
                    params={{ pluginId: plugin.id }}
                    className="font-mono text-xs text-orange hover:text-orange-light break-all"
                  >
                    {plugin.id} · {plugin.effectiveSource}
                    {conditional ? " · conditional trigger" : ""}
                  </Link>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-text-muted mt-2">
        Per-tool group grants read the calling consumer&apos;s acl_groups, so they also need an
        authentication plugin; the Consumers tab shows which consumers can reach this proxy.
      </p>
    </Card>
  );
}
