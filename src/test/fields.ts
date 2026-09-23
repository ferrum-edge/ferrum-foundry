import { act } from "react";

/** Resolve an `Input` field by its visible label text (uses the label's `for` id). */
export function inputByLabel(root: ParentNode, labelText: string): HTMLInputElement {
  const label = Array.from(root.querySelectorAll("label")).find(
    (element) => element.textContent?.trim() === labelText,
  );
  if (!label) throw new Error(`Missing label: ${labelText}`);
  const id = label.getAttribute("for");
  if (!id) throw new Error(`Label ${labelText} has no for attribute`);
  const element = root.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`);
  if (!element) throw new Error(`Missing input for label: ${labelText}`);
  return element;
}

/** Like `inputByLabel`, but returns null when the label or input is absent. */
export function inputByLabelOrNull(
  root: ParentNode | null | undefined,
  labelText: string,
): HTMLInputElement | null {
  if (!root) return null;
  try {
    return inputByLabel(root, labelText);
  } catch {
    return null;
  }
}

async function setNativeValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Type into a controlled field one character at a time, as a user does: each
 * keystroke appends to whatever the field shows after React re-rendered the
 * previous one, so a handler that rewrites the displayed value mid-entry
 * (dropping a comma, inserting a `0`) is caught.
 */
export async function typeText(input: HTMLInputElement, text: string) {
  await act(async () => input.focus());
  for (const character of text) {
    await setNativeValue(input, input.value + character);
  }
}

/** Select a field's contents and delete them, leaving it focused and empty. */
export async function clearText(input: HTMLInputElement) {
  await act(async () => input.focus());
  await setNativeValue(input, "");
}

/** Leave a field, firing the `focusout` React maps to `onBlur`. */
export async function blurField(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}
