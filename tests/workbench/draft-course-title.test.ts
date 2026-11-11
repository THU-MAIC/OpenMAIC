import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { draftCourseTitle } from '@/lib/workbench/draft-course-title';

describe('the empty conversation names its course', () => {
  it('by the rail list for an own course', () => {
    expect(draftCourseTitle({ listedName: 'Mine', loadedName: 'Doc', fallback: 'Untitled' })).toBe(
      'Mine',
    );
  });

  it('by the loaded document for a course not in the list', () => {
    expect(
      draftCourseTitle({
        listedName: undefined,
        loadedName: 'Shared course',
        fallback: 'Untitled',
      }),
    ).toBe('Shared course');
  });

  it('as untitled only when neither knows it', () => {
    expect(draftCourseTitle({ listedName: null, loadedName: null, fallback: 'Untitled' })).toBe(
      'Untitled',
    );
  });

  it('is what the workspace shell uses for the draft composer', () => {
    const shell = readFileSync(
      join(process.cwd(), 'components/workbench/workspace/WorkspaceShell.tsx'),
      'utf8',
    );
    expect(shell).toContain('loadedName: draftLoadedName,');
    expect(shell).toContain('s.stage?.id === draftCourseId ? s.stage.name : null');
  });

  it('rewrites the seeded mention when the title arrives after the course opened', () => {
    const chat = readFileSync(
      join(process.cwd(), 'components/workbench/WorkbenchChat.tsx'),
      'utf8',
    );
    expect(chat).toContain(
      '}, [seedCourse?.stageId, seedCourse?.title, composerOwnerId, newConversation]);',
    );
  });
});
