import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { setBearerToken, setOnUnauthorized } from "@/api/client";

interface AuthContextValue {
  token: string | null;
  setToken: (token: string) => void;
  clearToken: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "ferrum:bff-auth-token";

function loadPersistedToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistToken(token: string | null) {
  try {
    if (token) {
      localStorage.setItem(STORAGE_KEY, token);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(loadPersistedToken);

  // Keep the module-scoped ky client in sync with the React-side token.
  useEffect(() => {
    setBearerToken(token);
  }, [token]);

  const setToken = useCallback((next: string) => {
    persistToken(next);
    setTokenState(next);
  }, []);

  const clearToken = useCallback(() => {
    persistToken(null);
    setTokenState(null);
  }, []);

  // Wire the ky 401 handler to clear local auth state.
  useEffect(() => {
    setOnUnauthorized(clearToken);
    return () => setOnUnauthorized(undefined);
  }, [clearToken]);

  const value = useMemo(
    () => ({ token, setToken, clearToken }),
    [token, setToken, clearToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
