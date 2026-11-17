/**
 * Secret values Foundry itself publishes, which therefore protect nothing.
 * Shared by the BFF's startup checks (`server/config.ts`) and the starter
 * preflight (`scripts/starter-preflight.mjs`), so the two agree on what counts
 * as an unedited value. Pure: no Node or browser APIs.
 *
 * Neither function returns or echoes the value it inspects.
 */

/**
 * The placeholder shape `deploy/starter/.env.example` ships
 * (`replace-me-with-...`). A copied-but-unedited `.env` carries it.
 */
export const PLACEHOLDER_SECRET_PATTERN = /replace[-_]?me/i;

/**
 * Example values the development instructions (CLAUDE.md / AGENTS.md) print
 * for a local stack. They are fine for `npm run dev` against a throwaway
 * gateway and worthless anywhere else.
 */
export const PUBLISHED_DEVELOPMENT_SECRETS = Object.freeze([
  'dev-secret-at-least-32-characters-long',
  'dev-bff-token-at-least-32-characters-long',
]);

/** Whether `value` still carries the `.env.example` placeholder. */
export function isPlaceholderSecret(value) {
  return typeof value === 'string' && PLACEHOLDER_SECRET_PATTERN.test(value);
}

/** Whether `value` is one of the published development example values. */
export function isPublishedDevelopmentSecret(value) {
  return typeof value === 'string' && PUBLISHED_DEVELOPMENT_SECRETS.includes(value.trim());
}
