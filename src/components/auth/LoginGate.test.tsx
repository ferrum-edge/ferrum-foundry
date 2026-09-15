import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/stores/auth";
import { setCsrfToken } from "@/api/client";
import { BasedRequest, button, click, createHarness, fill, settle } from "@/test/__tests__/harness";
import { LoginGate } from "./LoginGate";

let ui: ReturnType<typeof createHarness>;
let mode: "static" | "trusted-proxy";
let loginUrl: string | undefined;
let sessionStatus: number;
let configStatus: number;
let requests: Request[];
let completeLogin: (response: Response) => void;

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
    if (path === "/api/auth/session") {
      return sessionStatus === 200 ? session() : Response.json({}, { status: sessionStatus });
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
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
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
    expect(requests).toHaveLength(1);
  });
});
