import { useQueryClient } from "@tanstack/react-query";
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
import { api, setCsrfToken, setOnUnauthorized, SILENT_ERRORS } from "@/api/client";

export type AuthMode = "static" | "trusted-proxy";
export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthPrincipal {
  subject: string;
  displayName: string;
  role: "viewer" | "operator" | "admin";
  namespaces?: string[];
  authMode: AuthMode;
}

interface AuthConfig {
  mode: AuthMode;
  loginUrl?: string;
  logoutUrl?: string;
}

interface SessionResponse {
  principal: AuthPrincipal;
  csrfToken: string;
  expiresAt?: number;
  logoutUrl?: string;
}

interface AuthContextValue {
  status: AuthStatus;
  mode: AuthMode | null;
  principal: AuthPrincipal | null;
  loginUrl?: string;
  error: string | null;
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function removeLegacyCredential(): void {
  try {
    localStorage.removeItem("ferrum:bff-auth-token");
  } catch {
    // Storage can be disabled. No credential is written by the new flow.
  }
}

function responseStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("response" in error)) return undefined;
  const response = (error as { response?: Response }).response;
  return response?.status;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [principal, setPrincipal] = useState<AuthPrincipal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const principalRef = useRef<AuthPrincipal | null>(null);

  const clearLocalSession = useCallback(() => {
    setCsrfToken(null);
    principalRef.current = null;
    setPrincipal(null);
    setStatus("unauthenticated");
    queryClient.clear();
  }, [queryClient]);

  const acceptSession = useCallback((session: SessionResponse) => {
    const previous = principalRef.current;
    if (previous && previous.subject !== session.principal.subject) queryClient.clear();
    principalRef.current = session.principal;
    setPrincipal(session.principal);
    setCsrfToken(session.csrfToken);
    setStatus("authenticated");
    setError(null);
  }, [queryClient]);

  const refreshSession = useCallback(async () => {
    try {
      const session = await api.get("api/auth/session", {
        context: { [SILENT_ERRORS]: true },
      }).json<SessionResponse>();
      acceptSession(session);
    } catch (sessionError) {
      if (responseStatus(sessionError) === 401) {
        clearLocalSession();
      } else if (principalRef.current) {
        setError("Session verification is temporarily unavailable.");
      } else {
        setError("Unable to verify your Foundry session.");
        setStatus("unauthenticated");
      }
    }
  }, [acceptSession, clearLocalSession]);

  useEffect(() => {
    removeLegacyCredential();
    let cancelled = false;
    void (async () => {
      try {
        const nextConfig = await api.get("api/auth/config", {
          context: { [SILENT_ERRORS]: true },
        }).json<AuthConfig>();
        if (cancelled) return;
        setConfig(nextConfig);
        await refreshSession();
      } catch {
        if (!cancelled) {
          setError("Unable to load the Foundry authentication configuration.");
          setStatus("unauthenticated");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [refreshSession]);

  useEffect(() => {
    if (status !== "authenticated") return;
    const timer = window.setInterval(() => void refreshSession(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshSession, status]);

  useEffect(() => {
    setOnUnauthorized(clearLocalSession);
    return () => setOnUnauthorized(undefined);
  }, [clearLocalSession]);

  const login = useCallback(async (token: string) => {
    setError(null);
    try {
      const session = await api.post("api/auth/login", {
        json: { token },
        context: { [SILENT_ERRORS]: true },
      }).json<SessionResponse>();
      acceptSession(session);
    } catch {
      setError("The token was rejected.");
      throw new Error("Authentication failed");
    }
  }, [acceptSession]);

  const logout = useCallback(async () => {
    let logoutUrl = config?.logoutUrl;
    try {
      const response = await api.post("api/auth/logout", {
        context: { [SILENT_ERRORS]: true },
      }).json<{ logoutUrl?: string }>();
      logoutUrl = response.logoutUrl ?? logoutUrl;
      clearLocalSession();
    } catch {
      setError("Sign out could not be confirmed by the server. Please try again.");
      return;
    }
    if (logoutUrl) window.location.assign(logoutUrl);
  }, [clearLocalSession, config?.logoutUrl]);

  const value = useMemo<AuthContextValue>(() => ({
    status,
    mode: config?.mode ?? null,
    principal,
    loginUrl: config?.loginUrl,
    error,
    login,
    logout,
    refreshSession,
  }), [config, error, login, logout, principal, refreshSession, status]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
