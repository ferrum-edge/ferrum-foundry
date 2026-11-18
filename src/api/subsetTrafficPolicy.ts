/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – the server-owned subset traffic_policy fields    */
/*                                                                    */
/*  The one list of `subsets[].traffic_policy` fields Ferrum Edge     */
/*  refuses on an operator write. The upstream editor's save          */
/*  (`writableSubset` in `upstreams.ts`) and the mock gateway         */
/*  (`scripts/mock-admin-gateway.mjs`) both read it. The module       */
/*  imports nothing, so the drift check                                */
/*  (`scripts/subset-traffic-policy-drift.mjs`) and the mock can load  */
/*  it directly with Node.                                             */
/* ------------------------------------------------------------------ */

/**
 * Where the list below comes from: the `readOnly` properties of the
 * `SubsetTrafficPolicy` schema in Edge's `openapi.yaml`, at the commit of the
 * Edge image CI qualifies (`edge.source_commit` in `docs/compatibility.json`).
 * The drift check fails when the list differs from that source, or when
 * `commit` is not that commit: moving the pin means re-reading the schema,
 * even when nothing in it changed.
 */
export const SUBSET_TRAFFIC_POLICY_SOURCE = {
  repository: "ferrum-edge/ferrum-edge",
  path: "openapi.yaml",
  component: "SubsetTrafficPolicy",
  /** The Edge source the list was last checked against. */
  commit: "e4a606a00352674daaef08636e3e359e6c48ba18",
  /** The Edge release at that commit. */
  release: "v0.9.20",
} as const;

/**
 * The `subsets[].traffic_policy` fields Ferrum Edge projects from a mesh
 * DestinationRule and refuses on every operator write (admin POST/PUT,
 * import, restore, file config). A read can carry them; a write must omit
 * them, or Edge answers `400`. They are the `readOnly` properties of
 * `SubsetTrafficPolicy` in `openapi.yaml`, which Edge enforces with the
 * `policy.<field>.is_some()` checks in
 * `Upstream::validate_operator_provided_fields` (`src/config/types.rs`), in
 * that order. Every other subset field (`name`, `labels`,
 * `load_balancer_algorithm`, `hash_on`, and any field Edge adds that it does
 * not refuse) is operator-writable and carried through a save.
 */
export const SUBSET_TRAFFIC_POLICY_SERVER_OWNED: readonly string[] = Object.freeze([
  "tls",
  "connect_timeout_ms",
  "h2_upgrade_policy",
  "max_retries",
  "http1_max_pending_requests",
  "http_idle_timeout_ms",
  "http2_max_requests",
  "h2_max_concurrent_streams",
  "passive_health_check",
]);
