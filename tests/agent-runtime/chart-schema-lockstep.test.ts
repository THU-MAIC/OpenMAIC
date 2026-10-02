import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import {
  SlideElementInputSchema,
  validateElementInput,
} from '@/lib/server/agent-runtime/course-edit/element-schema';

type Schema = {
  $ref?: string;
  type?: string;
  const?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  anyOf?: Schema[];
  items?: Schema;
  additionalProperties?: boolean | Schema;
  patternProperties?: Record<string, Schema>;
  definitions?: Record<string, Schema>;
};
it('keeps chart fields and optionality in lockstep with the actual DSL source', () => {
  const generated = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import {generateSchema} from './packages/@openmaic/dsl/scripts/gen-schema.mjs'; console.log(JSON.stringify(generateSchema('Stage')));",
      ],
      { encoding: 'utf8' },
    ),
  ) as Schema;
  const defs = generated.definitions!;
  const resolve = (s: Schema): Schema =>
    s.$ref ? defs[decodeURIComponent(s.$ref.split('/').at(-1)!)] : s;
  const actual = (SlideElementInputSchema as Schema).anyOf!.find(
    (s) => s.properties?.type.const === 'chart',
  )!;
  const expected = defs.PPTChartElement;
  expect(Object.keys(actual.properties!).sort()).toEqual(
    Object.keys(expected.properties!)
      .filter((k) => k !== 'id')
      .sort(),
  );
  expect([...(actual.required ?? [])].sort()).toEqual(
    (expected.required ?? []).filter((k) => k !== 'id').sort(),
  );
  const compare = (a: Schema, b: Schema) => {
    b = resolve(b);
    expect(Object.keys(a.properties ?? {}).sort()).toEqual(Object.keys(b.properties ?? {}).sort());
    expect([...(a.required ?? [])].sort()).toEqual([...(b.required ?? [])].sort());
    for (const key of Object.keys(b.properties ?? {}))
      compare(a.properties![key], b.properties![key]);
    if (b.items) compare(a.items!, b.items);
    if (b.anyOf) {
      expect(a.anyOf).toHaveLength(b.anyOf.length);
      b.anyOf.forEach((v, i) => compare(a.anyOf![i], v));
    }
    if (typeof b.additionalProperties === 'object')
      compare(
        Object.values(a.patternProperties ?? {})[0] ?? (a.additionalProperties as Schema),
        b.additionalProperties,
      );
  };
  for (const key of ['options', 'importedStyle'])
    compare(actual.properties![key], expected.properties![key]);
  expect(
    validateElementInput({
      type: 'chart',
      left: 0,
      top: 0,
      width: 400,
      height: 200,
      rotate: 0,
      chartType: 'bar',
      themeColors: ['#000'],
      data: { labels: ['A'], legends: ['B'], series: [[1]] },
    }),
  ).toEqual([]);
}, 20000);
