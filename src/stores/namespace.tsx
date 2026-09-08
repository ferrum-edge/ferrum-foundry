import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
 *
 * The preference is never published unfiltered. When the principal carries
 * namespace grants, the value handed to children is resolved against those
 * grants *during render*, so the very first request a child dispatches
 * already carries a namespace the principal holds. Correcting the selection
 * in an effect would be too late: React runs child effects before the
 * parent's, so the subtree would mount, fire its queries under the stored
 * name, and collect a `403 Namespace access denied` from the BFF before the
 * correction ever committed. The same rule covers the remount `AuthProvider`
 * performs on a grant change, where storage still holds the retired name.
 */

interface NamespaceContextValue {
  selectedNamespace: string;
  setNamespace: (ns: string) => void;
  /** Replace only if the provider still selects the mutation's target. */
  replaceNamespaceIfCurrent: (target: string, replacement: string) => void;
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

/**
 * The namespace to publish for a principal: the preference when it is still
 * granted, otherwise the principal's first grant. A principal with no grants
 * (a global admin, or a session whose principal has not loaded yet) is not
 * restricted, so the preference stands.
 */
function resolveGrantedNamespace(
  preferred: string,
  granted: readonly string[] | undefined,
): string {
  if (!granted?.length || granted.includes(preferred)) return preferred;
  return granted[0];
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
  const [preferredNamespace, setPreferredNamespace] = useState<string>(
    loadPersistedNamespace,
  );
  // Resolved during render, so children never observe an ungranted namespace
  // on any render — including the first one, and the first one after the
  // authorization-key remount that follows a grant change.
  const selectedNamespace = resolveGrantedNamespace(
    preferredNamespace,
    principal?.namespaces,
  );
  // Updated synchronously by every selection writer, including before React
  // commits a batched render. Async continuations must not compare snapshots.
  const currentNamespace = useRef(selectedNamespace);

  const setNamespace = useCallback((ns: string) => {
    currentNamespace.current = ns;
    persistNamespace(ns);
    setPreferredNamespace(ns);
  }, []);

  const replaceNamespaceIfCurrent = useCallback((target: string, replacement: string) => {
    if (currentNamespace.current === target) setNamespace(replacement);
  }, [setNamespace]);

  // The published value is already correct; this only retires the ungranted
  // preference so the stored name, the ref every conditional writer compares
  // against, and the context agree from the next commit on.
  useEffect(() => {
    if (selectedNamespace === preferredNamespace) return;
    setNamespace(selectedNamespace);
  }, [preferredNamespace, selectedNamespace, setNamespace]);

  const value = useMemo<NamespaceContextValue>(
    () => ({
      selectedNamespace,
      setNamespace,
      replaceNamespaceIfCurrent,
      scope: { namespace: selectedNamespace },
    }),
    [selectedNamespace, setNamespace, replaceNamespaceIfCurrent],
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
