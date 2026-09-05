import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  NAMESPACE_STORAGE_KEY,
  NamespaceProvider,
  useNamespace,
} from "@/stores/namespace";
import {
  StaleEditorSubmissionError,
  type EditorIdentity,
} from "@/lib/editorIdentity";
import {
  useEditorIdentity,
  type EditorSession,
  type EditorSessionOptions,
} from "./useEditorIdentity";

vi.mock("@/stores/auth", () => ({
  useAuth: () => ({ principal: null }),
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Handle {
  session: EditorSession;
  setNamespace: (ns: string) => void;
}

function Probe({
  resourceId,
  options,
  onValue,
}: {
  resourceId: string;
  options?: EditorSessionOptions;
  onValue: (value: Handle) => void;
}) {
  const { setNamespace } = useNamespace();
  const session = useEditorIdentity(resourceId, options);
  useEffect(() => {
    onValue({ session, setNamespace });
  });
  return <span data-testid="key">{session.key}</span>;
}

describe("useEditorIdentity", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  let handle: Handle | undefined;

  async function render(ui: ReactElement): Promise<void> {
    if (!root) {
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
    }
    const active = root;
    await act(async () => {
      active.render(<NamespaceProvider>{ui}</NamespaceProvider>);
    });
  }

  function probe(resourceId: string, options?: EditorSessionOptions): ReactElement {
    return (
      <Probe
        resourceId={resourceId}
        options={options}
        onValue={(value) => {
          handle = value;
        }}
      />
    );
  }

  beforeEach(() => {
    handle = undefined;
    localStorage.setItem(NAMESPACE_STORAGE_KEY, "tenant-a");
  });

  afterEach(async () => {
    const activeRoot = root;
    root = null;
    if (activeRoot) {
      await act(async () => {
        activeRoot.unmount();
      });
    }
    host?.remove();
    host = null;
    localStorage.removeItem(NAMESPACE_STORAGE_KEY);
  });

  it("keeps one identity across re-renders and changes it only with the namespace or resource", async () => {
    await render(probe("shared"));
    const first = handle!.session;
    expect(first.identity).toEqual({ namespace: "tenant-a", resourceId: "shared" });

    // A re-render with the same inputs keeps the same identity object and key.
    await render(probe("shared"));
    expect(handle!.session.identity).toBe(first.identity);
    expect(handle!.session.key).toBe(first.key);

    // A namespace switch is an identity change.
    await act(async () => {
      handle!.setNamespace("tenant-b");
    });
    expect(handle!.session.identity).toEqual({ namespace: "tenant-b", resourceId: "shared" });
    expect(handle!.session.key).not.toBe(first.key);
    expect(host?.textContent).toBe(handle!.session.key);

    // So is a route change to another resource.
    const afterSwitch = handle!.session;
    await render(probe("other"));
    expect(handle!.session.identity).toEqual({ namespace: "tenant-b", resourceId: "other" });
    expect(handle!.session.key).not.toBe(afterSwitch.key);
  });

  it("runs a handler bound under the current identity with its arguments", async () => {
    await render(probe("shared"));
    const handler = vi.fn(async (_label: string, _count: number) => {});
    const bound = handle!.session.bind(handler);

    await bound("groups", 2);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("groups", 2);
  });

  it("refuses a handler bound under a previous identity", async () => {
    await render(probe("shared"));
    const staleHandler = vi.fn(async () => {});
    const boundUnderA = handle!.session.bind(staleHandler);

    await act(async () => {
      handle!.setNamespace("tenant-b");
    });

    let refused: unknown;
    await boundUnderA().catch((error: unknown) => {
      refused = error;
    });
    expect(refused).toBeInstanceOf(StaleEditorSubmissionError);
    const error = refused as StaleEditorSubmissionError;
    expect(error.captured).toEqual({ namespace: "tenant-a", resourceId: "shared" });
    expect(error.current).toEqual({ namespace: "tenant-b", resourceId: "shared" });
    expect(staleHandler).not.toHaveBeenCalled();

    // A handler bound under the identity now on screen still runs.
    const freshHandler = vi.fn(async () => {});
    await handle!.session.bind(freshHandler)();
    expect(freshHandler).toHaveBeenCalledTimes(1);
  });

  it("hands a stale call to onStale instead of throwing when one is configured", async () => {
    const onStale = vi.fn((_captured: EditorIdentity, _current: EditorIdentity) => {});
    await render(probe("shared", { onStale }));
    const handler = vi.fn(async () => {});
    const boundUnderShared = handle!.session.bind(handler);

    // The route moves to another resource in the same namespace.
    await render(probe("other", { onStale }));

    await expect(boundUnderShared()).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledWith(
      { namespace: "tenant-a", resourceId: "shared" },
      { namespace: "tenant-a", resourceId: "other" },
    );
  });
});
