/** Encode one dynamic Admin API path segment without permitting dot traversal. */
export class PathSegmentError extends TypeError {
  constructor() {
    super("Admin API path segments must not be empty or dot segments");
    this.name = "PathSegmentError";
  }
}

export function pathSegment(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new PathSegmentError();
  }
  return encodeURIComponent(value);
}
