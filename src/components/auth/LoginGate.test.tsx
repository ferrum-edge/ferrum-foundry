import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "@/stores/auth";
import { api, setCsrfToken, SILENT_ERRORS } from "@/api/client";
import { BasedRequest, button, click, createHarness, fill, settle } from "@/test/__tests__/harness";
import { AuthSessionBanner } from "./AuthSessionBanner";
import { LoginGate } from "./LoginGate";

let ui: ReturnType<typeof createHarness>;
let mode: "static" | "trusted-proxy";
let loginUrl: string | undefined;
let sessionStatus: number;
let configStatus: number;
let logoutStatus: number;
let requests: Request[];
let completeLogin: (response: Response) => void;
let deferSession: boolean;
let lockoutMarked: boolean;
let refusalMarked: boolean;
let completeSession: ((response: Response) => void) | undefined;
let completeProbe: ((response: Response) => void) | undefined;

function session() {
  return Response.json({
    principal: {
      subject: "test-operator", displayName: "Test Operator", role: "admin",
      namespaces: ["tenant-a"], authMode: mode,
    },
    csrfToken: "fixture-csrf",
  });
}

beforeEach(() => {
  mode = "static";
  loginUrl = undefined;
  sessionStatus = 401;
  configStatus = 200;
  logoutStatus = 200;
  deferSession = false;
  lockoutMarked = true;
  refusalMarked = false;
  completeSession = undefined;
  completeProbe = undefined;
  requests = [];
  ui = createHarness();
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("Request", BasedRequest);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/config") {
      return Response.json({ mode, loginUrl }, { status: configStatus });
    }
    if (path === "/api/probe") {
      return new Promise<Response>((resolve) => { completeProbe = resolve; });
    }
    if (path === "/api/auth/session") {
      if (deferSession) {
        return new Promise<Response>((resolve) => { completeSession = resolve; });
      }
      if (sessionStatus === 429) {
        return Response.json(
          { error: "Too many failed authentication attempts" },
          lockoutMarked
            ? { status: 429, headers: { "retry-after": "30", "x-ferrum-auth-layer": "bff" } }
            : { status: 429, headers: { "retry-after": "0" } },
        );
      }
      if (sessionStatus === 200) return session();
      // The BFF marks its own refusal, which the client reports to the auth store.
      const marked = refusalMarked && sessionStatus === 401;
      return Response.json({}, {
        status: sessionStatus,
        headers: marked ? { "x-ferrum-auth-layer": "bff" } : {},
      });
    }
    if (path === "/api/auth/logout") {
      return Response.json({}, { status: logoutStatus });
    }
    if (path === "/api/auth/login") {
      return new Promise<Response>((resolve) => { completeLogin = resolve; });
    }
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  }));
});

