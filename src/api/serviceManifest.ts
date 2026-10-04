import { isHTTPError } from 'ky';
import type { ServiceManifestPreview } from '../../shared/service-manifest.js';
import { api, scoped, SILENT_ERRORS, type NamespaceScope } from './client';

export type { ServiceManifestPreview };

export async function previewServiceManifest(
  scope: NamespaceScope,
  document: string,
  signal?: AbortSignal,
): Promise<ServiceManifestPreview> {
  if (new TextEncoder().encode(document).byteLength > 32 * 1024) {
    throw new Error('Manifest exceeds the 32 KiB preview budget.');
  }
  let status: number;
  try {
    return await api.post('service-manifest/preview', scoped(scope, {
      body: document,
      headers: { 'content-type': 'application/json' },
      signal,
      retry: 0,
      context: { [SILENT_ERRORS]: true },
    })).json<ServiceManifestPreview>();
  } catch (error) {
    // Never retain a ky request/body/cause or echo submitted credential values
    // (including malformed/unknown fields) in the UI or global error popup.
    status = isHTTPError(error) ? error.response.status : 0;
  }
  // Only the numeric status crosses the catch boundary. Deliberately detach
  // the submitted body, parsed error data and original cause before throwing.
  if (status === 401) throw new Error('Sign in to preview a service manifest.');
  if (status === 403) {
    throw new Error('Preview denied. Check session, CSRF and namespace access.');
  }
  if (status === 413) throw new Error('Manifest exceeds the 32 KiB preview budget.');
  if (status === 400 || status === 415) {
    throw new Error('Use supported v1 manifest JSON in the active namespace, within preview limits.');
  }
  throw new Error('Preview unavailable. No configuration was applied; retry to obtain a preview.');
}
