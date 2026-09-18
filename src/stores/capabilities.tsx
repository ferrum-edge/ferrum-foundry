/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – capability provider                               */
/*                                                                     */
/*  Joins the two facts the UI already reads — the session principal's */
/*  role and the authenticated gateway health snapshot — into the      */
/*  per-surface capability model in `src/lib/capabilities.ts`.         */
/*                                                                     */
/*  One health read serves the whole workspace. A failed or            */
/*  still-loading read is not evidence of anything: the mode, the      */
/*  write flag, and the health status stay `null`, every surface stays */
/*  enabled, and the gateway keeps answering for itself. The same      */
/*  permissive default applies outside the provider, so a surface      */
/*  never claims a denial it has not observed.                         */
/*                                                                     */
/*  The last snapshot that actually loaded is retained for the life of */
/*  the provider. A gateway's mode and write policy are set at start-  */
/*  up, so a past observation of them stays true for this session,     */
/*  while an errored background refetch is no reason to hand a user a  */
/*  form that flips from read-only to editable and back again.         */
/* ------------------------------------------------------------------ */

import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useHealth } from "@/hooks/useMetrics";
import {
  isGatewayRole,
  resolveCapabilities,
  type CapabilityFacts,
  type CapabilitySet,
} from "@/lib/capabilities";
import { resolveReadState } from "@/lib/readState";
import { useAuth } from "@/stores/auth";

export interface CapabilityContextValue {
  capabilities: CapabilitySet;
  /** The facts the verdicts were derived from, for notices and tests. */
  facts: CapabilityFacts;
}

const NOTHING_KNOWN: CapabilityFacts = {
  role: null,
  mode: null,
  adminWritesEnabled: null,
  status: null,
};

const PERMISSIVE: CapabilityContextValue = {
  capabilities: resolveCapabilities(NOTHING_KNOWN),
  facts: NOTHING_KNOWN,
};

const CapabilityContext = createContext<CapabilityContextValue | null>(null);

export function CapabilityProvider({ children }: { children: ReactNode }) {
  const { principal } = useAuth();
  const healthQuery = useHealth();

  // Only a `loaded` read contributes gateway facts; a stale or errored refetch
  // contributes nothing new. What it observed last, however, is kept: the mode
  // and the write policy do not change without a gateway restart, and a
  // transient `/health` failure must not silently re-enable a surface the
  // gateway is still refusing.
  const observed = useRef<{
    mode: string | null;
    adminWritesEnabled: boolean | null;
    status: string | null;
  }>({
    mode: null,
    adminWritesEnabled: null,
    status: null,
  });
  const health = resolveReadState(healthQuery) === "loaded" ? healthQuery.data : undefined;
  if (health) {
    observed.current = {
      mode: typeof health.mode === "string" ? health.mode : null,
      adminWritesEnabled:
        typeof health.admin_writes_enabled === "boolean" ? health.admin_writes_enabled : null,
      status: typeof health.status === "string" ? health.status : null,
    };
  }
  const { mode, adminWritesEnabled, status } = observed.current;
  // `principal.role` arrives over the network, so it is validated rather than
  // trusted: an off-enum role is `null` and concludes nothing.
  const sessionRole: unknown = principal?.role;
  const role = isGatewayRole(sessionRole) ? sessionRole : null;

  const value = useMemo<CapabilityContextValue>(() => {
    const facts: CapabilityFacts = { role, mode, adminWritesEnabled, status };
    return { capabilities: resolveCapabilities(facts), facts };
  }, [adminWritesEnabled, mode, role, status]);

  return <CapabilityContext.Provider value={value}>{children}</CapabilityContext.Provider>;
}

/**
 * Per-surface write capabilities for the current session and gateway.
 *
 * Outside a `CapabilityProvider` nothing has been observed, so every surface
 * is reported available and server-side authorization remains the only
 * enforcement — the same answer the provider gives before its first read.
 */
export function useCapabilities(): CapabilityContextValue {
  return useContext(CapabilityContext) ?? PERMISSIVE;
}
