/** Encode one dynamic Admin API path segment without permitting dot traversal. */
export function pathSegment(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new TypeError("Admin API path segments must not be empty or dot segments");
  }
  return encodeURIComponent(value);
}
