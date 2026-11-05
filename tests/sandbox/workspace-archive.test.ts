import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { workspacePath } from '@/lib/server/sandbox/workspace-archive';
it.each(['../x', '/etc/passwd', 'a/../b', 'a//b', 'a/./b', '', 'a\\b', 'a\0b'])(
  'refuses unsafe workspace path %j',
  (path) => {
    expect(() => workspacePath(path)).toThrow();
  },
);
it('accepts project-relative and absolute project paths', () => {
  expect(workspacePath('src/main.py')).toBe('src/main.py');
  expect(workspacePath('/home/user/project/src/main.py')).toBe('src/main.py');
});
