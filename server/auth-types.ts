import type { AuthMode, GatewayRole } from './config.js';

export interface AuthPrincipal {
  subject: string;
  displayName: string;
  role: GatewayRole;
  namespaces: string[] | undefined;
  authMode: AuthMode;
}
