import { readFileSync } from 'node:fs';
import { z } from 'zod';

interface SchemaNode {
  type?: string;
  const?: string;
  enum?: [string, ...string[]];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: SchemaNode;
  pattern?: string;
  maxLength?: number;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  allOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  dependentRequired?: Record<string, string[]>;
  if?: SchemaNode;
  then?: SchemaNode;
  default?: unknown;
}

// Fixed, vendored input only. The same relative path works from dist-server.
const SCHEMA_URL = new URL(
  '../contracts/ferrum-contracts/schemas/service-manifest/v1.schema.json', import.meta.url,
);

const KEYWORDS = new Set([
  '$schema', '$id', 'title', 'description', 'x-contract', 'type', 'const', 'enum',
  'properties', 'required', 'additionalProperties', 'items', 'pattern', 'maxLength',
  'minItems', 'minimum', 'maximum', 'allOf', 'anyOf', 'dependentRequired', 'if', 'then', 'default',
]);

// Compile only the subset used by this closed contract with our existing Zod
// dependency. Refuse new keywords rather than silently ignoring drift. No
// coercion, key removal, or implicit default insertion during validation.
function compile(node: SchemaNode): z.ZodType {
  if (Object.keys(node).some((key) => !KEYWORDS.has(key))) {
    throw new Error('Unsupported service manifest schema keyword');
  }
  let validator: z.ZodType = z.unknown();
  if (node.const !== undefined) validator = z.literal(node.const);
  else if (node.enum) validator = z.enum(node.enum);
  else if (node.type === 'object' || node.properties || node.required) {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, property] of Object.entries(node.properties ?? {})) {
      const field = compile(property);
      shape[key] = node.required?.includes(key) ? field : field.optional();
    }
    validator = node.additionalProperties === false
      ? z.strictObject(shape)
      : z.object(shape).passthrough();
  } else if (node.type === 'array') {
    if (!node.items) throw new Error('Missing service manifest item schema');
    validator = z.array(compile(node.items)).min(node.minItems ?? 0).max(32);
  } else if (node.type === 'string') {
    // Local presentation budget; not a change to the shared wire contract.
    validator = z.string().max(Math.min(node.maxLength ?? 2048, 2048));
  } else if (node.type === 'integer' || node.type === 'number') {
    let numeric = node.type === 'integer' ? z.number().int() : z.number();
    if (node.minimum !== undefined) numeric = numeric.min(node.minimum);
    if (node.maximum !== undefined) numeric = numeric.max(node.maximum);
    validator = numeric;
  } else if (node.type === 'boolean') validator = z.boolean();
  else if (node.type !== undefined) throw new Error('Unsupported service manifest schema type');

  if (node.required) {
    const required = node.required;
    validator = validator.refine((value) => Boolean(value && typeof value === 'object'
      && required.every((key) => Object.hasOwn(value, key))));
  }
  if (node.pattern) {
    const pattern = new RegExp(node.pattern);
    validator = validator.refine((value) => typeof value !== 'string' || pattern.test(value));
  }
  if (node.allOf) {
    const validators = node.allOf.map(compile);
    validator = validator.refine((value) =>
      validators.every((item) => item.safeParse(value).success));
  }
  if (node.anyOf) {
    const validators = node.anyOf.map(compile);
    validator = validator.refine((value) =>
      validators.some((item) => item.safeParse(value).success));
  }
  if (node.dependentRequired) {
    const dependencies = node.dependentRequired;
    validator = validator.refine((value) => Boolean(value && typeof value === 'object'
      && Object.entries(dependencies).every(([key, required]) => !Object.hasOwn(value, key)
        || required.every((dependency) => Object.hasOwn(value, dependency)))));
  }
  if (node.if) {
    if (!node.then) throw new Error('Missing service manifest conditional schema');
    const condition = compile(node.if);
    const consequent = compile(node.then);
    validator = validator.refine((value) => !condition.safeParse(value).success
      || consequent.safeParse(value).success);
  }
  return validator;
}

export class ServiceManifestSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceManifestSchemaError';
  }
}

export interface ServiceManifestSchema {
  schema: SchemaNode;
  validator: z.ZodType;
}

let loaded: ServiceManifestSchema | undefined;
let loadFailure: ServiceManifestSchemaError | undefined;

function readAndCompile(): ServiceManifestSchema {
  const schema = JSON.parse(readFileSync(SCHEMA_URL, 'utf8')) as SchemaNode;
  return { schema, validator: compile(schema) };
}

// Compile the vendored schema on first use and memoize the outcome, including
// failure. A future contracts re-vendor that adds a keyword, or a missing
// schema file in the deployed image, disables only the preview route rather
// than stopping the whole BFF from starting. Callers treat a thrown
// ServiceManifestSchemaError as the preview being unavailable.
export function serviceManifestSchema(): ServiceManifestSchema {
  if (loaded) return loaded;
  if (loadFailure) throw loadFailure;
  try {
    loaded = readAndCompile();
    return loaded;
  } catch {
    loadFailure = new ServiceManifestSchemaError(
      'The vendored service manifest schema could not be loaded or compiled',
    );
    throw loadFailure;
  }
}

export function manifestDefaults(node: SchemaNode, value: unknown): unknown {
  if (!node.properties || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...value } as Record<string, unknown>;
  for (const [key, property] of Object.entries(node.properties)) {
    if (!Object.hasOwn(result, key) && property.default !== undefined) {
      result[key] = structuredClone(property.default);
    }
    if (Object.hasOwn(result, key)) result[key] = manifestDefaults(property, result[key]);
  }
  return result;
}
