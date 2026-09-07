import { beforeAll, expect, it, vi } from "vitest";

const setup = vi.fn(() => document.createElement("div"));

beforeAll(() => {
  setup();
});

it("keeps frontend setup mock history in the jsdom project", () => {
  // Vitest 5's default clearMocks would discard this beforeAll evidence.
  expect(setup).toHaveBeenCalledOnce();
  expect(setup.mock.results[0].value).toBeInstanceOf(HTMLDivElement);
});
