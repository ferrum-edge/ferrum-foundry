/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Namespace API functions                          */
/* ------------------------------------------------------------------ */

import { proxyApi } from "./client";

export async function list(): Promise<string[]> {
  return proxyApi.get("namespaces").json<string[]>();
}
