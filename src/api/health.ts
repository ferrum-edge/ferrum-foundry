/** Authenticated /health sections, matched to upstream serializers (9cd5398).
 * Optional sections indicate presence, never an implicit healthy/zero value.
 */
export interface AuditPipelineStatus {
  enabled: boolean;
  durability: 'spool' | 'memory' | 'disabled';
  policy: 'fail_open' | 'fail_closed';
  available: boolean;
  last_unavailable_reason: string;
  degraded: boolean;
  degraded_reason: string;
  evidence_lost: boolean;
  queue_capacity: number;
  spool_max_records: number;
  retained_max_records: number;
  max_delivery_attempts: number;
  accepted_total: number;
  prepared_total: number;
  finalized_total: number;
  unknown_outcome_total: number;
  enqueued_total: number;
  delivered_total: number;
  retries_total: number;
  delivery_failures_total: number;
  retained_total: number;
  replayed_total: number;
  corrupt_records_total: number;
  destination_mismatch_total: number;
  truncated_diffs_total: number;
  dropped_durable_handoff_failed_total: number;
  dropped_no_durable_spool_total: number;
  dropped_retained_capacity_total: number;
  fail_open_unaudited_mutations_total: number;
  fail_closed_rejections_total: number;
  queue_depth: number;
  delivery_in_flight: number;
  spool_prepared_records: number;
  spool_pending_records: number;
  spool_retained_records: number;
}

export interface GatewayListeners {
  config_generation: number;
  desired_listeners: number;
  active_listeners: number;
  failed_ports: number;
  active_failures: number;
  retained_failures: number;
  truncated: boolean;
  overflowed: boolean;
  active_by_category: { protocol: 'tcp' | 'quic'; category: string; count: number }[];
  failures: {
    port: number;
    protocol: 'tcp' | 'quic';
    category: string;
    origin: 'admission' | 'runtime';
    config_generation: number;
    detail: string;
    first_observed_unix_ms: number;
    last_observed_unix_ms: number;
    observations: number;
  }[];
}

export interface DatabasePollingHealth {
  status: 'ok' | 'degraded';
  reason?: string;
  resource_category?: string;
  validation_category?: string;
  consecutive_identical_rejections?: number;
  current_backoff_bucket?: string;
  current_backoff_seconds?: number;
  escalated?: boolean;
  last_poll_completed_at?: string;
  change_stream?: {
    enabled: boolean;
    connected: boolean;
    degraded_reason: string;
    events_total: number;
    reconnects_total: number;
    invalidations_total: number;
    history_losses_total: number;
    resume_token_retained: boolean;
    last_event_at?: string;
  };
}

export interface SinkFailure {
  operation: string;
  error_kind: string;
  occurred_at: string;
}

export interface LoggingSink {
  sink: 'stdout' | 'stderr';
  healthy: boolean;
  accepting: boolean;
  queue_capacity_records: number;
  queue_capacity_bytes: number;
  max_record_bytes: number;
  queued_records: number;
  reserved_bytes: number;
  queued_bytes: number;
  accepted_records_total: number;
  saturation_dropped_records_total: number;
  oversized_dropped_records_total: number;
  closed_dropped_records_total: number;
  writer_failures_total: number;
  flush_failures_total: number;
  shutdown_timeouts_total: number;
  shutdown_incomplete_records_total: number;
  last_failure: SinkFailure | null;
}

export interface KafkaSink {
  generation_id: number;
  healthy: boolean;
  accepting: boolean;
  finalized: boolean;
  flush_timeout_seconds: number;
  max_entry_bytes: number;
  buffer_max_bytes: number;
  retained_bytes: number;
  admitted_total: number;
  delivered_total: number;
  delivery_failed_total: number;
  queue_rejected_total: number;
  ferrum_dropped_total: number;
  entry_oversize_total: number;
  byte_budget_exhausted_total: number;
  flush_failures_total: number;
  flush_timeouts_total: number;
  shutdown_incomplete_total: number;
  in_flight: number;
  last_failure: SinkFailure | null;
}

export interface AiTranscriptAudit {
  instance_id: number;
  max_request_bytes: number;
  max_response_bytes: number;
  max_stream_capture_bytes: number;
  hard_max_request_bytes: number;
  hard_max_response_bytes: number;
  hard_max_stream_capture_bytes: number;
  hard_max_capture_bytes_aggregate: number;
  max_model_bytes: number;
  max_tool_names: number;
  max_tool_name_bytes: number;
  max_tool_names_aggregate_bytes: number;
  max_retained_record_bytes: number;
  max_redaction_scan_bytes: number;
  max_entry_bytes: number;
  max_entry_retained_bytes: number;
  buffer_max_bytes: number;
  retained_bytes: number;
  retained_byte_drops: number;
  max_stream_reservation_secs: number;
  stream_reservations_expired: number;
  stream_hash_scope: 'capped' | 'full';
  ack_policy: 'drain' | 'json';
  ack_max_bytes: number;
  ack_timeout_ms: number;
  sink_healthy: boolean;
}

