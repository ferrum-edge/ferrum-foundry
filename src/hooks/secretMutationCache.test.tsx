/* ------------------------------------------------------------------ */
/*  A restore's backup and an API spec write's document carry secrets */
/*  (#485). Their mutations keep the submitted body as `variables`,   */
/*  so each is discarded from the mutation cache as soon as the page  */
/*  that submitted it is gone, like the other secret-bearing writes.  */
/* ------------------------------------------------------------------ */

import { act, useEffect, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, settle, stubFetch } from "@/test/__tests__/harness";
import { useImportApiSpec, useUpdateApiSpec } from "./useApiSpecs";
import { useRestore } from "./useOps";

vi.mock("@/stores/namespace", () => ({ useNamespace: () => ({ scope: { namespace: "tenant-a" } }) }));

const SECRET = "synthetic-secret-0123456789";
const BACKUP = { version: "1", consumers: [{ id: "alice", credentials: { keyauth: [{ key: SECRET }] } }] };
const DOCUMENT = `x-ferrum-plugins:\n  - plugin_name: key_auth\n    config:\n      api_key: ${SECRET}\n`;

let ui: ReturnType<typeof createHarness>;
let submit: () => Promise<unknown>;

function RestoreProbe() {
  const mutation = useRestore();
  useEffect(() => {
    submit = () => mutation.mutateAsync({ data: BACKUP, namespace: "tenant-a" });
  });
  return <p>probe</p>;
}

function ImportProbe() {
  const mutation = useImportApiSpec();
  useEffect(() => {
    submit = () => mutation.mutateAsync(DOCUMENT);
  });
  return <p>probe</p>;
}

function ReplaceProbe() {
  const mutation = useUpdateApiSpec();
  useEffect(() => {
    submit = () => mutation.mutateAsync({ id: "orders-spec", document: DOCUMENT });
  });
  return <p>probe</p>;
}

beforeEach(() => {
  ui = createHarness();
  stubFetch(() => Response.json({ error: "rejected" }, { status: 400 }));
});

afterEach(async () => {
  await ui.dispose();
  vi.unstubAllGlobals();
});

describe("secret-bearing mutations leave nothing in the mutation cache", () => {
  it.each<[string, ComponentType]>([
    ["a restore", RestoreProbe],
    ["an API spec import", ImportProbe],
    ["an API spec replacement", ReplaceProbe],
  ])("discards %s once its page is gone", async (_label, Probe) => {
    await ui.render(<Probe />);
    await act(async () => { await submit().catch(() => undefined); });
    // The page that submitted it can still report the failure.
    const [mutation] = ui.client.getMutationCache().getAll();
    expect(mutation?.state.status).toBe("error");
    expect(JSON.stringify(mutation?.state.variables)).toContain(SECRET);

    await ui.render(<p>elsewhere</p>);
    await settle(() => expect(ui.client.getMutationCache().getAll()).toHaveLength(0));
  });
});
