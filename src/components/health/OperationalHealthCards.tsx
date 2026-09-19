import type { HealthResponse } from '@/api/types';
import type { LoggingSink, KafkaSink } from '@/api/health';
import { CounterNote, HealthFields, HealthSection, namedFields } from './HealthSection';

const LOG_COUNTERS = ['accepted_records_total', 'saturation_dropped_records_total', 'oversized_dropped_records_total', 'closed_dropped_records_total', 'writer_failures_total', 'flush_failures_total', 'shutdown_timeouts_total', 'shutdown_incomplete_records_total'] as const;
const KAFKA_COUNTERS = ['admitted_total', 'delivered_total', 'delivery_failed_total', 'queue_rejected_total', 'ferrum_dropped_total', 'entry_oversize_total', 'byte_budget_exhausted_total', 'flush_failures_total', 'flush_timeouts_total', 'shutdown_incomplete_total'] as const;
const logLoss = (s: LoggingSink) => LOG_COUNTERS.slice(1).some((k) => s[k] > 0);
const kafkaLoss = (s: KafkaSink) => KAFKA_COUNTERS.slice(2).some((k) => s[k] > 0);

/** Supplements (never replaces) the gateway's coarse process/readiness verdict. */
export function healthFindings(h: HealthResponse): string[] {
  const findings: string[] = [];
  if (h.database?.status === 'disconnected') findings.push('Database disconnected');
  if (h.database?.failover_topology?.primary_active === false) findings.push('Database failover topology active');
  if (h.config_rejected) findings.push('Configuration rejected');
  if (h.fips?.enforcing && (!h.fips.module_self_test_passed || !h.fips.provider_algorithms_approved)) findings.push('FIPS enforcement checks failed');
  const l = h.gateway_listeners;
  if (l && (l.active_failures > 0 || l.failed_ports > 0 || (l.failures?.length ?? 0) > 0 || l.truncated || l.overflowed || l.active_listeners < l.desired_listeners)) findings.push('Gateway listeners need attention');
  if (h.listener_failures && h.listener_failures.failures_total > 0) findings.push('Sticky serving listener failures');
  const p = h.database_polling;
  if (p && (p.status === 'degraded' || (p.current_backoff_seconds ?? 0) > 0 || (p.consecutive_identical_rejections ?? 0) > 0 || p.change_stream?.connected === false)) findings.push('Database polling / reload latency');
  if (h.logging && Object.values(h.logging).some(s => s && (s.healthy === false || s.accepting === false || logLoss(s)))) findings.push('Process logging failures or recorded loss');
  if (h.log_sink_record_loss && h.log_sink_record_loss.dropped_total > 0) findings.push('Plugin log records lost');
  if (h.kafka_logging?.some(s => s.healthy === false || (!s.finalized && s.accepting === false) || kafkaLoss(s))) findings.push('Kafka logging failures or recorded loss');
  if (h.ai_transcript_audit?.some(s => s.sink_healthy === false || s.retained_byte_drops > 0 || s.stream_reservations_expired > 0)) findings.push('AI transcript delivery or recorded loss');
  const a = h.audit_pipeline;
  if (a && (a.available === false || a.degraded || a.evidence_lost || a.durability === 'memory' || a.fail_open_unaudited_mutations_total > 0 || a.delivery_failures_total > 0 || a.dropped_durable_handoff_failed_total > 0 || a.dropped_no_durable_spool_total > 0 || a.dropped_retained_capacity_total > 0)) findings.push('Admin audit availability / evidence');
  if (h.jwks_trust && (h.jwks_trust.expired > 0 || h.jwks_trust.grace > 0)) findings.push('Remote JWKS freshness');
  const d = h.service_discovery;
  if (d && (d.readiness_failing > 0 || d.stale > 0 || d.restarting > 0 || d.crash_looping > 0 || d.withdrawn > 0 || d.never_succeeded > 0)) findings.push('Service discovery lifecycle');
  const t = h.cp_dp_trust;
  if (t && (t.degraded || t.stale || t.admission_blocked || t.readiness_blocked)) findings.push('CP/DP verification trust');
  if (h.dp_config && (h.dp_config.stale || h.dp_config.new_traffic_blocked || h.dp_config.applied_snapshot === false || h.dp_config.cp_connected === false)) findings.push('Data plane configuration authority');
  if (h.replay_authority && h.replay_authority.shared_authorities_unavailable > 0) findings.push('Shared replay authority unavailable');
  const m = h.mesh;
  if (m?.config_stream && (m.config_stream.state !== 'connected' || m.config_stream.consecutive_failures > 0 || m.config_stream.fallback_active)) findings.push('Mesh configuration stream');
  const waypoint = m?.node_waypoint_observability;
  if (waypoint && (waypoint.hbone_handshakes?.inbound_tls_failure > 0 || waypoint.hbone_handshakes?.inbound_connect_failure > 0 || waypoint.hbone_handshakes?.outbound_dial_failure > 0 || waypoint.missing_destination_metadata > 0 || waypoint.plaintext_fallback_attempts > 0)) findings.push('Node waypoint recorded failures');
  if (m?.udp_placement_migration?.failure_reason && m.udp_placement_migration.failure_reason !== 'none') findings.push('UDP placement migration');
  return findings;
}

