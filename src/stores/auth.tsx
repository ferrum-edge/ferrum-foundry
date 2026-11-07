import { useQueryClient } from "@tanstack/react-query";
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
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
import { clearGatewayMetadata, setNamespaceScopedSession } from "@/api/gatewayMetadata";

export type AuthMode = "static" | "trusted-proxy";

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

/** A session read in flight, with the ticket and abort controller it was sent under. */
interface SessionRead {
  ticket: number;
  controller: AbortController;
  response: Promise<SessionResponse>;
}

const CONFIG_FAILURE = "Unable to load the Foundry authentication configuration.";
const SESSION_FAILURE = "Unable to verify your Foundry session.";
const LOGIN_REJECTED = "The token was rejected.";
const SIGN_OUT_FAILURE = "Sign out could not be confirmed by the server. Please try again.";

/**
 * The browser's view of its Foundry session: exactly one of these at a time.
 *
 * - `loading`: the authentication configuration (and the boot session read)
 *   have not answered. The sign-in mode is unknown, so no sign-in form shows.
 * - `configFailed`: the configuration could not be loaded. The mode is still
 *   unknown, so the only action is `retry`, never the development-token form.
 * - `unauthenticated`: no session; `mode` picks the sign-in page. `error` is
 *   the failure of the last sign-in step only, and is cleared on every
 *   transition.
 * - `authenticated`: a verified principal. `signOutError` reports a sign-out
 *   the BFF did not confirm (the session is kept).
 * - `lockedOut`: the BFF refused authentication from this address after
 *   repeated failures (a `429`). A tab that was signed in keeps its
 *   `principal` and workspace, and shows the lockout over it.
 */
export type AuthSession =
  | { status: "loading" }
  | { status: "configFailed"; error: string; retry: () => void }
  | { status: "unauthenticated"; mode: AuthMode; loginUrl?: string; error: string | null }
  | { status: "authenticated"; mode: AuthMode; principal: AuthPrincipal; signOutError: string | null }
  | {
    status: "lockedOut";
    mode: AuthMode;
    loginUrl?: string;
    principal: AuthPrincipal | null;
    lockout: string;
    signOutError: string | null;
  };

export type AuthStatus = AuthSession["status"];

