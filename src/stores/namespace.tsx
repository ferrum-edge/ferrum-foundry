import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { NamespaceScope } from "@/api/client";
import { useAuth } from "@/stores/auth";

/**
 * Namespace binding rule
 * ----------------------
 * This provider is the single owner of the active namespace for its tab. The
 * value it renders is the value every gateway request from this tab carries:
 * hooks read `scope` from `useNamespace()` when an operation starts and pass
 * it through every request that operation makes (see `NamespaceScope` in
 * `src/api/client.ts`). Nothing on the request path reads storage.
 *
 * `localStorage` holds a *preference* only. It is read once when the provider
 * mounts, so a new tab opens on the namespace last chosen anywhere, and it is
 * written whenever the user switches. Another tab writing that key does not
 * change this tab: `storage` events are deliberately not observed, so a
 * switch elsewhere can neither retarget a request already in flight nor
 * move a page the operator is looking at out from under them. The other
 * tab's choice takes effect here only on the next load.
 *
 * When storage is unavailable (private mode, a throwing accessor, quota),
 * the provider simply runs on React state from `DEFAULT_NAMESPACE`; the
 * displayed namespace and the request header still come from the same
 * value, so they cannot diverge.
 */

interface NamespaceContextValue {
  selectedNamespace: string;
  setNamespace: (ns: string) => void;
  /**
   * The current selection as an immutable binding. Capture it when an
   * operation starts and pass it to the API layer; the object identity only
   * changes when the namespace does.
   */
  scope: NamespaceScope;
}

const NamespaceContext = createContext<NamespaceContextValue | null>(null);

export const NAMESPACE_STORAGE_KEY = "ferrum:namespace";
export const DEFAULT_NAMESPACE = "ferrum";

function loadPersistedNamespace(): string {
  try {
    const stored = localStorage.getItem(NAMESPACE_STORAGE_KEY);
    return stored && stored.length > 0 ? stored : DEFAULT_NAMESPACE;
  } catch {
    return DEFAULT_NAMESPACE;
  }
}

function persistNamespace(ns: string) {
  try {
    localStorage.setItem(NAMESPACE_STORAGE_KEY, ns);
  } catch {
    // Storage is a preference, not the source of truth; React state still
    // drives every request when it cannot be written.
  }
}

export function NamespaceProvider({ children }: { children: ReactNode }) {
  const { principal } = useAuth();
  const [selectedNamespace, setSelectedNamespace] = useState<string>(
    loadPersistedNamespace,
  );

  const setNamespace = useCallback((ns: string) => {
    persistNamespace(ns);
    setSelectedNamespace(ns);
  }, []);

  useEffect(() => {
    if (!principal?.namespaces?.length || principal.namespaces.includes(selectedNamespace)) return;
    const firstAllowed = principal.namespaces[0];
    persistNamespace(firstAllowed);
    setSelectedNamespace(firstAllowed);
  }, [principal, selectedNamespace]);

  const value = useMemo<NamespaceContextValue>(
    () => ({
      selectedNamespace,
      setNamespace,
      scope: { namespace: selectedNamespace },
    }),
    [selectedNamespace, setNamespace],
  );

  return (
    <NamespaceContext.Provider value={value}>
      {children}
    </NamespaceContext.Provider>
  );
}

export function useNamespace(): NamespaceContextValue {
  const ctx = useContext(NamespaceContext);
  if (!ctx) {
    throw new Error("useNamespace must be used within a NamespaceProvider");
  }
  return ctx;
}
