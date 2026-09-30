import { isIP } from "node:net";

export function mayCarrySecret(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    (isIP(host) === 4 && host.startsWith("127.")) ||
    host === "::1"
  );
}
