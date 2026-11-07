export const NAMESPACE_NAME_MAX_LENGTH: 254;
export function isNamespaceName(value: unknown): value is string;
export const NAMESPACE_DESCRIPTION_MAX_LENGTH: 1024;
export function normalizeNamespaceDescription(description: string): string;
export type NamespaceDescriptionProblem = 'invalid-unicode' | 'too-long';
export function namespaceDescriptionProblem(description: string): NamespaceDescriptionProblem | null;