export function OperationalHealthCards({ health: h }: { health: HealthResponse }) {
  const l = h.gateway_listeners;
  const p = h.database_polling;
  const j = h.jwks_trust;
  const d = h.service_discovery;
  const t = h.cp_dp_trust;
  const c = h.dp_config;
  const m = h.mesh;
  return <>
    {l && <HealthSection title="Gateway listeners" tone={l.active_failures > 0 || l.failed_ports > 0 || (l.failures?.length ?? 0) > 0 ? 'red' : l.truncated || l.overflowed || l.active_listeners < l.desired_listeners ? 'yellow' : 'default'}>
      <HealthFields fields={namedFields(l, ['config_generation', 'desired_listeners', 'active_listeners', 'failed_ports', 'active_failures', 'retained_failures'])} />
      {l.truncated && <p className="text-warning text-sm">Failure details truncated: the retained list is incomplete.</p>}
      {l.overflowed && <p role="alert" className="text-danger text-sm">Failure ledger overflowed: counts cover tracked identities only and can understate the outage.</p>}
      <p className="text-xs text-text-muted">Current, recoverable failures. QUIC failures affect HTTP/3; TCP may still serve. An active/desired gap can also reflect pending reconciliation.</p>
      {l.active_by_category?.map((f) => <p key={`${f.protocol}/${f.category}`} className="text-sm text-danger">{f.protocol} · {f.category}: {f.count}</p>)}
      {l.failures?.map((f) => <div key={`${f.port}/${f.protocol}/${f.category}`} className="border-t border-border pt-3 space-y-2">
        <h3 className="text-danger text-sm font-medium">Port {f.port} · {f.protocol} · {f.category}</h3>
        <p className="text-sm text-text-secondary break-words">{f.detail}</p>
        <HealthFields fields={namedFields(f, ['origin', 'config_generation', 'observations'])} />
        <HealthFields fields={[
          ['First observed', new Date(f.first_observed_unix_ms).toLocaleString()],
          ['Last observed', new Date(f.last_observed_unix_ms).toLocaleString()],
        ]} />
      </div>)}
    </HealthSection>}
    {h.listener_failures && <HealthSection title="Serving listener failures" tone={h.listener_failures.failures_total > 0 ? 'red' : 'default'} status="Sticky process history">
      <HealthFields fields={[["Failures total", h.listener_failures.failures_total]]} />
      <p className="text-sm text-text-secondary">Post-bind serving task exits remain a readiness failure for this process, even after another listener recovers.</p>
      {h.listener_failures.failures?.map((f, i) => <p key={i} className="text-sm text-danger">{f.listener} · port {f.listen_port} · {f.kind}: {f.error}</p>)}
    </HealthSection>}
    {p && <HealthSection title="Database polling" tone={p.status === 'degraded' || (p.current_backoff_seconds ?? 0) > 0 ? 'yellow' : 'default'} status={p.status}>
      <HealthFields fields={namedFields(p, ['reason', 'resource_category', 'validation_category', 'consecutive_identical_rejections', 'current_backoff_bucket', 'current_backoff_seconds', 'escalated', 'last_poll_completed_at'])} />
      <p className="text-xs text-text-muted">Backoff delays propagation. A completed poll can be a handled error or rejection; its timestamp does not prove configuration applied.</p>
      {p.change_stream && <>
        <h3 className="text-sm font-medium text-text-primary">Config-change watcher</h3>
        {p.change_stream.connected === false && <p className="text-warning text-sm">Watcher disconnected. Periodic polling remains authoritative; this is a reload-latency signal.</p>}
        <HealthFields fields={namedFields(p.change_stream, ['enabled', 'connected', 'degraded_reason', 'resume_token_retained', 'last_event_at', 'events_total', 'reconnects_total', 'invalidations_total', 'history_losses_total'])} />
      </>}
    </HealthSection>}
    {h.namespace && <HealthSection title="Namespace serving scope">
      <HealthFields fields={[
        ['Active data-plane namespace', h.namespace.active === null ? 'No local data plane' : h.namespace.active],
        ['Serving scope', h.namespace.serving_scope],
        ['Single namespace data plane', h.namespace.data_plane_single_namespace],
      ]} />
      {h.namespace.data_plane_single_namespace && <p className="text-sm text-text-secondary">The Admin API can store other namespaces, but this process routes only its active namespace.</p>}
    </HealthSection>}
    {j && <HealthSection title="Remote JWKS trust" tone={j.expired > 0 ? 'red' : j.grace > 0 ? 'yellow' : 'default'}>
      <HealthFields fields={namedFields(j, ['fresh', 'grace', 'expired'])} />
      <h3 className="text-sm font-medium text-text-primary">Maximum age in seconds</h3>
      {j.max_age_seconds && <HealthFields fields={namedFields(j.max_age_seconds, ['fresh', 'grace', 'expired'])} />}
      <p className="text-xs text-text-muted">Active remote stores only. Grace degrades trust; expired stores fail readiness and token verification. Inline and retired stores are excluded.</p>
    </HealthSection>}
    {h.logging && (['stdout', 'stderr'] as const).map(name => {
      const s = h.logging?.[name];
      return <HealthSection key={name} title={`Process logging · ${name}`} tone={s?.healthy === false || s?.accepting === false ? 'red' : s && logLoss(s) ? 'yellow' : 'default'}
        status={!s ? 'Not reported' : s.healthy === false ? 'Unhealthy' : s.accepting === false ? 'Not accepting' : logLoss(s) ? 'Historical failures / loss' : 'Observed'}>
        {s ? <>
          <HealthFields fields={namedFields(s, ['healthy', 'accepting', 'queued_records', 'queued_bytes', 'reserved_bytes', 'queue_capacity_records', 'queue_capacity_bytes', 'max_record_bytes'])} />
          {s.last_failure && <HealthFields fields={namedFields(s.last_failure, ['operation', 'error_kind', 'occurred_at'])} />}
          <CounterNote /><HealthFields fields={namedFields(s, LOG_COUNTERS)} />
        </> : <p className="text-sm text-text-muted">No sink snapshot is available.</p>}
      </HealthSection>;
    })}
    {h.log_sink_record_loss && <HealthSection title="Plugin log record loss" tone={h.log_sink_record_loss.dropped_total > 0 ? 'yellow' : 'default'}>
      <CounterNote />
      <HealthFields fields={namedFields(h.log_sink_record_loss, ['dropped_total', 'accepted_total'])} />
      {Object.entries(h.log_sink_record_loss.dropped_by_plugin ?? {}).map(([plugin, reasons]) => <div key={plugin}>
        <h3 className="text-sm font-medium text-text-primary mb-2">{plugin}</h3>
        <HealthFields fields={Object.entries(reasons).map(([reason, count]) => [reason.replaceAll('_', ' '), count])} />
      </div>)}
    </HealthSection>}
    {h.kafka_logging && <HealthSection title="Kafka logging" tone={h.kafka_logging.some(s => s.healthy === false || (!s.finalized && s.accepting === false)) ? 'red' : h.kafka_logging.some(kafkaLoss) ? 'yellow' : 'default'}>
      {h.kafka_logging.length === 0 && <p className="text-sm text-text-muted">No Kafka sink generations reported.</p>}
      {h.kafka_logging.map(s => <div key={s.generation_id} className="space-y-3 border-t border-border pt-3 first:border-0 first:pt-0">
        <h3 className="text-sm font-medium text-text-primary">Generation {s.generation_id}{s.finalized ? ' · Finalized' : ''}</h3>
        <HealthFields fields={namedFields(s, ['healthy', 'accepting', 'finalized', 'in_flight', 'retained_bytes', 'buffer_max_bytes', 'max_entry_bytes', 'flush_timeout_seconds'])} />
        {s.last_failure && <HealthFields fields={namedFields(s.last_failure, ['operation', 'error_kind', 'occurred_at'])} />}
        <CounterNote scope="sink generation" /><HealthFields fields={namedFields(s, KAFKA_COUNTERS)} />
      </div>)}
    </HealthSection>}
    {h.ai_transcript_audit && <HealthSection title="AI transcript audit" tone={h.ai_transcript_audit.some(s => s.sink_healthy === false) ? 'red' : h.ai_transcript_audit.some(s => s.retained_byte_drops > 0 || s.stream_reservations_expired > 0) ? 'yellow' : 'default'}>
      {h.ai_transcript_audit.length === 0 && <p className="text-sm text-text-muted">No AI transcript audit instances reported.</p>}
      {h.ai_transcript_audit.map(s => <div key={s.instance_id} className="space-y-3 border-t border-border pt-3 first:border-0 first:pt-0">
        <h3 className="text-sm font-medium text-text-primary">Instance {s.instance_id}</h3>
        <HealthFields fields={namedFields(s, ['sink_healthy', 'retained_bytes', 'buffer_max_bytes', 'retained_byte_drops', 'stream_reservations_expired', 'stream_hash_scope', 'ack_policy', 'ack_max_bytes', 'ack_timeout_ms'])} />
        <CounterNote scope="plugin instance" />
        <details><summary className="text-sm cursor-pointer text-text-secondary">Admitted capture and retention limits</summary>
          <div className="mt-3"><HealthFields fields={namedFields(s, ['max_request_bytes', 'max_response_bytes', 'max_stream_capture_bytes', 'hard_max_request_bytes', 'hard_max_response_bytes', 'hard_max_stream_capture_bytes', 'hard_max_capture_bytes_aggregate', 'max_model_bytes', 'max_tool_names', 'max_tool_name_bytes', 'max_tool_names_aggregate_bytes', 'max_retained_record_bytes', 'max_redaction_scan_bytes', 'max_entry_bytes', 'max_entry_retained_bytes', 'max_stream_reservation_secs'])} /></div>
        </details>
      </div>)}
    </HealthSection>}
    {d && <HealthSection title="Service discovery" tone={d.readiness_failing > 0 ? 'red' : d.stale > 0 || d.restarting > 0 || d.crash_looping > 0 || d.withdrawn > 0 || d.never_succeeded > 0 ? 'yellow' : 'default'}>
      <HealthFields fields={namedFields(d, ['tasks', 'running', 'restarting', 'crash_looping', 'stale', 'withdrawn', 'readiness_failing', 'never_succeeded', 'max_anchor_age_seconds'])} />
      {d.upstreams?.map(u => <div key={u.upstream} className="border-t border-border pt-3 space-y-2">
        <h3 className="text-sm font-medium text-text-primary">{u.upstream}</h3>
        <HealthFields fields={namedFields(u, ['provider', 'state', 'stale', 'withdrawn', 'policy', 'max_stale_seconds', 'last_success_age_seconds', 'anchor_age_seconds', 'consecutive_failures', 'consecutive_crashes', 'restarts', 'last_error'])} />
      </div>)}
    </HealthSection>}
    {t && <HealthSection title="CP/DP verification trust" tone={t.readiness_blocked || t.admission_blocked ? 'red' : t.degraded || t.stale ? 'yellow' : 'default'}>
      <HealthFields fields={namedFields(t, ['configured', 'worker_state', 'worker_running', 'degraded', 'stale', 'admission_blocked', 'readiness_blocked', 'reason', 'last_attempt_age_seconds', 'last_acceptance_age_seconds', 'max_stale_seconds', 'unbounded_stale_allowed', 'consecutive_failures', 'active_generation'])} />
      <CounterNote /><HealthFields fields={namedFields(t, ['recoveries_total', 'attempts_total', 'acceptances_total', 'rejections_total'])} />
      <HealthFields fields={Object.entries(t.rejections_by_reason ?? {}).map(([reason, count]) => [`Rejections · ${reason}`, count])} />
    </HealthSection>}
    {c && <HealthSection title="Data plane configuration" tone={c.new_traffic_blocked || c.stale ? 'red' : c.cp_connected === false || c.applied_snapshot === false ? 'yellow' : 'default'}>
      <HealthFields fields={namedFields(c, ['stale', 'reason', 'stale_action', 'new_traffic_blocked', 'cp_connected', 'cp_authority', 'cp_disconnected_seconds', 'max_stale_seconds', 'applied_snapshot', 'snapshot_age_seconds'])} />
      <CounterNote /><HealthFields fields={namedFields(c, ['applied_total', 'rejected_total', 'apply_failed_total', 'stale_transitions_total', 'cp_admission_refused_total'])} />
    </HealthSection>}
    {h.replay_authority && <HealthSection title="Shared replay authority" tone={h.replay_authority.shared_authorities_unavailable > 0 ? 'red' : 'default'}>
      <HealthFields fields={namedFields(h.replay_authority, ['shared_authorities', 'shared_authorities_unavailable'])} />
      <p className="text-sm text-text-secondary">Unavailable shared authorities fail protected requests closed and fail readiness. There is no local fallback.</p>
    </HealthSection>}
    {m && <HealthSection title="Mesh runtime health" tone={healthFindings({ status: h.status, ready: h.ready, mesh: m }).length > 0 ? 'yellow' : 'default'}>
      {m.egress_scope && <>
        <h3 className="text-sm font-medium text-text-primary">Egress scope</h3>
        <HealthFields fields={namedFields(m.egress_scope, ['sidecar_admitted_services', 'sidecar_denied_services'])} />
        <p className="text-xs text-text-muted">Scope exclusions describe policy, not necessarily a runtime fault.</p>
      </>}
      <h3 className="text-sm font-medium text-text-primary">Configuration stream</h3>
      {m.config_stream ? <HealthFields fields={namedFields(m.config_stream, ['protocol', 'state', 'last_attempt_outcome', 'fallback_active', 'consecutive_failures', 'credential', 'liveness_bound_seconds'])} /> : <p className="text-sm text-text-muted">No stream reported (localized file sources have none).</p>}
      {m.udp_placement_migration && <>
        <h3 className="text-sm font-medium text-text-primary">UDP placement migration</h3>
        <HealthFields fields={namedFields(m.udp_placement_migration, ['enabled', 'phase', 'outstanding', 'failure_reason', 'established_adoption', 'adoption_proof'])} />
      </>}
      {m.node_waypoint_observability && <>
        <h3 className="text-sm font-medium text-text-primary">Node waypoint observations</h3>
        <HealthFields fields={namedFields(m.node_waypoint_observability, ['enabled', 'missing_destination_metadata', 'plaintext_fallback_attempts'])} />
        <CounterNote />
        <h4 className="text-sm text-text-secondary">HBONE handshakes</h4>
        <HealthFields fields={namedFields(m.node_waypoint_observability.hbone_handshakes, ['inbound_tls_success', 'inbound_tls_failure', 'inbound_connect_success', 'inbound_connect_failure', 'outbound_dial_success', 'outbound_dial_failure'])} />
        <h4 className="text-sm text-text-secondary">Asserted identity</h4>
        <HealthFields fields={namedFields(m.node_waypoint_observability.asserted_identity, ['accepted', 'rejected_untrusted_assertor', 'rejected_assertion_out_of_scope', 'rejected_trust_domain_mismatch', 'rejected_unauthenticated_hbone', 'rejected_malformed', 'rejected_stale_or_unknown'])} />
        <h4 className="text-sm text-text-secondary">Destination policy rejections</h4>
        <HealthFields fields={namedFields(m.node_waypoint_observability.destination_policy_rejections, ['authz_deny', 'scope_missing', 'destination_scope_missing', 'relay_destination_denied'])} />
      </>}
    </HealthSection>}
  </>;
}
