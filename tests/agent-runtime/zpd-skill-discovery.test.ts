import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listSkills } from '@/lib/server/agent-runtime/skills';

describe('exercise lesson skill discovery', () => {
  it('keeps the stable invocation id and exposes the Chinese title and references', async () => {
    const skill = (await listSkills()).find((entry) => entry.id === 'zone-of-proximal-development');

    expect(skill).toBeDefined();
    expect(skill!.name).toBe('zone-of-proximal-development');
    expect(skill!.title).toBe('习题课（最近发展区）');
    expect(skill!.source).toBe('builtin');

    for (const reference of ['exercise-lesson.md', 'theory.md']) {
      expect(existsSync(join(dirname(skill!.filePath), 'references', reference))).toBe(true);
    }
  });
});