interface AuthContextValue {
  session: AuthSession;
  /**
   * The principal whose workspace is open: the authenticated one, or the one
   * a locked-out tab was signed in as. `null` in every other state.
   */
  principal: AuthPrincipal | null;
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

// The reducer's state is the session without its callbacks, plus the loaded
// configuration (whose mode it projects) once the mode is known.
type AuthState =
  | { status: "loading" }
  | { status: "configFailed"; error: string }
  | { status: "unauthenticated"; config: AuthConfig; error: string | null }
  | { status: "authenticated"; config: AuthConfig; principal: AuthPrincipal; signOutError: string | null }
  | {
    status: "lockedOut";
    config: AuthConfig;
    principal: AuthPrincipal | null;
    lockout: string;
    signOutError: string | null;
  };

/**
 * Events that move the session. One that would need a sign-in mode the state
 * does not know (a sign-out or failure before the configuration has loaded)
 * leaves the state unchanged: the boot sequence decides once it has the mode.
 * A `config` on an event is the configuration boot just loaded.
 */
type AuthEvent =
  | { type: "configFailed" }
  | { type: "retry" }
  | { type: "configLoaded"; config: AuthConfig }
  | { type: "sessionAccepted"; principal: AuthPrincipal; config?: AuthConfig }
  | { type: "signedOut"; config?: AuthConfig }
  | { type: "lockedOut"; lockout: string; config?: AuthConfig }
  | { type: "verificationFailed"; config?: AuthConfig }
  | { type: "loginStarted" }
  | { type: "loginFailed"; error: string }
  | { type: "signOutStarted" }
  | { type: "signOutFailed"; error: string };

function configOf(state: AuthState): AuthConfig | null {
  return state.status === "loading" || state.status === "configFailed" ? null : state.config;
}

function principalOf(state: AuthState): AuthPrincipal | null {
  return state.status === "authenticated" || state.status === "lockedOut" ? state.principal : null;
}

function authReducer(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "configFailed":
      // Only boot reports this, and newer evidence (a sign-in) stands.
      return state.status === "loading" ? { status: "configFailed", error: CONFIG_FAILURE } : state;
    case "retry":
      return state.status === "configFailed" ? { status: "loading" } : state;
    case "configLoaded":
      if (state.status === "loading") return { status: "unauthenticated", config: event.config, error: null };
      if (state.status === "configFailed") return state;
      return { ...state, config: event.config };
    case "sessionAccepted": {
      // A session names its own mode, so it can be accepted before the
      // configuration has loaded (a sign-in sent meanwhile).
      const config = event.config ?? configOf(state) ?? { mode: event.principal.authMode };
      return { status: "authenticated", config, principal: event.principal, signOutError: null };
    }
    case "signedOut": {
      const config = event.config ?? configOf(state);
      return config ? { status: "unauthenticated", config, error: null } : state;
    }
    case "lockedOut": {
      const config = event.config ?? configOf(state);
      if (!config) return state;
      return {
        status: "lockedOut",
        config,
        principal: principalOf(state),
        lockout: event.lockout,
        signOutError: null,
      };
    }
    case "verificationFailed": {
      // A transient failure keeps a signed-in workspace (and a lockout, which
      // is newer than any answer this read could replace).
      if (state.status === "authenticated" || state.status === "lockedOut") return state;
      const config = event.config ?? configOf(state);
      return config ? { status: "unauthenticated", config, error: SESSION_FAILURE } : state;
    }
    case "loginStarted":
      return state.status === "unauthenticated" ? { ...state, error: null } : state;
    case "loginFailed":
      if (state.status === "unauthenticated" || (state.status === "lockedOut" && !state.principal)) {
        return { status: "unauthenticated", config: state.config, error: event.error };
      }
      return state;
    case "signOutStarted":
      return (state.status === "authenticated" || state.status === "lockedOut") && state.signOutError
        ? { ...state, signOutError: null }
        : state;
    case "signOutFailed":
      return state.status === "authenticated" || (state.status === "lockedOut" && state.principal)
        ? { ...state, signOutError: event.error }
        : state;
  }
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

/**
 * The operator-facing message for a BFF authentication lockout (`429` after
 * repeated failed sign-ins from this address), or `undefined` for any other
 * error. A lockout is not a wrong token: the right one is refused too until
 * the Retry-After delay passes.
 */
export function lockoutMessage(error: unknown): string | undefined {
  if (responseStatus(error) !== 429) return undefined;
  const response = (error as { response?: Response }).response;
  // Only the BFF's own refusal is a lockout. A 429 from anything in front of
  // it (the starter's proxy caps concurrent API requests) is a transient
  // verification failure, not a sign-in problem.
  if (response?.headers.get("x-ferrum-auth-layer") !== "bff") return undefined;
  const seconds = Number(response?.headers.get("retry-after"));
  const wait = !Number.isFinite(seconds) || seconds <= 0
    ? "later"
    : seconds < 60
      ? `in ${Math.ceil(seconds)} seconds`
      : `in ${Math.ceil(seconds / 60)} minutes`;
  return `Too many failed sign-in attempts from this address. Try again ${wait}.`;
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
  const [state, dispatch] = useReducer(authReducer, { status: "loading" });
  const principalRef = useRef<AuthPrincipal | null>(null);
  // Request ticket of the newest evidence this provider has published. A
  // session read, or another request's BFF 401, may change the session only if
  // it was sent after that evidence; otherwise it is an older answer arriving
  // late (#435).
  const appliedTicketRef = useRef(0);
  const disposedRef = useRef(false);
  const readsRef = useRef(new Set<AbortController>());
  // Ticket of the boot session read, whose BFF 401 the client must not publish.
  const bootReadTicketRef = useRef(0);
  // Each boot (the first, and every configuration retry) takes a generation;
  // only the newest one, in a mounted provider, may publish.
  const bootGenerationRef = useRef(0);

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
      bootGenerationRef.current += 1;
      retireInFlight();
    };
  }, [retireInFlight]);

  const clearLocalSession = useCallback((config?: AuthConfig) => {
    if (disposedRef.current) return;
    setCsrfToken(null);
    principalRef.current = null;
    queryClient.clear();
    clearGatewayMetadata();
    setNamespaceScopedSession(false);
    dispatch({ type: "signedOut", config });
  }, [queryClient]);

  const acceptSession = useCallback((session: SessionResponse, config?: AuthConfig) => {
    if (disposedRef.current) return;
    const previous = principalRef.current;
    if (previous && authorizationKey(previous) !== authorizationKey(session.principal)) {
      queryClient.clear();
    }
    if (!previous || authorizationKey(previous) !== authorizationKey(session.principal)) {
      clearGatewayMetadata();
    }
    setNamespaceScopedSession(session.principal.namespaces !== undefined);
    principalRef.current = session.principal;
    setCsrfToken(session.csrfToken, session.csrfCookie);
    dispatch({ type: "sessionAccepted", principal: session.principal, config });
  }, [queryClient]);

  // Send a session read under a fresh ticket. Its outcome is applied separately
  // (`applySessionRead`), so the boot sequence can send it alongside the config read.
  const startSessionRead = useCallback((): SessionRead => {
    const ticket = issueRequestTicket();
    const controller = new AbortController();
    readsRef.current.add(controller);
    const response = api
      .get("api/auth/session", {
        signal: controller.signal,
        context: { [SILENT_ERRORS]: true, [REQUEST_TICKET]: ticket },
      })
      .json<SessionResponse>()
      .finally(() => readsRef.current.delete(controller));
    return { ticket, controller, response };
  }, []);

  // Apply a session read's outcome. Boot passes the configuration it loaded,
  // which also leaves `loading` when newer evidence superseded the read.
  const applySessionRead = useCallback(
    (read: SessionRead, outcome: PromiseSettledResult<SessionResponse>, config?: AuthConfig) => {
      const { ticket, controller } = read;
      if (controller.signal.aborted || !isCurrent(ticket)) {
        if (config && !disposedRef.current) dispatch({ type: "configLoaded", config });
        return;
      }
      if (outcome.status === "fulfilled") {
        appliedTicketRef.current = ticket;
        acceptSession(outcome.value, config);
        return;
      }
      const sessionError: unknown = outcome.reason;
      const lockedOut = lockoutMessage(sessionError);
      if (responseStatus(sessionError) === 401) {
        appliedTicketRef.current = ticket;
        clearLocalSession(config);
      } else if (lockedOut) {
        // Newer evidence than any answer still in flight: an older 401 or
        // session read must not clear the workspace or the notice after it.
        appliedTicketRef.current = ticket;
        dispatch({ type: "lockedOut", lockout: lockedOut, config });
      } else {
        dispatch({ type: "verificationFailed", config });
      }
    },
    [acceptSession, clearLocalSession, isCurrent],
  );

  const refreshSession = useCallback(async () => {
    const read = startSessionRead();
    const [outcome] = await Promise.allSettled([read.response]);
    applySessionRead(read, outcome);
  }, [applySessionRead, startSessionRead]);

  const boot = useCallback(() => {
    const generation = ++bootGenerationRef.current;
    const live = () => !disposedRef.current && generation === bootGenerationRef.current;
    void (async () => {
      // The session read uses nothing from the config: the BFF path is fixed,
      // a GET carries no CSRF header, and `/api/auth/config` sets no cookie or
      // state. So both are sent at once. Nothing from the session read is
      // published until the config has loaded (its BFF 401 included; see
      // `handleUnauthorized`), and a config failure discards it.
      const configRead = api.get("api/auth/config", {
        context: { [SILENT_ERRORS]: true },
      }).json<AuthConfig>();
      const read = startSessionRead();
      bootReadTicketRef.current = read.ticket;
      const sessionOutcome = Promise.allSettled([read.response]);
      let config: AuthConfig;
      try {
        config = await configRead;
      } catch {
        read.controller.abort();
        // The mode is unknown: no sign-in form, only a retry. A sign-in
        // published meanwhile stands (the reducer applies this only while loading).
        if (live()) dispatch({ type: "configFailed" });
        return;
      }
      if (!live()) return;
      const [outcome] = await sessionOutcome;
      if (!live()) return;
      applySessionRead(read, outcome, config);
    })();
  }, [applySessionRead, startSessionRead]);

  useEffect(() => {
    removeLegacyCredential();
    boot();
  }, [boot]);

  // The committed state, for `retry`: a stale `configFailed` session object
  // must not restart boot once the session has moved on.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const retry = useCallback(() => {
    if (stateRef.current.status !== "configFailed") return;
    stateRef.current = { status: "loading" };
    dispatch({ type: "retry" });
    boot();
  }, [boot]);

  const principal = principalOf(state);
  const signedIn = principal !== null;

  // A tab with a workspace open keeps checking its session, a locked-out one
  // included: its lockout clears on the next successful check.
  useEffect(() => {
    if (!signedIn) return;
    const timer = window.setInterval(() => void refreshSession(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshSession, signedIn]);

  // The client reports every BFF 401 with the ticket of the request it
  // answered, so a late 401 cannot clear a session accepted after it was sent.
  // The boot session read is the exception: boot applies its outcome itself,
  // after the config, so a 401 cannot show a sign-in form for an unknown mode.
  const handleUnauthorized = useCallback((ticket: number) => {
    if (ticket === bootReadTicketRef.current || !isCurrent(ticket)) return;
    appliedTicketRef.current = ticket;
    clearLocalSession();
  }, [clearLocalSession, isCurrent]);

  useEffect(() => setOnUnauthorized(handleUnauthorized), [handleUnauthorized]);

  const login = useCallback(async (token: string) => {
    dispatch({ type: "loginStarted" });
    let session: SessionResponse;
    try {
      session = await api.post("api/auth/login", {
        json: { token },
        context: { [SILENT_ERRORS]: true },
      }).json<SessionResponse>();
    } catch (loginError) {
      if (!disposedRef.current) {
        const lockedOut = lockoutMessage(loginError);
        dispatch(lockedOut
          ? { type: "lockedOut", lockout: lockedOut }
          : { type: "loginFailed", error: LOGIN_REJECTED });
      }
      throw new Error("Authentication failed", { cause: loginError });
    }
    if (disposedRef.current) return;
    retireInFlight();
    acceptSession(session);
  }, [acceptSession, retireInFlight]);

  const configuredLogoutUrl = configOf(state)?.logoutUrl;
  const logout = useCallback(async () => {
    dispatch({ type: "signOutStarted" });
    let logoutUrl = configuredLogoutUrl;
    try {
      const response = await api.post("api/auth/logout", {
        context: { [SILENT_ERRORS]: true },
      }).json<{ logoutUrl?: string }>();
      logoutUrl = response.logoutUrl ?? logoutUrl;
    } catch {
      // The session may still be live on the BFF: keep it, and say so.
      if (!disposedRef.current) dispatch({ type: "signOutFailed", error: SIGN_OUT_FAILURE });
      return;
    }
    if (!disposedRef.current) {
      retireInFlight();
      clearLocalSession();
    }
    if (logoutUrl) window.location.assign(logoutUrl);
  }, [clearLocalSession, configuredLogoutUrl, retireInFlight]);

  const session = useMemo<AuthSession>(() => {
    switch (state.status) {
      case "loading":
        return state;
      case "configFailed":
        return { status: "configFailed", error: state.error, retry };
      case "unauthenticated":
        return {
          status: "unauthenticated",
          mode: state.config.mode,
          loginUrl: state.config.loginUrl,
          error: state.error,
        };
      case "authenticated":
        return {
          status: "authenticated",
          mode: state.config.mode,
          principal: state.principal,
          signOutError: state.signOutError,
        };
      case "lockedOut":
        return {
          status: "lockedOut",
          mode: state.config.mode,
          loginUrl: state.config.loginUrl,
          principal: state.principal,
          lockout: state.lockout,
          signOutError: state.signOutError,
        };
    }
  }, [retry, state]);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    principal,
    login,
    logout,
    refreshSession,
  }), [login, logout, principal, refreshSession, session]);

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
