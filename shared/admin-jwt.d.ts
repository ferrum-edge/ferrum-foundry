export type AdminJwtRole = 'viewer' | 'operator' | 'admin';

export interface AdminJwtOptions {
  secret: string;
  issuer: string;
  subject: string;
  role: AdminJwtRole;
  audience?: string | string[];
  namespaces?: string[];
  /** OAuth 2.0 scope tokens, signed as one space-delimited `scope` claim. */
  scopes?: string[];
  ttlSeconds: number;
  now?: number;
  jti?: string;
}

export function signAdminJwt(options: AdminJwtOptions): Promise<string>;
