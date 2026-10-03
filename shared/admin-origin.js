import { isIP } from "node:net";

/** True when an origin points to this machine's loopback interface. */
export function isLoopbackAdminOrigin(value) {
  let parsed;
  try {
    parsed = value instanceof URL ? value : new URL(value);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    (isIP(host) === 4 && host.startsWith("127.")) ||
    host === "::1"
  );
}

/** True when an HTTP origin can carry a secret without leaving this machine. */
export function mayCarrySecret(value) {
  let parsed;
  try {
    parsed = value instanceof URL ? value : new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" || (
    parsed.protocol === "http:" && isLoopbackAdminOrigin(parsed)
  );
}
