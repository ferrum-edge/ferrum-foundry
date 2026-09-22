/* ------------------------------------------------------------------ */
/*  Who may do what, through the real proxy (issue #380)               */
/* ------------------------------------------------------------------ */

import {
  expect,
  test,
  FOUNDRY_URL,
  IDENTITY_HEADER,
  NAMESPACE,
  NAMESPACE_B,
  proofSecret,
} from "../support/stack";

const ADMIN_ROUTE = "/api/proxy/proxies?offset=0&limit=1";

test.describe("authorization through the identity proxy", () => {
  test("an unauthenticated browser never reaches an admin surface", async ({ request }) => {
    const response = await request.get(`${FOUNDRY_URL}/proxies`, {
      maxRedirects: 0,
      headers: { [IDENTITY_HEADER]: "not-a-known-identity" },
    });
    expect(response.status()).toBe(302);
    expect(response.headers().location).toContain("/oauth2/start");

    // The SPA polls its session on load. That must stay a raw 401 rather than
    // a sign-in page, or the app shows a generic session error where it
    // expects JSON.
    const session = await request.get(`${FOUNDRY_URL}/api/auth/session`, {
      maxRedirects: 0,
      headers: { [IDENTITY_HEADER]: "not-a-known-identity" },
    });
    expect(session.status()).toBe(401);
  });

  test("a user authenticated at the IdP but in no Ferrum group is refused", async ({
    signIn,
    request,
  }) => {
    // The identity provider admitted them. The group-to-role policy maps them
    // to no role, so Foundry refuses — the second of the two denials.
    const api = await request.get(`${FOUNDRY_URL}${ADMIN_ROUTE}`, {
      headers: { [IDENTITY_HEADER]: "unmapped", "X-Ferrum-Namespace": NAMESPACE },
    });
    expect(api.status()).toBe(401);
    expect(api.headers()["x-ferrum-auth-layer"]).toBe("bff");

    const { page } = await signIn("unmapped");
    await page.goto("/proxies");
    await expect(page.getByText(/sign in to ferrum foundry/i)).toBeVisible();
    // No administrative content leaked behind the gate.
    await expect(page.getByRole("link", { name: "Consumers" })).toHaveCount(0);
  });

  test("a client cannot elevate itself with identity headers", async ({ request }) => {
    // Every one of these is overwritten by the proxy. If any were forwarded,
    // a browser could make itself an administrator.
    const forged = await request.get(`${FOUNDRY_URL}${ADMIN_ROUTE}`, {
      headers: {
        // The real secret: a client holding it must still be unable to assert
        // its own identity. A guessed one would be refused regardless.
        "X-Ferrum-Auth-Secret": proofSecret(),
        "X-Forwarded-User": "mallory",
        "X-Ferrum-Role": "admin",
        "X-Ferrum-Namespaces": `${NAMESPACE},${NAMESPACE_B}`,
        "X-Ferrum-Namespace": NAMESPACE,
      },
    });
    expect(forged.status()).toBe(401);

    // Nor can a viewer promote itself by claiming a role alongside a valid
    // identity: the proxy replaces the header the stub's group mapping set.
    const promoted = await request.get(`${FOUNDRY_URL}${ADMIN_ROUTE}`, {
      headers: {
        [IDENTITY_HEADER]: "viewer",
        "X-Ferrum-Role": "admin",
        "X-Ferrum-Namespace": NAMESPACE,
      },
    });
    expect(promoted.status()).toBe(200);

    const session = await request.get(`${FOUNDRY_URL}/api/auth/session`, {
      headers: { [IDENTITY_HEADER]: "viewer", "X-Ferrum-Role": "admin" },
    });
    expect(session.status()).toBe(200);
    expect(((await session.json()) as { principal: { role: string } }).principal.role).toBe(
      "viewer",
    );
  });

  test("a viewer gets every surface read-only, with the reason before any edit", async ({
    signIn,
  }) => {
    const { page } = await signIn("viewer");

    await page.goto("/proxies");
    await expect(page.getByRole("heading", { name: "Proxies", exact: true })).toBeVisible();

    // The reason is on screen before anything is edited, and every write
    // control carries it as its accessible name rather than just looking grey.
    const create = page.getByRole("button", { name: /create proxy/i });
    await expect(create.first()).toBeDisabled();
    for (const control of await create.all()) {
      await expect(control).toBeDisabled();
      // The reason is the control's accessible description, so a screen
      // reader gets it too — not only a grey button.
      const describedBy = await control.getAttribute("aria-describedby");
      expect(describedBy, "a denied control must describe why").toBeTruthy();
      await expect(page.locator(`[id="${describedBy}"]`)).toContainText(
        /viewer role, which cannot create, edit, or delete proxies/i,
      );
    }

    // The create page is presented read-only rather than accepting a full
    // form and failing with a 403 at the end of it.
    await page.goto("/proxies/new");
    await expect(page.getByText(/proxy configuration is read-only/i)).toBeVisible();
    // A read-only surface still shows everything the editable one does.
    await expect(page.getByLabel("Backend Host", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^cancel$/i })).toBeEnabled();
  });

  test("an operator may write, and the gateway agrees", async ({ signIn, request }) => {
    const { page } = await signIn("operator");
    await page.goto("/proxies");
    await expect(page.getByRole("heading", { name: "Proxies", exact: true })).toBeVisible();
    await expect(page.getByText(/cannot create, edit, or delete proxies/i)).toHaveCount(0);

    const read = await request.get(`${FOUNDRY_URL}${ADMIN_ROUTE}`, {
      headers: { [IDENTITY_HEADER]: "operator", "X-Ferrum-Namespace": NAMESPACE },
    });
    expect(read.status()).toBe(200);
  });

  test("a namespace outside the grant is refused, whatever the role", async ({ request }) => {
    for (const identity of ["viewer", "operator", "admin"]) {
      const response = await request.get(`${FOUNDRY_URL}${ADMIN_ROUTE}`, {
        headers: {
          [IDENTITY_HEADER]: identity,
          "X-Ferrum-Namespace": "a-namespace-nobody-granted",
        },
      });
      expect(response.status(), `${identity} reading an ungranted namespace`).toBe(403);
    }

    // The admin's grant covers two namespaces; the operator's covers one.
    const adminSecond = await request.get(`${FOUNDRY_URL}${ADMIN_ROUTE}`, {
      headers: { [IDENTITY_HEADER]: "admin", "X-Ferrum-Namespace": NAMESPACE_B },
    });
    expect(adminSecond.status()).toBe(200);

    const operatorSecond = await request.get(`${FOUNDRY_URL}${ADMIN_ROUTE}`, {
      headers: { [IDENTITY_HEADER]: "operator", "X-Ferrum-Namespace": NAMESPACE_B },
    });
    expect(operatorSecond.status()).toBe(403);
  });

  test("a write without a session and CSRF grant is refused", async ({ request }) => {
    const response = await request.post(`${FOUNDRY_URL}/api/proxy/upstreams`, {
      headers: { [IDENTITY_HEADER]: "admin", "X-Ferrum-Namespace": NAMESPACE },
      data: { id: "must-not-exist", algorithm: "round_robin", targets: [] },
    });
    expect(response.status()).toBe(403);

    // And it really did not happen.
    const check = await request.get(`${FOUNDRY_URL}/api/proxy/upstreams/must-not-exist`, {
      headers: { [IDENTITY_HEADER]: "admin", "X-Ferrum-Namespace": NAMESPACE },
    });
    expect(check.status()).toBe(404);
  });
});
