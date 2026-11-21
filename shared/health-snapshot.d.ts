export type GatewayHealthStatus = 'ok' | 'degraded' | 'starting' | 'unavailable' | 'draining';
export const GATEWAY_HEALTH_STATUSES: readonly GatewayHealthStatus[];
export interface GatewayHealthSnapshot {
  status: GatewayHealthStatus;
  ready: boolean;
}
export function isGatewayHealthSnapshot(body: unknown): body is GatewayHealthSnapshot;
export function isGatewayHealthAnswer(httpStatus: number, body: unknown): body is GatewayHealthSnapshot;
