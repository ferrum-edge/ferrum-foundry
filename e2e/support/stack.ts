/* ------------------------------------------------------------------ */
/*  Critical-journey fixtures (issue #380)                             */
/* ------------------------------------------------------------------ */

import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

export const FOUNDRY_URL = process.env.FOUNDRY_URL ?? "http://127.0.0.1:8088";
export const DATA_PLANE_URL = process.env.FERRUM_DATA_PLANE_URL ?? "http://127.0.0.1:8000";
export const ADMIN_URL = process.env.FERRUM_ADMIN_URL ?? "http://127.0.0.1:9000";
export const FAULT_URL = process.env.FAULT_PROXY_URL ?? "http://127.0.0.1:9500";
export const FAULT_TOKEN = process.env.FAULT_TOKEN ?? "e2e-fault-token";
export const NAMESPACE = process.env.FERRUM_NAMESPACE ?? "ferrum-foundry-demo";
export const NAMESPACE_B = process.env.FERRUM_NAMESPACE_B ?? "ferrum-foundry-demo-b";

/**
 * The demo stack's identity stub keys off this header, and the reverse proxy
 * maps it through the *production* group-to-role policy. A journey therefore
 * chooses who it is, not what role it gets: the mapping is under test.
 */
export const IDENTITY_HEADER = "X-Demo-Identity";

export type Identity = "admin" | "operator" | "viewer" | "unmapped";

/* ------------------------------------------------------------------ */
/*  Deterministic failure injection                                    */
/* ------------------------------------------------------------------ */

export interface Fault {
  method?: string;
  path: string;
  times?: number;
  status?: number;
  body?: string;
  /** Discard the request before the gateway sees it. */
  drop?: boolean;
  /**
   * Let the gateway commit, then destroy the connection. The genuinely
   * ambiguous case: the write happened and the client cannot know it.
   */
  dropAfterForward?: boolean;
}

export class FaultControl {
  /** Arm exactly `times` failures. Nothing here waits for a flake. */
  async arm(fault: Fault): Promise<void> {
    const response = await fetch(`${FAULT_URL}/__fault`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fault-token": FAULT_TOKEN },
      body: JSON.stringify(fault),
    });
    expect(response.status, "arming a fault").toBe(200);
  }

  async state(): Promise<{ armed: unknown[]; served: number; blocked: number }> {
    const response = await fetch(`${FAULT_URL}/__fault`, {
      headers: { "x-fault-token": FAULT_TOKEN },
    });
    expect(response.status, "reading fault state").toBe(200);
    return response.json() as Promise<{ armed: unknown[]; served: number; blocked: number }>;
  }

  async disarm(): Promise<void> {
    await fetch(`${FAULT_URL}/__fault`, {
      method: "DELETE",
      headers: { "x-fault-token": FAULT_TOKEN },
    });
  }

  /** Assert every armed fault was actually consumed, so a journey cannot
   *  pass because the failure it arranged never happened. */
  async expectAllConsumed(): Promise<void> {
    const state = await this.state();
    expect(state.armed, "an armed fault was never triggered").toEqual([]);
  }
}

/* ------------------------------------------------------------------ */
/*  Gateway access, for asserting real state rather than the UI's word */
/* ------------------------------------------------------------------ */

/**
 * Read and write the gateway through the same front door the browser uses,
 * as a named identity. Used to set a journey up, to tear it down, and — the
 * important one — to verify that what the UI reported matches what the
 * gateway actually holds.
 */
export class GatewayClient {
  constructor(
    private readonly identity: Identity = "admin",
    private readonly namespace: string = NAMESPACE,
  ) {}

  private cookies = "";
  private csrf = "";

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      [IDENTITY_HEADER]: this.identity,
      "X-Ferrum-Namespace": this.namespace,
      ...(this.cookies ? { cookie: this.cookies } : {}),
      ...(this.csrf ? { "X-CSRF-Token": this.csrf } : {}),
      ...extra,
    };
  }

  async session(): Promise<void> {
    const response = await fetch(`${FOUNDRY_URL}/api/auth/session`, {
      headers: { [IDENTITY_HEADER]: this.identity },
    });
    expect(response.status, "opening a session").toBe(200);
    this.cookies = (response.headers.getSetCookie?.() ?? [])
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    this.csrf = ((await response.json()) as { csrfToken: string }).csrfToken;
  }

  async get<T>(path: string): Promise<{ status: number; body: T | undefined }> {
    const response = await fetch(`${FOUNDRY_URL}/api/proxy${path}`, {
      headers: this.headers(),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as T) : undefined };
  }

  async send<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T | undefined }> {
    if (!this.csrf) await this.session();
    const response = await fetch(`${FOUNDRY_URL}/api/proxy${path}`, {
      method,
      headers: this.headers({ "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as T) : undefined };
  }

  /** Delete a resource, tolerating one that is already gone. */
  async remove(path: string): Promise<void> {
    await this.send("DELETE", path).catch(() => undefined);
  }
}

/** One request through the data plane: the only proof a route really works. */
export async function callDataPlane(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${DATA_PLANE_URL}${path}`, { headers });
  return { status: response.status, body: await response.text() };
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

interface Fixtures {
  /** A browser signed in as `admin` through the identity proxy. */
  adminPage: Page;
  /** Open a browser as any identity, including one in no Ferrum group. */
  signIn: (identity: Identity) => Promise<{ context: BrowserContext; page: Page }>;
  faults: FaultControl;
  gateway: GatewayClient;
}

export const test = base.extend<Fixtures>({
  signIn: async ({ browser }, use) => {
    const opened: BrowserContext[] = [];
    await use(async (identity: Identity) => {
      const context = await browser.newContext({
        baseURL: FOUNDRY_URL,
        extraHTTPHeaders: { [IDENTITY_HEADER]: identity },
      });
      opened.push(context);
      return { context, page: await context.newPage() };
    });
    await Promise.all(opened.map((context) => context.close()));
  },

  adminPage: async ({ signIn }, use) => {
    const { page } = await signIn("admin");
    await use(page);
  },

  faults: async ({}, use) => {
    const control = new FaultControl();
    await control.disarm();
    await use(control);
    // A leftover armed fault would fail the next journey for the wrong
    // reason, so every test hands the forwarder back clean.
    await control.disarm();
  },

  gateway: async ({}, use) => {
    const client = new GatewayClient();
    await client.session();
    await use(client);
  },
});

export { expect };

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

/** Switch the active namespace through the header control, as an operator does. */
export async function selectNamespace(page: Page, namespace: string): Promise<void> {
  const trigger = page.getByRole("combobox", { name: /namespace/i });
  await trigger.click();
  await page.getByRole("option", { name: namespace, exact: true }).click();
  await expect(trigger).toContainText(namespace);
}

/** A unique id per run, so a journey never collides with a leftover resource. */
export function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
