import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const BOUNDARY_RULE = 'no-restricted-syntax';
const eslint = new ESLint({ cwd: process.cwd() });

async function boundaryErrors(code: string): Promise<string[]> {
  const filePath = 'lib/video-export/emit-hyperframes/probe.ts';
  if (await eslint.isPathIgnored(filePath)) return ['<path is eslint-ignored>'];
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return (result?.messages ?? [])
    .filter((message) => message.severity === 2 && message.ruleId === BOUNDARY_RULE)
    .map((message) => message.ruleId ?? 'unknown');
}

describe('Hyperframes emitter lint boundary', () => {
  it('allows only in-module relatives and the shared pure Quiz math renderer', async () => {
    const errors = await boundaryErrors(`
      import type { VideoTimeline } from '../ir';
      import { renderQuizMathText } from '../../quiz/math-text';
      import { escapeHtml } from './format';
      export type Timeline = VideoTimeline;
      export const rendered = renderQuizMathText(escapeHtml('x'));
    `);

    expect(errors).toEqual([]);
  });

  it.each([
    ['a host-app alias', "import value from '@/lib/store'; export default value;"],
    ['another app module', "import value from '../../store'; export default value;"],
    [
      'a named re-export from another app module',
      "export { default as value } from '../../store';",
    ],
    ['a star re-export from another app module', "export * from '../../store';"],
    ['React', "import React from 'react'; export default React;"],
    ['a dynamic import', "export async function load() { return import('./format'); }"],
    ['require', "const format = require('./format'); export default format;"],
  ])('rejects %s', async (_label, code) => {
    expect(await boundaryErrors(code)).toContain(BOUNDARY_RULE);
  });
});
