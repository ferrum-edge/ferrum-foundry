import { useQueryClient } from "@tanstack/react-query";
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  issueRequestTicket,
  latestRequestTicket,
  REQUEST_TICKET,
  setCsrfToken,
  setOnUnauthorized,
  SILENT_ERRORS,
} from "@/api/client";
import { clearGatewayMetadata } from "@/api/gatewayMetadata";

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
  /** The readable cookie the BFF set to the same value; see `setCsrfToken`. */
  csrfCookie?: string;
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

function authorizationKey(principal: AuthPrincipal | null): string {
  if (!principal) return "anonymous";
  return JSON.stringify([
    principal.subject,
    principal.authMode,
    principal.role,
    principal.namespaces === undefined ? null : [...new Set(principal.namespaces)].sort(),
  ]);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [principal, setPrincipal] = useState<AuthPrincipal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const principalRef = useRef<AuthPrincipal | null>(null);
  // Request ticket of the newest evidence this provider has published. A
  // session read, or another request's BFF 401, may change the session only if
  // it was sent after that evidence; otherwise it is an older answer arriving
  // late (#435).
  const appliedTicketRef = useRef(0);
  const disposedRef = useRef(false);
  const readsRef = useRef(new Set<AbortController>());

  const isCurrent = useCallback(
    (ticket: number) => !disposedRef.current && ticket > appliedTicketRef.current,
    [],
  );

  // A confirmed identity transition (sign-in, sign-out, unmount) retires every
  // request already sent, including one sent while the transition was pending.
  const retireInFlight = useCallback(() => {
    appliedTicketRef.current = Math.max(appliedTicketRef.current, latestRequestTicket());
    for (const controller of readsRef.current) controller.abort();
    readsRef.current.clear();
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      retireInFlight();
    };
  }, [retireInFlight]);

  const clearLocalSession = useCallback(() => {
    if (disposedRef.current) return;
    setCsrfToken(null);
    principalRef.current = null;
    setPrincipal(null);
    setStatus("unauthenticated");
    queryClient.clear();
    clearGatewayMetadata();
  }, [queryClient]);

  const acceptSession = useCallback((session: SessionResponse) => {
    if (disposedRef.current) return;
    const previous = principalRef.current;
    if (previous && authorizationKey(previous) !== authorizationKey(session.principal)) {
      queryClient.clear();
    }
    if (!previous || authorizationKey(previous) !== authorizationKey(session.principal)) {
      clearGatewayMetadata();
    }
    principalRef.current = session.principal;
    setPrincipal(session.principal);
    setCsrfToken(session.csrfToken, session.csrfCookie);
    setStatus("authenticated");
    setError(null);
  }, [queryClient]);

  const refreshSession = useCallback(async () => {
    const ticket = issueRequestTicket();
    const controller = new AbortController();
    readsRef.current.add(controller);
    try {
      const session = await api.get("api/auth/session", {
        signal: controller.signal,
        context: { [SILENT_ERRORS]: true, [REQUEST_TICKET]: ticket },
      }).json<SessionResponse>();
      if (controller.signal.aborted || !isCurrent(ticket)) return;
      appliedTicketRef.current = ticket;
      acceptSession(session);
    } catch (sessionError) {
      if (controller.signal.aborted || !isCurrent(ticket)) return;
      if (responseStatus(sessionError) === 401) {
        appliedTicketRef.current = ticket;
        clearLocalSession();
      } else if (principalRef.current) {
        setError("Session verification is temporarily unavailable.");
      } else {
        setError("Unable to verify your Foundry session.");
        setStatus("unauthenticated");
      }
    } finally {
      readsRef.current.delete(controller);
    }
  }, [acceptSession, clearLocalSession, isCurrent]);

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

  // The client reports every BFF 401 with the ticket of the request it
  // answered, so a late 401 cannot clear a session accepted after it was sent.
  const handleUnauthorized = useCallback((ticket: number) => {
    if (!isCurrent(ticket)) return;
    appliedTicketRef.current = ticket;
    clearLocalSession();
  }, [clearLocalSession, isCurrent]);

  useEffect(() => setOnUnauthorized(handleUnauthorized), [handleUnauthorized]);

  const login = useCallback(async (token: string) => {
    setError(null);
    let session: SessionResponse;
    try {
      session = await api.post("api/auth/login", {
        json: { token },
        context: { [SILENT_ERRORS]: true },
      }).json<SessionResponse>();
    } catch {
      setError("The token was rejected.");
      throw new Error("Authentication failed");
    }
    if (disposedRef.current) return;
    retireInFlight();
    acceptSession(session);
  }, [acceptSession, retireInFlight]);

  const logout = useCallback(async () => {
    let logoutUrl = config?.logoutUrl;
    try {
      const response = await api.post("api/auth/logout", {
        context: { [SILENT_ERRORS]: true },
      }).json<{ logoutUrl?: string }>();
      logoutUrl = response.logoutUrl ?? logoutUrl;
    } catch {
      setError("Sign out could not be confirmed by the server. Please try again.");
      return;
    }
    if (!disposedRef.current) {
      retireInFlight();
      clearLocalSession();
    }
    if (logoutUrl) window.location.assign(logoutUrl);
  }, [clearLocalSession, config?.logoutUrl, retireInFlight]);

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

  return (
    <AuthContext.Provider value={value}>
      <Fragment key={authorizationKey(principal)}>{children}</Fragment>
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
