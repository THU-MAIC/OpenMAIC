import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('learning panel workspace boundary', () => {
  it('mounts the learning bridge only outside hosted Workspace classrooms', () => {
    const source = readFileSync(resolve(process.cwd(), 'components/stage.tsx'), 'utf8');
    expect(source).toContain('{!hosted && stage?.id ? (');
    expect(source).toContain('<LearningTaskBridge');
  });
});
