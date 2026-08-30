import { describe, expect, it } from "vitest";
import { filterAndPage } from "./collectionSearch";

describe("filterAndPage", () => {
  it("finds a match beyond the first server-sized page", () => {
    const records = Array.from({ length: 125 }, (_, index) => ({
      id: `record-${index}`,
      name: index === 101 ? "Needle service" : `Service ${index}`,
    }));

    expect(
      filterAndPage(
        records,
        " needle ",
        (record, query) => record.name.toLowerCase().includes(query),
        0,
        20,
      ),
    ).toEqual({ items: [records[101]], total: 1 });
  });

  it("paginates after filtering", () => {
    const records = Array.from({ length: 45 }, (_, index) => ({ id: index }));
    const page = filterAndPage(records, "", () => true, 20, 20);
    expect(page.items.map(({ id }) => id)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 20),
    );
    expect(page.total).toBe(45);
  });
});
