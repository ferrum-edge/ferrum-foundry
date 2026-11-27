/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – rows without a detail page                         */
/* ------------------------------------------------------------------ */

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { GENERATED_RESOURCE_EXPLANATION, isAddressableResourceId } from "@/lib/resourceId";

/** The marker a list row shows for a resource without a detail page. */
export function GeneratedResourceBadge() {
  return (
    <span title={GENERATED_RESOURCE_EXPLANATION} className="inline-block mt-1">
      <Badge variant="default">gateway-generated</Badge>
    </span>
  );
}

/**
 * What a detail route shows for an ID Edge serves no detail for, instead of
 * sending a read Edge would refuse with `400`.
 */
export function GeneratedResourceNotice({ kind, id }: { kind: string; id: string }) {
  return (
    <Card>
      <h2 className="text-lg font-semibold text-text-primary">{kind} has no detail page</h2>
      <p className="font-mono text-xs text-text-muted mt-1 break-all">{id}</p>
      <p className="text-sm text-text-secondary mt-3">{GENERATED_RESOURCE_EXPLANATION}</p>
    </Card>
  );
}

/** A link to a plugin configuration's page, or plain content when it has none. */
export function PluginDetailLink({
  pluginId,
  className,
  children,
}: {
  pluginId: string;
  className?: string;
  children: ReactNode;
}) {
  if (!isAddressableResourceId(pluginId)) {
    return (
      <div className={className} title={GENERATED_RESOURCE_EXPLANATION} data-generated-resource>
        {children}
      </div>
    );
  }
  return (
    <Link to="/plugins/$pluginId" params={{ pluginId }} className={className}>
      {children}
    </Link>
  );
}
