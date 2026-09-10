import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('the workspace rail is transient browser chrome', () => {
  const shell = read('components/workbench/workspace/WorkspaceShell.tsx');
  const rail = read('components/workbench/workspace/WorkspaceRail.tsx');

  it('persists and toggles the rail independently of both content panes', () => {
    const toggle = shell.slice(
      shell.indexOf('const toggleNav'),
      shell.indexOf('const collapseChat'),
    );
    expect(toggle).toContain('setNav(');
    expect(toggle).toContain('NAV_COLLAPSED_STORAGE_KEY');
    expect(toggle).not.toContain('setChat(');
    expect(toggle).not.toContain('setClassroom(');
    expect(shell).toContain('onToggleCollapsed={collapse.toggleNav}');
  });

  it('leaves a direct expand affordance when dismissed', () => {
    const mini = rail.slice(rail.indexOf('pro-nav-rail-mini'), rail.indexOf('renderCourseRow'));
    expect(mini).toContain('testId="pro-nav-expand"');
    expect(mini).toContain('onClick={onToggleCollapsed}');
    expect(mini).toContain('aria-expanded={false}');
  });

  it('keeps conversations and courses as separate destinations', () => {
    expect(rail).toContain("id: 'sessions'");
    expect(rail).toContain("id: 'courses'");
    expect(rail).not.toMatch(/course.*sessionId|session.*courseId/);
  });
});
