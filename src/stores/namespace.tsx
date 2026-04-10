import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

interface NamespaceState {
  selectedNamespace: string;
  namespaces: string[];
  isLoaded: boolean;
}

interface NamespaceContextValue extends NamespaceState {
  setNamespace: (ns: string) => void;
  setNamespaces: (list: string[]) => void;
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
  const [state, setState] = useState<NamespaceState>({
    selectedNamespace: loadPersistedNamespace(),
    namespaces: [],
    isLoaded: false,
  });

  const setNamespace = useCallback((ns: string) => {
    persistNamespace(ns);
    setState((prev) => ({ ...prev, selectedNamespace: ns }));
  }, []);

  const setNamespaces = useCallback((list: string[]) => {
    setState((prev) => ({ ...prev, namespaces: list, isLoaded: true }));
  }, []);

  return (
    <NamespaceContext.Provider
      value={{ ...state, setNamespace, setNamespaces }}
    >
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