export interface ServiceDiscoveryHealth {
  tasks: number;
  running: number;
  restarting: number;
  crash_looping: number;
  stale: number;
  withdrawn: number;
  readiness_failing: number;
  never_succeeded: number;
  max_anchor_age_seconds: number;
  upstreams: {
    upstream: string;
    provider: string;
    state: string;
    stale: boolean;
    withdrawn: boolean;
    policy: string;
    max_stale_seconds: number;
    last_success_age_seconds: number | null;
    anchor_age_seconds: number;
    consecutive_failures: number;
    consecutive_crashes: number;
    restarts: number;
    last_error: string | null;
  }[];
}

export interface CpDpTrustHealth {
  configured: boolean;
  worker_state: string;
  worker_running: boolean;
  degraded: boolean;
  stale: boolean;
  admission_blocked: boolean;
  readiness_blocked: boolean;
  reason: string;
  last_attempt_age_seconds: number | null;
  last_acceptance_age_seconds: number | null;
  max_stale_seconds: number;
  unbounded_stale_allowed: boolean;
  consecutive_failures: number;
  recoveries_total: number;
  attempts_total: number;
  acceptances_total: number;
  rejections_total: number;
  active_generation: string | null;
  rejections_by_reason: Record<string, number>;
}

export interface DpConfigHealth {
  stale: boolean;
  reason: string;
  stale_action: 'fail_closed' | 'readiness_only';
  new_traffic_blocked: boolean;
  cp_connected: boolean;
  cp_authority: 'connected' | 'reconnecting' | 'lost';
  cp_disconnected_seconds: number;
  max_stale_seconds: number;
  applied_snapshot: boolean;
  snapshot_age_seconds: number;
  applied_total: number;
  rejected_total: number;
  apply_failed_total: number;
  stale_transitions_total: number;
  cp_admission_refused_total: number;
}

export interface MeshHealth {
  egress_scope: { sidecar_admitted_services: number; sidecar_denied_services: number };
  config_stream: {
    protocol: string;
    state: string;
    last_attempt_outcome: string;
    fallback_active: boolean;
    consecutive_failures: number;
    credential: string;
    liveness_bound_seconds: number;
  } | null;
  node_waypoint_observability: {
    enabled: boolean;
    hbone_handshakes: {
      inbound_tls_success: number;
      inbound_tls_failure: number;
      inbound_connect_success: number;
      inbound_connect_failure: number;
      outbound_dial_success: number;
      outbound_dial_failure: number;
    };
    asserted_identity: {
      accepted: number;
      rejected_untrusted_assertor: number;
      rejected_assertion_out_of_scope: number;
      rejected_trust_domain_mismatch: number;
      rejected_unauthenticated_hbone: number;
      rejected_malformed: number;
      rejected_stale_or_unknown: number;
    };
    destination_policy_rejections: {
      authz_deny: number;
      scope_missing: number;
      destination_scope_missing: number;
      relay_destination_denied: number;
    };
    missing_destination_metadata: number;
    plaintext_fallback_attempts: number;
  };
  udp_placement_migration: {
    enabled: boolean;
    phase: string;
    outstanding: number;
    failure_reason: string;
    established_adoption: boolean;
    adoption_proof: string;
  };
}

export interface DetailedHealthSections {
  gateway_listeners?: GatewayListeners;
  listener_failures?: {
    failures_total: number;
    failures: { listener: string; listen_port: number; error: string; kind: 'serve_failed' }[];
  };
  database_polling?: DatabasePollingHealth;
  logging?: { stdout: LoggingSink | null; stderr: LoggingSink | null };
  log_sink_record_loss?: {
    dropped_total: number;
    accepted_total: number;
    dropped_by_plugin: Record<string, Record<string, number>>;
  };
  kafka_logging?: KafkaSink[];
  ai_transcript_audit?: AiTranscriptAudit[];
  audit_pipeline?: AuditPipelineStatus;
  jwks_trust?: {
    fresh: number;
    grace: number;
    expired: number;
    max_age_seconds: { fresh: number; grace: number; expired: number };
  };
  namespace?: {
    active: string | null;
    serving_scope: 'single-namespace-data-plane' | 'control-plane' | 'no-data-plane';
    data_plane_single_namespace: boolean;
  };
  mesh?: MeshHealth;
  service_discovery?: ServiceDiscoveryHealth;
  cp_dp_trust?: CpDpTrustHealth;
  dp_config?: DpConfigHealth;
  replay_authority?: { shared_authorities: number; shared_authorities_unavailable: number };
}
