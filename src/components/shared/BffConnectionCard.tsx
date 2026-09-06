import { Link } from "@tanstack/react-router";
import { useBffReadiness } from "@/hooks/useBffHealth";
import { readinessPresentation } from "@/lib/readiness";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

export function BffConnectionCard() {
  const readiness = useBffReadiness();
  const connection = readinessPresentation(readiness);
  return (
    <Card>
      <h2 className="text-sm font-semibold text-text-primary mb-3">Foundry connection</h2>
      <Badge variant={connection.variant}>{connection.label}</Badge>
      <p className="text-text-secondary text-sm mt-3">
        {connection.status === "unavailable"
          ? "Foundry cannot confirm a usable gateway connection. Check the Admin API, authentication, and connection settings."
          : connection.status === "unknown"
            ? "Checking gateway health and authenticated Admin API access."
            : connection.status === "degraded"
              ? "The gateway is reachable but reports degraded readiness."
              : "Gateway health and authenticated Admin API access are available."}
      </p>
      {connection.status === "unavailable" && (
        <Link to="/settings">
          <Button variant="secondary" size="sm" className="mt-3">Go to Settings</Button>
        </Link>
      )}
    </Card>
  );
}