afterEach(async () => {
  await ui.dispose();
  setCsrfToken(null);
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function Recheck() {
  const { refreshSession } = useAuth();
  return <button type="button" onClick={() => void refreshSession()}>Recheck</button>;
}

function SignOut() {
  const { logout } = useAuth();
  return <button type="button" onClick={() => void logout()}>Sign out</button>;
}

function Probe() {
  const probe = () => {
    void api.get("api/probe", { context: { [SILENT_ERRORS]: true } }).catch(() => undefined);
  };
  return (
    <>
      <input aria-label="Draft" defaultValue="" />
      <button type="button" onClick={probe}>Probe</button>
    </>
  );
}

async function mount() {
  await ui.render(<AuthProvider><LoginGate><h2>Protected workspace</h2></LoginGate></AuthProvider>);
}

async function submit() {
  await act(async () => {
    ui.host.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

describe("LoginGate session exchange", () => {
  it("shows a loading status until authentication configuration arrives", async () => {
    let resolve!: (response: Response) => void;
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((request) =>
      new URL((request as Request).url).pathname === "/api/auth/config"
        ? new Promise((done) => { resolve = done; })
        : answer(request));
    await mount();
    expect(ui.host.querySelector('[role="status"]')?.textContent).toContain("Checking your session");
    expect(ui.host.textContent).not.toContain("Protected workspace");
    await act(async () => resolve(Response.json({ mode: "static" })));
    await settle(() => expect(ui.host.textContent).toContain("Local development sign in"));
  });

  it("trims and exchanges a token once, keeps it out of storage, and reveals the workspace", async () => {
    await mount();
    await settle(() => expect(ui.host.querySelector("form")).not.toBeNull());
    expect(button("Sign in").disabled).toBe(true);
    const input = ui.host.querySelector("input")!;
    expect(input.type).toBe("password");
    await fill(input, "   ");
    await submit();
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
    await fill(input, "  development-fixture  ");
    await click("Show token");
    expect(input.type).toBe("text");
    await click("Hide token");
    expect(input.type).toBe("password");
    await submit();
    await settle(() => expect(requests.filter((request) => request.method === "POST")).toHaveLength(1));
    expect(button("Sign in").disabled).toBe(true);
    const request = requests.find((entry) => entry.method === "POST")!;
    expect(await request.json()).toEqual({ token: "development-fixture" });
    expect(request.credentials).toBe("same-origin");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    await act(async () => completeLogin(session()));
    await settle(() => expect(ui.host.textContent).toBe("Protected workspace"));
    expect(ui.host.querySelector("input")).toBeNull();
  });

  it("renders a redacted rejection and lets the operator correct and retry the token", async () => {
    await mount();
    await settle(() => expect(ui.host.querySelector("input")).not.toBeNull());
    await fill(ui.host.querySelector("input")!, "rejected-fixture");
    await submit();
    await settle(() => expect(requests.some((request) => request.method === "POST")).toBe(true));
    await act(async () => completeLogin(Response.json({ error: "internal rejection details" }, { status: 401 })));
    await settle(() => expect(ui.host.querySelector('[role="alert"]')?.textContent).toBe("The token was rejected."));
    expect(ui.host.textContent).not.toContain("internal rejection details");
    expect(button("Sign in").disabled).toBe(false);
    await fill(ui.host.querySelector("input")!, "corrected-fixture");
    await submit();
    await settle(() => expect(requests.filter((request) => request.method === "POST")).toHaveLength(2));
    await act(async () => completeLogin(session()));
    await settle(() => expect(ui.host.textContent).toBe("Protected workspace"));
  });

  it("tells a locked-out operator to wait instead of calling the token wrong (#588)", async () => {
    await mount();
    await settle(() => expect(ui.host.querySelector("input")).not.toBeNull());
    await fill(ui.host.querySelector("input")!, "correct-but-locked-out");
    await submit();
    await settle(() => expect(requests.some((request) => request.method === "POST")).toBe(true));
    await act(async () => completeLogin(Response.json(
      { error: "Too many failed authentication attempts" },
      { status: 429, headers: { "retry-after": "120", "x-ferrum-auth-layer": "bff" } },
    )));
    await settle(() => expect(ui.host.querySelector('[role="alert"]')?.textContent)
      .toBe("Too many failed sign-in attempts from this address. Try again in 2 minutes."));
    expect(ui.host.textContent).not.toContain("The token was rejected");
    expect(button("Sign in").disabled).toBe(false);
  });

  it("reports a locked-out trusted-proxy session as a lockout, without retrying it", async () => {
    mode = "trusted-proxy";
    sessionStatus = 429;
    await mount();
    await settle(() => expect(ui.host.querySelector('[role="alert"]')?.textContent)
      .toBe("Too many failed sign-in attempts from this address. Try again in 30 seconds."));
    const sessionReads = requests.filter((request) => new URL(request.url).pathname === "/api/auth/session");
    expect(sessionReads).toHaveLength(1);
    expect(ui.host.textContent).not.toContain("Protected workspace");
  });

  it("shows a lockout over a signed-in workspace without unmounting it", async () => {
    mode = "trusted-proxy";
    sessionStatus = 200;
    await ui.render(
      <AuthProvider><LoginGate><AuthSessionBanner /><h2>Protected workspace</h2><Recheck /></LoginGate></AuthProvider>,
    );
    await settle(() => expect(ui.host.textContent).toContain("Protected workspace"));
    expect(ui.host.querySelector('[role="alert"]')).toBeNull();
    sessionStatus = 429;
    await click("Recheck");
    await settle(() => expect(ui.host.querySelector('[role="alert"]')?.textContent)
      .toContain("Too many failed sign-in attempts from this address. Try again in 30 seconds."));
    expect(ui.host.textContent).toContain("Protected workspace");
    sessionStatus = 200;
    await click("Recheck");
    await settle(() => expect(ui.host.querySelector('[role="alert"]')).toBeNull());
  });

  it("does not call a 429 from in front of the BFF a sign-in lockout", async () => {
    mode = "trusted-proxy";
    sessionStatus = 200;
    await ui.render(
      <AuthProvider><LoginGate><AuthSessionBanner /><h2>Protected workspace</h2><Recheck /></LoginGate></AuthProvider>,
    );
    await settle(() => expect(ui.host.textContent).toContain("Protected workspace"));
    sessionStatus = 429;
    lockoutMarked = false;
    const before = requests.length;
    await click("Recheck");
    // An unmarked 429 is retried like any read, then fails as transient.
    await settle(() => expect(requests.length - before).toBe(3), { timeout: 3_000 });
    await settle(() => expect(ui.host.querySelector('[role="alert"]')).toBeNull());
    expect(ui.host.textContent).toContain("Protected workspace");
  });

  it("lets no older 401 or session read undo a newer lockout", async () => {
    mode = "trusted-proxy";
    sessionStatus = 200;
    await ui.render(
      <AuthProvider>
        <LoginGate><AuthSessionBanner /><h2>Protected workspace</h2><Recheck /><Probe /></LoginGate>
      </AuthProvider>,
    );
    await settle(() => expect(ui.host.textContent).toContain("Protected workspace"));
    const draft = () => ui.host.querySelector<HTMLInputElement>('input[aria-label="Draft"]');
    await fill(draft()!, "unsaved edit");

    // Two answers sent before the lockout: a protected read and a session read.
    await click("Probe");
    await settle(() => expect(completeProbe).toBeDefined());
    deferSession = true;
    await click("Recheck");
    await settle(() => expect(completeSession).toBeDefined());

    // The newer session read reports the lockout.
    deferSession = false;
    sessionStatus = 429;
    await click("Recheck");
    const lockedOut = "Too many failed sign-in attempts from this address. Try again in 30 seconds.";
    await settle(() => expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain(lockedOut));

    // The older answers land afterwards and change nothing.
    await act(async () => completeProbe!(Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "x-ferrum-auth-layer": "bff" } },
    )));
    await act(async () => completeSession!(session()));
    await settle(() => expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain(lockedOut));
    expect(ui.host.textContent).toContain("Protected workspace");
    expect(draft()?.value).toBe("unsaved edit");
  });

  it("accepts an existing trusted-proxy session without a token form", async () => {
    mode = "trusted-proxy";
    sessionStatus = 200;
    await mount();
    await settle(() => expect(ui.host.textContent).toBe("Protected workspace"));
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("rechecks a missing trusted-proxy session", async () => {
    mode = "trusted-proxy";
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Check session again"));
    expect(ui.host.querySelector("input")).toBeNull();
    sessionStatus = 200;
    await click("Check session again");
    await settle(() => expect(ui.host.textContent).toBe("Protected workspace"));
    expect(requests.filter((request) => request.url.endsWith("/session"))).toHaveLength(2);
  });

  it("offers the configured SSO redirect and displays session verification errors", async () => {
    mode = "trusted-proxy";
    loginUrl = "https://identity.example.test/login";
    sessionStatus = 403;
    const assign = vi.fn();
    vi.stubGlobal("window", new Proxy(window, {
      get(target, property) {
        return property === "location" ? { assign } : Reflect.get(target, property, target);
      },
    }));
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Unable to verify your Foundry session."));
    await click("Continue with SSO");
    expect(assign).toHaveBeenCalledExactlyOnceWith(loginUrl);
    expect(ui.host.querySelector("input")).toBeNull();
  });

  it("shows a configuration failure without exposing protected content", async () => {
    configStatus = 403;
    await mount();
    await settle(() => expect(ui.host.textContent).toContain("Unable to load the Foundry authentication configuration."));
    expect(ui.host.textContent).not.toContain("Protected workspace");
  });

  // #656: an SSO deployment whose config read fails must not be offered the
  // development-token form, whose sign-in it would refuse.
  it("offers only a retry when a trusted-proxy deployment's config fails to load", async () => {
    mode = "trusted-proxy";
    loginUrl = "https://identity.example.test/login";
    configStatus = 403;
    refusalMarked = true;
    await mount();
    await settle(() => expect(button("Retry")).toBeTruthy());
    expect(ui.host.querySelector('[role="alert"]')?.textContent)
      .toBe("Unable to load the Foundry authentication configuration.");
    expect(ui.host.querySelector("form")).toBeNull();
    expect(ui.host.querySelector("input")).toBeNull();
    expect(ui.host.textContent).not.toContain("Local development sign in");
    expect(ui.host.textContent).not.toContain("Continue with SSO");
    expect(ui.host.textContent).not.toContain("Protected workspace");

    // The retry reloads the config and shows the deployment's own sign-in.
    configStatus = 200;
    await click("Retry");
    await settle(() => expect(button("Continue with SSO")).toBeTruthy());
    expect(ui.host.querySelector("input")).toBeNull();
    expect(ui.host.querySelector('[role="alert"]')).toBeNull();
    expect(requests.filter((request) => new URL(request.url).pathname === "/api/auth/config")).toHaveLength(2);
  });

  it("recovers a signed-in session when a retried config load succeeds", async () => {
    mode = "trusted-proxy";
    configStatus = 403;
    sessionStatus = 200;
    await mount();
    await settle(() => expect(button("Retry")).toBeTruthy());
    expect(ui.host.textContent).not.toContain("Protected workspace");
    configStatus = 200;
    await click("Retry");
    await settle(() => expect(ui.host.textContent).toBe("Protected workspace"));
  });

  it("does not carry a rejected token's error to the next sign-in page", async () => {
    await ui.render(
      <AuthProvider><LoginGate><h2>Protected workspace</h2><SignOut /></LoginGate></AuthProvider>,
    );
    await settle(() => expect(ui.host.querySelector("input")).not.toBeNull());
    await fill(ui.host.querySelector("input")!, "rejected-fixture");
    await submit();
    await settle(() => expect(requests.some((request) => request.method === "POST")).toBe(true));
    await act(async () => completeLogin(Response.json({}, { status: 401 })));
    await settle(() => expect(ui.host.querySelector('[role="alert"]')?.textContent).toBe("The token was rejected."));

    await fill(ui.host.querySelector("input")!, "corrected-fixture");
    await submit();
    await settle(() => expect(requests.filter((request) => request.method === "POST")).toHaveLength(2));
    await act(async () => completeLogin(session()));
    await settle(() => expect(ui.host.textContent).toContain("Protected workspace"));

    await click("Sign out");
    await settle(() => expect(ui.host.textContent).toContain("Local development sign in"));
    expect(ui.host.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a failed sign-out over the workspace, then not on the sign-in page", async () => {
    sessionStatus = 200;
    logoutStatus = 500;
    await ui.render(
      <AuthProvider>
        <LoginGate><AuthSessionBanner /><h2>Protected workspace</h2><Recheck /><SignOut /></LoginGate>
      </AuthProvider>,
    );
    await settle(() => expect(ui.host.textContent).toContain("Protected workspace"));
    expect(ui.host.querySelector('[role="alert"]')).toBeNull();

    await click("Sign out");
    await settle(() => expect(ui.host.querySelector('[role="alert"]')?.textContent)
      .toContain("Sign out could not be confirmed by the server. Please try again."));
    // The BFF may still hold the session, so the workspace stays.
    expect(ui.host.textContent).toContain("Protected workspace");

    // The session then ends: the sign-in page starts without the old error.
    sessionStatus = 401;
    await click("Recheck");
    await settle(() => expect(ui.host.textContent).toContain("Local development sign in"));
    expect(ui.host.querySelector('[role="alert"]')).toBeNull();
  });

  it("clears a failed sign-out's notice when a retried sign-out succeeds", async () => {
    sessionStatus = 200;
    logoutStatus = 500;
    await ui.render(
      <AuthProvider>
        <LoginGate><AuthSessionBanner /><h2>Protected workspace</h2><SignOut /></LoginGate>
      </AuthProvider>,
    );
    await settle(() => expect(ui.host.textContent).toContain("Protected workspace"));
    await click("Sign out");
    await settle(() => expect(ui.host.querySelector('[role="alert"]')).not.toBeNull());
    logoutStatus = 200;
    sessionStatus = 401;
    await click("Sign out");
    await settle(() => expect(ui.host.textContent).toContain("Local development sign in"));
    expect(ui.host.querySelector('[role="alert"]')).toBeNull();
  });
});

// The config and session reads are sent together on load. Nothing the session
// read says may be shown until the config names the sign-in mode.
describe("LoginGate concurrent boot reads", () => {
  let completeConfig: (response: Response) => void;
  const configFailure = "Unable to load the Foundry authentication configuration.";

  /** Hold the config read open until the test answers it. */
  function holdConfig() {
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((request) =>
      new URL((request as Request).url).pathname === "/api/auth/config"
        ? new Promise((done) => { completeConfig = done; })
        : answer(request));
  }

  function sessionReads() {
    return requests.filter((request) => new URL(request.url).pathname === "/api/auth/session");
  }

  /** Let every answer already delivered run through the client and the store. */
  async function drain() {
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
  }

  function SignInNow() {
    const { login } = useAuth();
    const signIn = () => void login("development-fixture").catch(() => undefined);
    return <button type="button" onClick={signIn}>Sign in now</button>;
  }

  it("keeps checking until the config loads when the BFF refuses the session first", async () => {
    mode = "trusted-proxy";
    loginUrl = "https://identity.example.test/login";
    refusalMarked = true;
    holdConfig();
    await mount();
    await settle(() => expect(sessionReads()).toHaveLength(1));
    await drain();
    expect(ui.host.querySelector('[role="status"]')?.textContent).toContain("Checking your session");
    expect(ui.host.textContent).not.toContain("Local development sign in");
    expect(ui.host.querySelector("input")).toBeNull();

    await act(async () => completeConfig(Response.json({ mode, loginUrl })));
    await settle(() => expect(button("Continue with SSO")).toBeTruthy());
    expect(ui.host.textContent).not.toContain("Local development sign in");
    expect(ui.host.querySelector("input")).toBeNull();
    expect(sessionReads()).toHaveLength(1);
  });

  it("shows a configuration failure without waiting for the session read", async () => {
    configStatus = 403;
    sessionStatus = 200;
    deferSession = true;
    await mount();
    await settle(() => expect(ui.host.textContent).toContain(configFailure));
    // The session read was sent alongside, and is still unanswered.
    expect(completeSession).toBeDefined();

    // A valid session landing afterwards is discarded.
    await act(async () => completeSession!(session()));
    await drain();
    expect(ui.host.textContent).toContain(configFailure);
    expect(ui.host.textContent).not.toContain("Protected workspace");
  });

  it("keeps a sign-in completed while the config read is pending when it then fails", async () => {
    refusalMarked = true;
    holdConfig();
    await ui.render(
      <AuthProvider><SignInNow /><LoginGate><h2>Protected workspace</h2></LoginGate></AuthProvider>,
    );
    await settle(() => expect(sessionReads()).toHaveLength(1));
    await drain();
    await click("Sign in now");
    await settle(() => expect(requests.some((request) => request.method === "POST")).toBe(true));
    await act(async () => completeLogin(session()));
    await settle(() => expect(ui.host.textContent).toContain("Protected workspace"));

    await act(async () => completeConfig(Response.json({}, { status: 403 })));
    await drain();
    expect(ui.host.textContent).toContain("Protected workspace");
    expect(ui.host.textContent).not.toContain(configFailure);
  });
});
