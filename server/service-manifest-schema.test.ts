import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ schema: null as string | null }));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const readFile = original.readFileSync as (...args: any[]) => any;
  return {
    ...original,
    readFileSync: ((path: any, ...rest: any[]) => {
      if (String(path).includes('service-manifest/v1.schema.json') && state.schema !== null) {
        return state.schema;
      }
      return readFile(path, ...rest);
    }) as typeof original.readFileSync,
  };
});

const vendored = new URL(
  '../contracts/ferrum-contracts/schemas/service-manifest/v1.schema.json', import.meta.url,
);
const plainHttp = new URL(
  '../contracts/ferrum-contracts/fixtures/service-manifest/valid/plain-http.json', import.meta.url,
);

// A fresh module graph per case, so the memoized schema outcome is recompiled.
async function load(schema: unknown) {
  state.schema = JSON.stringify(schema);
  vi.resetModules();
  return {
    ...await import('./service-manifest-schema.js'),
    ...await import('./service-manifest.js'),
  };
}

function vendoredSchema() {
  return JSON.parse(readFileSync(vendored, 'utf8'));
}

function manifest() {
  return JSON.parse(readFileSync(plainHttp, 'utf8'));
}

afterEach(() => {
  state.schema = null;
});

describe('service manifest string bounds', () => {
  it('honors a declared maxLength above the 2048 default without clamping', async () => {
    // ferrum-contracts main declares api.service_base_path maxLength 2049.
    const schema = vendoredSchema();
    schema.properties.api.properties.service_base_path.maxLength = 2049;
    const { validatedManifest, createManifestPreview } = await load(schema);
    const body = manifest();
    body.api.service_base_path = `/${'a'.repeat(2047)}/`;
    expect(body.api.service_base_path).toHaveLength(2049);
    const accepted = validatedManifest(body);
    expect(accepted).not.toBeNull();
    expect(createManifestPreview(accepted!).desired.proxy.backend_path).toHaveLength(2048);
    body.api.service_base_path = `/${'a'.repeat(2048)}/`;
    expect(validatedManifest(body)).toBeNull();
  });

  it('applies the 2048 default only where no maxLength is declared', async () => {
    const { validatedManifest, MANIFEST_STRING_DEFAULT_MAX_LENGTH } = await load(vendoredSchema());
    expect(MANIFEST_STRING_DEFAULT_MAX_LENGTH).toBe(2048);
    const body = manifest();
    body.service.description = 'x'.repeat(2048);
    expect(validatedManifest(body)).not.toBeNull();
    body.service.description = 'x'.repeat(2049);
    expect(validatedManifest(body)).toBeNull();
  });

  it('honors a declared maxLength below the default', async () => {
    const schema = vendoredSchema();
    schema.properties.service.properties.description.maxLength = 10;
    const { validatedManifest } = await load(schema);
    const body = manifest();
    body.service.description = 'x'.repeat(10);
    expect(validatedManifest(body)).not.toBeNull();
    body.service.description = 'x'.repeat(11);
    expect(validatedManifest(body)).toBeNull();
  });

  it('accepts a bound at the safety cap and refuses to compile one above it', async () => {
    const schema = vendoredSchema();
    const { MANIFEST_STRING_SAFETY_CAP } = await load(schema);
    expect(MANIFEST_STRING_SAFETY_CAP).toBeGreaterThanOrEqual(4096);
    schema.properties.service.properties.description.maxLength = MANIFEST_STRING_SAFETY_CAP;
    const atCap = await load(schema);
    const body = manifest();
    body.service.description = 'x'.repeat(MANIFEST_STRING_SAFETY_CAP);
    expect(atCap.validatedManifest(body)).not.toBeNull();
    body.service.description = 'x'.repeat(MANIFEST_STRING_SAFETY_CAP + 1);
    expect(atCap.validatedManifest(body)).toBeNull();

    schema.properties.service.properties.description.maxLength = MANIFEST_STRING_SAFETY_CAP + 1;
    const aboveCap = await load(schema);
    expect(() => aboveCap.serviceManifestSchema()).toThrow('could not be loaded or compiled');
  });
});

