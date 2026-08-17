/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Namespace API functions                          */
/* ------------------------------------------------------------------ */

import { proxyApi } from "./client";
import type { PaginatedResponse } from "./types";

export async function list(): Promise<string[]> {
  // GET /namespaces returns the standard { data, pagination } envelope of
  // plain namespace name strings.
  const response = await proxyApi
    .get("namespaces", { searchParams: { limit: "1000" } })
    .json<PaginatedResponse<string> | string[]>();
  return Array.isArray(response) ? response : response.data;
}
