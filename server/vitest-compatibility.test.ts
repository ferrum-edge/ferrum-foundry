import { beforeAll, expect, it, vi } from "vitest";

const setup = vi.fn(() => process.versions.node);

beforeAll(() => {
  setup();
});

it("keeps server setup mock history in the node project", () => {
  // Vitest 5's default clearMocks would discard this beforeAll evidence.
  expect(setup).toHaveBeenCalledOnce();
  expect(setup.mock.results[0].value).toBe(process.versions.node);
  expect("document" in globalThis).toBe(false);
});
