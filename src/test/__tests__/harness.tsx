import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, vi } from "vitest";
import { ToastProvider } from "@/components/ui/Toast";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

export class BasedRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
  }
}

/** Stub ky's fetch boundary with bodies owned independently by tests and the client. */
export function stubFetch(respond: (request: Request) => Response | Promise<Response>) {
  vi.stubGlobal("Request", BasedRequest);
  const fetchMock = vi.fn(async (request: Request) => {
    // ky cancels its request body on completion. Give the handler a clone now
    // so captured requests remain readable after the application finishes.
    // Handlers that inspect a body and retain it must read request.clone().
    const response = await respond(request.clone());
    // A fixed mockReturnValue/mockResolvedValue must support later calls too.
    return response.clone();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function createHarness() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    host,
    client,
    async render(children: ReactNode) {
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <ToastProvider>{children}</ToastProvider>
          </QueryClientProvider>,
        );
      });
    },
    async dispose() {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}

export async function settle(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    check();
  });
}

export async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function button(label: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === label || entry.getAttribute("aria-label") === label,
  );
  expect(found, `button ${label}`).toBeTruthy();
  return found!;
}

export async function click(label: string, within: ParentNode = document) {
  await act(async () => button(label, within).click());
}

export async function selectTab(label: string) {
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
    .find((entry) => entry.textContent === label);
  expect(tab, `tab ${label}`).toBeTruthy();
  await act(async () => {
    tab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
}

export function panel(): HTMLElement {
  const active = document.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"]');
  expect(active).not.toBeNull();
  return active!;
}

export async function selectOption(label: string, value: string) {
  const trigger = [...document.querySelectorAll<HTMLElement>('[role="combobox"]')].find(
    (entry) => entry.getAttribute("aria-labelledby")?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent).join(" ") === label,
  );
  expect(trigger, `select ${label}`).toBeTruthy();
  await act(async () => {
    trigger!.focus();
    trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((entry) => entry.textContent === value);
  expect(option, `option ${value}`).toBeTruthy();
  await act(async () => {
    option!.focus();
    option!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

export function page<T>(data: T[]) {
  return { data, pagination: { offset: 0, limit: 250, total: data.length } };
}
