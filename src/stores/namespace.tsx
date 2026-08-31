import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/stores/auth";

interface NamespaceContextValue {
  selectedNamespace: string;
  setNamespace: (ns: string) => void;
}

const NamespaceContext = createContext<NamespaceContextValue | null>(null);

const STORAGE_KEY = "ferrum:namespace";

function loadPersistedNamespace(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "ferrum";
  } catch {
    return "ferrum";
  }
}

function persistNamespace(ns: string) {
  try {
    localStorage.setItem(STORAGE_KEY, ns);
  } catch {
    // ignore storage errors
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

  return (
    <NamespaceContext.Provider value={{ selectedNamespace, setNamespace }}>
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
