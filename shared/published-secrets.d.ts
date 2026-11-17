export const PLACEHOLDER_SECRET_PATTERN: RegExp;
export const PUBLISHED_DEVELOPMENT_SECRETS: readonly string[];
export function isPlaceholderSecret(value: unknown): boolean;
export function isPublishedDevelopmentSecret(value: unknown): boolean;
