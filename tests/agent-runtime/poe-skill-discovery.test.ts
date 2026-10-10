import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listSkills } from '@/lib/server/agent-runtime/skills';
import { supportedLocales } from '@/lib/i18n/locales';
import { createWorkbenchTranslator, workbenchResourceFor } from '@/lib/i18n/workbench';
import { skillTitle } from '@/lib/workbench/agent-skills';

describe('inquiry lesson skill discovery', () => {
  it('keeps the stable invocation id and exposes the Chinese title and references', async () => {
    const skill = (await listSkills()).find((entry) => entry.id === 'predict-observe-explain');

    expect(skill).toBeDefined();
    expect(skill!.name).toBe('predict-observe-explain');
    expect(skill!.title).toBe('探究课（预测—观察—解释）');
    expect(skill!.source).toBe('builtin');

    for (const reference of ['inquiry-lesson.md', 'theory.md']) {
      expect(existsSync(join(dirname(skill!.filePath), 'references', reference))).toBe(true);
    }
  });

  it.each(supportedLocales)('has explicit workbench display copy for $code', ({ code }) => {
    const handle = 'predict-observe-explain';
    // Inspect overlay files themselves: merged resources could silently fall
    // back to English (or Simplified Chinese) when a translation is missing.
    const resource =
      code === 'en-US' || code === 'zh-CN'
        ? workbenchResourceFor(code)
        : JSON.parse(
            readFileSync(join(process.cwd(), 'lib/i18n/workbench-locales', `${code}.json`), 'utf8'),
          );
    const localized = resource.skill?.title?.[handle];

    expect(typeof localized).toBe('string');
    expect(localized.trim()).not.toBe('');
    expect(skillTitle({ name: handle, source: 'builtin' }, createWorkbenchTranslator(code))).toBe(
      localized,
    );
    if (code === 'zh-CN') expect(localized).toBe('探究课（预测—观察—解释）');
    if (code === 'en-US') expect(localized).toBe('Inquiry lesson (predict–observe–explain)');
  });
});