describe('service manifest string bounds in code points', () => {
  it('counts supplementary-plane characters once, in the safety cap and declared bounds', async () => {
    const schema = vendoredSchema();
    schema.properties.service.properties.description.maxLength = 2049;
    const { validatedManifest, MANIFEST_STRING_SAFETY_CAP } = await load(schema);
    const body = manifest();
    // 2,049 code points, 4,098 UTF-16 code units: above the cap in UTF-16.
    body.service.description = '\u{1F600}'.repeat(2049);
    expect(body.service.description.length).toBeGreaterThan(MANIFEST_STRING_SAFETY_CAP);
    expect(validatedManifest(body)).not.toBeNull();
    body.service.description = '\u{1F600}'.repeat(2050);
    expect(validatedManifest(body)).toBeNull();
  });

  it('applies the safety cap to unknown keys in code points', async () => {
    const { validatedManifest, MANIFEST_STRING_SAFETY_CAP } = await load(vendoredSchema());
    const body = manifest();
    body.unknown = '\u{1F600}'.repeat(MANIFEST_STRING_SAFETY_CAP + 1);
    expect(validatedManifest(body)).toBeNull();
  });
});

describe('property names in the safety precheck', () => {
  it.each([
    ['an oversized name', 'k'.repeat(4097)],
    ['a control character', 'unknown\u0007key'],
  ])('refuses %s before schema validation', async (_label, key) => {
    const { validatedManifest, serviceManifestSchema } = await load(vendoredSchema());
    const parse = vi.spyOn(serviceManifestSchema().validator, 'safeParse');
    const body = manifest();
    body[key] = 'v';
    expect(validatedManifest(body)).toBeNull();
    expect(parse).not.toHaveBeenCalled();
    delete body[key];
    expect(validatedManifest(body)).not.toBeNull();
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('counts property names in code points', async () => {
    const { validatedManifest, serviceManifestSchema } = await load(vendoredSchema());
    const parse = vi.spyOn(serviceManifestSchema().validator, 'safeParse');
    const body = manifest();
    // 4,096 code points, 8,192 UTF-16 units: within the cap, so the closed
    // schema (not the precheck) refuses the unknown key.
    body['\u{1F600}'.repeat(4096)] = 'v';
    expect(validatedManifest(body)).toBeNull();
    expect(parse).toHaveBeenCalledTimes(1);
  });
});

describe('maxLength outside a plain string node', () => {
  it('constrains enum values and refuses to compile an enum bound above the cap', async () => {
    const schema = vendoredSchema();
    schema.properties.auth.properties.mode.maxLength = 4;
    const { validatedManifest, MANIFEST_STRING_SAFETY_CAP } = await load(schema);
    const body = manifest();
    body.auth = { mode: 'none' };
    expect(validatedManifest(body)).not.toBeNull();
    body.auth = { mode: 'service' };
    expect(validatedManifest(body)).toBeNull();

    schema.properties.auth.properties.mode.maxLength = MANIFEST_STRING_SAFETY_CAP + 1;
    const aboveCap = await load(schema);
    expect(() => aboveCap.serviceManifestSchema()).toThrow('could not be loaded or compiled');
  });

  it('constrains typed string enum and const members that exceed the bound', async () => {
    const schema = vendoredSchema();
    Object.assign(schema.properties.auth.properties.mode, { type: 'string', maxLength: 4 });
    expect(schema.properties.schema.const).toBe('ferrum.service_manifest');
    Object.assign(schema.properties.schema, { type: 'string', maxLength: 3 });
    const { validatedManifest } = await load(schema);
    const body = manifest();
    body.auth = { mode: 'none' };
    // The const member itself exceeds its bound, so nothing can satisfy it.
    expect(validatedManifest(body)).toBeNull();
    schema.properties.schema.maxLength = 64;
    const typedEnum = await load(schema);
    expect(typedEnum.validatedManifest(body)).not.toBeNull();
    body.auth = { mode: 'service' };
    expect(typedEnum.validatedManifest(body)).toBeNull();
  });

  it('adds no default from composition clauses that also constrain the field', async () => {
    const schema = vendoredSchema();
    const field = schema.properties.api.properties.service_base_path;
    field.maxLength = 2049;
    field.allOf[1].type = 'string';
    schema.properties.api.allOf = [{ properties: { service_base_path: { pattern: '/$' } } }];
    const { validatedManifest } = await load(schema);
    const body = manifest();
    body.api.service_base_path = `/${'a'.repeat(2047)}/`;
    expect(validatedManifest(body)).not.toBeNull();
    body.api.service_base_path = `/${'a'.repeat(2048)}/`;
    expect(validatedManifest(body)).toBeNull();
  });

  it('applies the 2048 default to a field node with clauses but no bound', async () => {
    const { validatedManifest } = await load(vendoredSchema());
    const body = manifest();
    body.api.service_base_path = `/${'a'.repeat(2046)}/`;
    expect(validatedManifest(body)).not.toBeNull();
    body.api.service_base_path = `/${'a'.repeat(2047)}/`;
    expect(validatedManifest(body)).toBeNull();
  });

  it.each([
    ['an allOf clause', (schema: any) => {
      schema.properties.api.properties.service_base_path.allOf.push({ maxLength: 2049 });
    }],
    ['a nested allOf clause', (schema: any) => {
      schema.properties.api.properties.service_base_path.allOf.push({
        allOf: [{ maxLength: 2049 }],
      });
    }],
    ['a property of an object-level allOf clause', (schema: any) => {
      schema.properties.api.allOf = [{ properties: { service_base_path: { maxLength: 2049 } } }];
    }],
    ['an anyOf branch', (schema: any) => {
      schema.properties.api.properties.service_base_path.anyOf = [{ maxLength: 2049 }];
    }],
    ['an if/then clause', (schema: any) => {
      Object.assign(schema.properties.api.properties.service_base_path, {
        if: { pattern: '^/v1/' }, then: { maxLength: 10 },
      });
    }],
    ['typeless array items in an allOf clause', (schema: any) => {
      schema.properties.upstream.properties.protocols.allOf = [{ items: { maxLength: 4 } }];
    }],
    ['typeless array items in an allOf clause, above the cap', (schema: any) => {
      schema.properties.upstream.properties.protocols.allOf = [{ items: { maxLength: 4097 } }];
    }],
  ])('refuses to compile a maxLength in %s', async (_label, place) => {
    const schema = vendoredSchema();
    place(schema);
    const { serviceManifestSchema } = await load(schema);
    expect(() => serviceManifestSchema()).toThrow('could not be loaded or compiled');
  });
});

describe('schema structure the compiler would not process', () => {
  it.each([
    ['items without type array', (schema: any) => {
      schema.properties.upstream.properties.protocols.allOf = [{ items: { enum: ['http1'] } }];
    }],
    ['items beside an enum', (schema: any) => {
      Object.assign(schema.properties.auth.properties.mode, { items: { type: 'string' } });
    }],
    ['properties beside a const', (schema: any) => {
      Object.assign(schema.properties.schema, { properties: { x: { type: 'string' } } });
    }],
    ['then without if', (schema: any) => {
      schema.properties.api.properties.service_base_path.then = { pattern: '^/v1/' };
    }],
  ])('refuses %s', async (_label, place) => {
    const schema = vendoredSchema();
    place(schema);
    const { serviceManifestSchema } = await load(schema);
    expect(() => serviceManifestSchema()).toThrow('could not be loaded or compiled');
  });

  it('compiles the vendored schema and a typed array clause without a bound', async () => {
    const schema = vendoredSchema();
    schema.properties.upstream.properties.protocols.allOf = [{
      type: 'array', items: { enum: ['http1', 'http2'] },
    }];
    const { serviceManifestSchema, validatedManifest } = await load(schema);
    expect(() => serviceManifestSchema()).not.toThrow();
    expect(validatedManifest(manifest())).not.toBeNull();
  });
});

describe('derived resource IDs', () => {
  it('bounds an ID defaulted from the service name by the always-generated trace plugin', async () => {
    // The schema caps service.name at 63 characters, so the 241/242 boundary
    // for a defaulted ID is checked on the normalized manifest directly.
    const { derivedResourceIds, EDGE_RESOURCE_ID_MAX_LENGTH } = await load(vendoredSchema());
    const normalized = (name: string) => ({
      service: { name },
      api: { public_path: '/x', service_base_path: '/', strip_public_path: true },
      upstream: { host: 'h', port: 1, scheme: 'http' as const, protocols: ['http1'] },
      timeouts: { connect_ms: 1, read_ms: 1, write_ms: 1 },
      gateway: { namespace: 'ferrum', correlation_id: false },
      auth: {},
    });
    const longest = (name: string) =>
      Math.max(...derivedResourceIds(normalized(name)).map((id) => id.length));
    expect(derivedResourceIds(normalized('a'.repeat(241)))).toEqual([
      `${'a'.repeat(241)}-otel-tracing`,
    ]);
    expect(longest('a'.repeat(241))).toBe(EDGE_RESOURCE_ID_MAX_LENGTH);
    expect(longest('a'.repeat(242))).toBe(EDGE_RESOURCE_ID_MAX_LENGTH + 1);
    expect(derivedResourceIds({
      ...normalized('svc'),
      health: { path: '/h', interval_seconds: 1, timeout_ms: 1 },
      gateway: { namespace: 'ferrum', correlation_id: true, proxy_id: 'p' },
    })).toEqual(['p-upstream', 'p-correlation-id', 'p-otel-tracing']);
  });
});
