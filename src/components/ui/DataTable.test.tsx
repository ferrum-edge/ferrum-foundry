import { afterEach, describe, expect, it } from "vitest";
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "./DataTable";

// React requires this flag before `act()` will flush updates synchronously.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: string;
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

const sortingColumns: ColumnDef<Row, unknown>[] = [
  { header: "Name", accessorKey: "name" },
  { header: "ID", accessorKey: "id", enableSorting: false },
];

function bodyValues(host: HTMLElement, column = 0) {
  return Array.from(host.querySelectorAll("tbody tr"), (row) =>
    row.querySelectorAll("td")[column].textContent,
  );
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

describe("DataTable sorting", () => {
  it("reorders the real tbody in both directions with a matching indicator", async () => {
    const data = [
      { id: "z", name: "Zebra" },
      { id: "a", name: "Alpha" },
    ];
    const host = await render(
      <DataTable columns={sortingColumns} data={data} isLoading={false} />,
    );
    const header = host.querySelectorAll("th")[0];

    expect(bodyValues(host)).toEqual(["Zebra", "Alpha"]);
    await click(header);
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(bodyValues(host)).toEqual(["Alpha", "Zebra"]);

    await click(header);
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(bodyValues(host)).toEqual(["Zebra", "Alpha"]);

    await click(header);
    expect(header.getAttribute("aria-sort")).toBe("none");
    expect(bodyValues(host)).toEqual(["Zebra", "Alpha"]);
    expect(data.map((row) => row.id)).toEqual(["z", "a"]);
  });

  it("sorts the complete collection before paging and resets the page on direction changes", async () => {
    const data = [
      { id: "z", name: "Zebra" },
      { id: "m", name: "Middle" },
      { id: "b", name: "Alpha" },
      { id: "a", name: "Alpha" },
    ];
    function CollectionTable() {
      const [page, setPage] = useState({ offset: 2, limit: 2 });
      return (
        <DataTable
          columns={sortingColumns}
          data={data}
          isLoading={false}
          paginationMode="client"
          pagination={{ ...page, total: data.length }}
          onPaginationChange={setPage}
        />
      );
    }
    const host = await render(<CollectionTable />);
    const header = host.querySelectorAll("th")[0];
    const nextButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Next"),
    )!;

    expect(bodyValues(host, 1)).toEqual(["b", "a"]);
    await click(header);
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(bodyValues(host, 1)).toEqual(["a", "b"]);
    expect(host.textContent).toContain("Showing 1-2 of 4");

    await click(nextButton);
    expect(bodyValues(host, 1)).toEqual(["m", "z"]);
    expect(nextButton.disabled).toBe(true);

    await click(header);
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(bodyValues(host, 1)).toEqual(["z", "m"]);
    expect(host.textContent).toContain("Showing 1-2 of 4");

    await click(nextButton);
    expect(bodyValues(host, 1)).toEqual(["a", "b"]);
    expect(data.map((row) => row.id)).toEqual(["z", "m", "b", "a"]);
  });

  it("keeps equal values ordered by ID after the collection arrives in a different order", async () => {
    const data = [
      { id: "b", name: "Alpha" },
      { id: "a", name: "Alpha" },
    ];
    const host = await render(
      <DataTable columns={sortingColumns} data={data} isLoading={false} />,
    );
    const header = host.querySelectorAll("th")[0];
    await click(header);
    expect(bodyValues(host, 1)).toEqual(["a", "b"]);
    await click(header);
    expect(bodyValues(host, 1)).toEqual(["a", "b"]);

    await act(async () => {
      root?.render(
        <DataTable
          columns={sortingColumns}
          data={[...data].reverse()}
          isLoading={false}
        />,
      );
    });
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(bodyValues(host, 1)).toEqual(["a", "b"]);
  });

  it("disables the affordance on server pages even when a column enables sorting", async () => {
    const host = await render(
      <DataTable
        columns={[{ header: "Name", accessorKey: "name", enableSorting: true }]}
        data={[
          { id: "z", name: "Zebra" },
          { id: "a", name: "Alpha" },
        ]}
        isLoading={false}
        pagination={{ offset: 2, limit: 2, total: 6 }}
      />,
    );
    const header = host.querySelectorAll("th")[0];
    expect(header.hasAttribute("aria-sort")).toBe(false);
    expect(header.querySelector("svg")).toBeNull();
    expect(header.className).not.toContain("cursor-pointer");
    await click(header);
    await click(header);
    expect(bodyValues(host)).toEqual(["Zebra", "Alpha"]);
    expect(header.hasAttribute("aria-sort")).toBe(false);
  });

  it("respects enableSorting false on complete-collection columns", async () => {
    const host = await render(
      <DataTable
        columns={sortingColumns}
        data={[
          { id: "z", name: "Zebra" },
          { id: "a", name: "Alpha" },
        ]}
        isLoading={false}
      />,
    );
    const header = host.querySelectorAll("th")[1];
    expect(header.querySelector("svg")).toBeNull();
    await click(header);
    expect(bodyValues(host, 1)).toEqual(["z", "a"]);
  });
});

const columns: ColumnDef<Row, unknown>[] = [
  { id: "name", header: "Name", accessorKey: "name" },
  { id: "health", header: "Health Check", accessorKey: "name", minSize: 120 },
  { id: "created", header: "Created", accessorKey: "name", size: 200 },
];

describe("DataTable header sizing", () => {
  it("associates each Rows label with its own page-size select", async () => {
    const host = await render(
      <>
        <DataTable<Row>
          columns={columns}
          data={[]}
          isLoading={false}
          onPaginationChange={() => {}}
        />
        <DataTable<Row>
          columns={columns}
          data={[]}
          isLoading={false}
          onPaginationChange={() => {}}
        />
      </>,
    );
    const selects = host.querySelectorAll("select");
    expect(selects).toHaveLength(2);
    expect(selects[0].id).not.toBe(selects[1].id);
    for (const select of selects) {
      expect(select.labels).toHaveLength(1);
      expect(select.labels?.[0].textContent).toBe("Rows");
    }
  });

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

describe("DataTable out-of-range recovery", () => {
  it("returns to the last page of the complete client collection", async () => {
    const data = Array.from({ length: 25 }, (_, index) => ({ id: String(index), name: `Item ${index}` }));
    function CollectionTable() {
      const [page, setPage] = useState({ offset: 100, limit: 20 });
      return <DataTable columns={sortingColumns} data={data} isLoading={false} paginationMode="client" pagination={{ ...page, total: data.length }} onPaginationChange={setPage} emptyMessage="No resources yet" />;
    }
    const host = await render(<CollectionTable />);
    expect(host.textContent).toContain("Page out of range");
    expect(host.textContent).not.toContain("No resources yet");
    const button = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Go to last page")!;
    await click(button);
    expect(bodyValues(host)).toEqual(["Item 20", "Item 21", "Item 22", "Item 23", "Item 24"]);
    expect(host.textContent).toContain("Showing 21-25 of 25");
    expect(host.textContent).toContain("Page 2 of 2");
  });
});
