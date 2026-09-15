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
