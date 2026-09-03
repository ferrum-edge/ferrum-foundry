import { afterEach, describe, expect, it } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "./DataTable";

// React requires this flag before `act()` will flush updates synchronously.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  name: string;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(ui: ReactElement): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const created = createRoot(host);
  await act(async () => {
    created.render(ui);
  });
  container = host;
  root = created;
  return host;
}

afterEach(async () => {
  const activeRoot = root;
  const activeContainer = container;
  root = null;
  container = null;
  if (activeRoot) {
    await act(async () => {
      activeRoot.unmount();
    });
  }
  activeContainer?.remove();
});

const columns: ColumnDef<Row, unknown>[] = [
  { id: "name", header: "Name", accessorKey: "name" },
  { id: "health", header: "Health Check", accessorKey: "name", minSize: 120 },
  { id: "created", header: "Created", accessorKey: "name", size: 200 },
];

describe("DataTable header sizing", () => {
  it("applies a declared minSize as a min-width on the header cell", async () => {
    const host = await render(
      <DataTable<Row> columns={columns} data={[]} isLoading={false} />,
    );

    const headers = host.querySelectorAll("th");
    expect(headers).toHaveLength(3);
    expect(headers[1].style.minWidth).toBe("120px");
  });

  it("leaves TanStack's default minSize and size off the header style", async () => {
    const host = await render(
      <DataTable<Row> columns={columns} data={[]} isLoading={false} />,
    );

    const headers = host.querySelectorAll("th");
    // "name" declares neither, so it must not inherit the library defaults
    // (minSize 20 / size 150) as inline constraints.
    expect(headers[0].style.minWidth).toBe("");
    expect(headers[0].style.width).toBe("");
    // A declared `size` still becomes a width.
    expect(headers[2].style.width).toBe("200px");
    expect(headers[2].style.minWidth).toBe("");
  });

  it("keeps the header label and its sort icon on one line", async () => {
    const host = await render(
      <DataTable<Row> columns={columns} data={[]} isLoading={false} />,
    );

    const headers = host.querySelectorAll("th");
    for (const header of headers) {
      expect(header.className).toContain("whitespace-nowrap");
      expect(header.querySelector("span")?.className).toContain(
        "whitespace-nowrap",
      );
    }
  });
});
