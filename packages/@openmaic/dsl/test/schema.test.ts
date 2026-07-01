import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { validateAction } from '@openmaic/dsl';
// JS codegen helper (the build-only generator); vitest/esbuild resolves it at
// runtime and tsc infers its exports via allowJs.
import { generateSchema } from '../scripts/gen-schema.mjs';

// Generate every root schema once (the generator parses the TS program a single
// time and is reused), then compile per case — no repeated heavy codegen.
const schemas = {
  Stage: generateSchema('Stage'),
  Action: generateSchema('Action'),
  SerializedScene: generateSchema('SerializedScene'),
} as const;

function validator(root: keyof typeof schemas) {
  return new Ajv({ allErrors: true, strict: false }).compile(schemas[root]);
}

describe('generated JSON Schema — Stage', () => {
  const v = validator('Stage');
  it('accepts a well-formed stage', () => {
    expect(v({ id: 's', name: 'n', createdAt: 1, updatedAt: 2 })).toBe(true);
  });
  it('rejects a stage missing required fields', () => {
    expect(v({ id: 's' })).toBe(false);
  });
});

describe('generated JSON Schema — Action', () => {
  const v = validator('Action');
  it('accepts a spotlight action', () => {
    expect(v({ id: 'a', type: 'spotlight', elementId: 'e' })).toBe(true);
  });
  it('rejects an action missing its required discriminated fields', () => {
    expect(v({ id: 'a', type: 'spotlight' /* missing elementId */ })).toBe(false);
  });
});

describe('generated JSON Schema — SerializedScene', () => {
  const v = validator('SerializedScene');
  const slideScene = {
    id: 'sc',
    stageId: 'st',
    type: 'slide',
    title: 't',
    order: 0,
    content: {
      type: 'slide',
      canvas: {
        id: 'c',
        viewportSize: 1920,
        viewportRatio: 0.5625,
        theme: { themeColors: [], fontColor: '#000', fontName: 'Arial', backgroundColor: '#fff' },
        elements: [],
      },
    },
  };
  it('accepts a well-formed slide scene', () => {
    expect(v(slideScene)).toBe(true);
  });
  it('rejects a scene missing required fields', () => {
    expect(v({ id: 'sc' })).toBe(false);
  });
  it('rejects content that is not a contract content kind (slide/quiz)', () => {
    expect(v({ ...slideScene, content: { type: 'pbl' } })).toBe(false);
  });
  it('rejects a scene whose type disagrees with its content (type<->content bound)', () => {
    expect(v({ ...slideScene, type: 'quiz' })).toBe(false);
  });
});

describe('validateAction variant fields stay in lockstep with the Action schema', () => {
  // The schema is generated from the TS types, so it is the source of truth for
  // each variant's required fields and their types. These checks pin the
  // hand-written required-field map in validate.ts to it BOTH ways: it cannot
  // under-list (a schema-required field validateAction ignores), over-list (an
  // optional field validateAction wrongly demands), or mis-type a field.
  const schema = schemas.Action as {
    definitions: Record<
      string,
      {
        anyOf?: { $ref: string }[];
        properties?: Record<string, { const?: string; type?: string }>;
        required?: string[];
      }
    >;
  };
  const GOOD: Record<string, unknown> = {
    string: 's',
    number: 1,
    boolean: true,
    object: {},
    array: [],
  };
  const BAD: Record<string, unknown> = {
    string: 1,
    number: 's',
    boolean: 's',
    object: 's',
    array: {},
  };
  const paths = (doc: unknown) => {
    const r = validateAction(doc);
    return r.valid ? [] : r.errors.map((e) => e.path);
  };

  const branches = schema.definitions.Action.anyOf ?? [];
  for (const branch of branches) {
    const def = schema.definitions[branch.$ref.split('/').pop() as string];
    const type = def.properties?.type?.const;
    if (!type) continue;
    const required = (def.required ?? []).filter((f) => f !== 'id' && f !== 'type');
    const kinds = Object.fromEntries(required.map((f) => [f, def.properties?.[f]?.type]));

    it(`validateAction accepts a fully-typed ${type} (no over-listing)`, () => {
      const good = Object.fromEntries(required.map((f) => [f, GOOD[kinds[f] ?? 'string']]));
      expect(validateAction({ id: 'a', type, ...good })).toEqual({ valid: true });
    });

    it(`validateAction flags ${type}'s missing/mis-typed required fields [${required.join(', ')}]`, () => {
      for (const f of required) {
        // missing → flagged
        expect(paths({ id: 'a', type })).toContain(`/${f}`);
        // present but wrong-typed → flagged
        const st = kinds[f];
        if (typeof st === 'string' && st in BAD) {
          expect(paths({ id: 'a', type, [f]: BAD[st] })).toContain(`/${f}`);
        }
      }
    });
  }
});
