import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('personal history runner wiring', () => {
  const source = readFileSync(join(process.cwd(), 'lib/server/agent-runtime/runner.ts'), 'utf8');

  it('captures the session owner and keeps all four tools on the normal allowlist', () => {
    expect(source).toContain('buildPersonalHistoryTools(');
    expect(source).toContain('meta.ownerId');
    expect(source).toContain('...PERSONAL_HISTORY_TOOL_NAMES');
    expect(source).not.toContain('analyze_course_history');
  });
});
