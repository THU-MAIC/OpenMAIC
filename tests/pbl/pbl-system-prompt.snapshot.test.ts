import { describe, test, expect } from 'vitest';
import { buildPBLSystemPrompt } from '@/lib/pbl/pbl-system-prompt';

describe('buildPBLSystemPrompt — baseline snapshot', () => {
  test('default config', () => {
    const out = buildPBLSystemPrompt({
      projectTopic: 'Smart Garden',
      projectDescription: 'Build an IoT garden monitoring system',
      targetSkills: ['IoT', 'Python', 'Data viz'],
      issueCount: 4,
      languageDirective: '中文 (zh-CN)',
    });
    expect(out).toMatchSnapshot();
  });
});
