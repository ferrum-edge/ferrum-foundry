/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – capability provider                               */
/*                                                                     */
/*  Joins the two facts the UI already reads — the session principal's */
/*  role and the authenticated gateway health snapshot — into the      */
/*  per-surface capability model in `src/lib/capabilities.ts`.         */
/*                                                                     */
/*  One health read serves the whole workspace. A failed or            */
/*  still-loading read is not evidence of anything: the mode and the   */
/*  write flag stay `null`, every surface stays enabled, and the       */
/*  gateway keeps answering for itself. The same permissive default    */
/*  applies outside the provider, so a surface never claims a denial   */
/*  it has not observed.                                               */
/* ------------------------------------------------------------------ */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useHealth } from "@/hooks/useMetrics";
import {
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
};

const PERMISSIVE: CapabilityContextValue = {
  capabilities: resolveCapabilities(NOTHING_KNOWN),
  facts: NOTHING_KNOWN,
};

const CapabilityContext = createContext<CapabilityContextValue | null>(null);

export function CapabilityProvider({ children }: { children: ReactNode }) {
  const { principal } = useAuth();
  const healthQuery = useHealth();

  // A retained response from an errored refetch is a past observation, not the
  // current mode, so only a `loaded` read contributes gateway facts.
  const health = resolveReadState(healthQuery) === "loaded" ? healthQuery.data : undefined;
  const mode = typeof health?.mode === "string" ? health.mode : null;
  const adminWritesEnabled =
    typeof health?.admin_writes_enabled === "boolean" ? health.admin_writes_enabled : null;
  const role = principal?.role ?? null;

  const value = useMemo<CapabilityContextValue>(() => {
    const facts: CapabilityFacts = { role, mode, adminWritesEnabled };
    return { capabilities: resolveCapabilities(facts), facts };
  }, [adminWritesEnabled, mode, role]);

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
