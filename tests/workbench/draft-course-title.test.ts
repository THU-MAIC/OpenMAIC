import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  draftCourseTitle,
  type SeedCourseAsk,
  seedIsTitleOnlyChange,
} from '@/lib/workbench/draft-course-title';

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

  describe('a title-only rewrite leaves focus where it is', () => {
    const first: SeedCourseAsk = { stageId: 'c1', title: 'Untitled', ownerId: 'draft-1', ask: 0 };

    it('is title-only when just the title changed for the same ask', () => {
      expect(seedIsTitleOnlyChange(first, { ...first, title: 'Shared course' })).toBe(true);
    });

    it('is a fresh ask on the first seed, another course, another composer, or a new ask', () => {
      expect(seedIsTitleOnlyChange(null, first)).toBe(false);
      expect(seedIsTitleOnlyChange(first, { ...first, stageId: 'c2', title: 'Other' })).toBe(false);
      expect(seedIsTitleOnlyChange(first, { ...first, ownerId: 'draft-2', title: 'X' })).toBe(
        false,
      );
      expect(seedIsTitleOnlyChange(first, { ...first, ask: 1, title: 'X' })).toBe(false);
      expect(seedIsTitleOnlyChange(first, { ...first })).toBe(false);
    });

    it('is how the composer decides whether the rewrite takes focus', () => {
      const chat = readFileSync(
        join(process.cwd(), 'components/workbench/WorkbenchChat.tsx'),
        'utf8',
      );
      const effect = chat.slice(
        chat.indexOf('const seededAsk = useRef'),
        chat.indexOf('const refreshedCreateCalls'),
      );
      expect(effect).toContain('const titleOnly = seedIsTitleOnlyChange(seededAsk.current, ask);');
      expect(effect).toContain('if (!titleOnly || composerFocused) pendingCaret.current');
      // The focus call comes only after the title-only early return.
      const early = effect.indexOf('if (titleOnly) return;');
      const focus = effect.indexOf('return focusComposerWhenShown(');
      expect(early).toBeGreaterThan(-1);
      expect(focus).toBeGreaterThan(early);
    });
  });
});
