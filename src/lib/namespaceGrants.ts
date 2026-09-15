/** Grants are exact names; undefined is deliberate unrestricted access. */
export function namespaceGranted(grants: readonly string[] | undefined, name: string): boolean {
  return grants === undefined || grants.includes(name);
}
