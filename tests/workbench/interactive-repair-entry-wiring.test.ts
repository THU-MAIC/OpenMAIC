import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  interactiveRepairEntry,
  mayConsumeInteractiveRepairHandoff,
} from '@/lib/workbench/interactive-repair-entry';

const stageSource = readFileSync(join(process.cwd(), 'components/stage.tsx'), 'utf8');

const base = {
  writable: true,
  generating: false,
  inWorkspacePane: false,
  playback: false,
  showingClassroom: false,
  hostedCallback: false,
  canHandoff: true,
};

describe('interactive repair entry', () => {
  it('routes writable standalone and hosted playback to the workspace', () => {
    expect(interactiveRepairEntry(base)).toBe('handoff');
    expect(interactiveRepairEntry({ ...base, inWorkspacePane: true, playback: true })).toBe(
      'handoff',
    );
    expect(stageSource).toContain('stageInteractiveRepairHandoff');
    expect(stageSource).toContain(
      'router.replace(workspaceHref({ sessionId: null, courseId: stage.id }))',
    );
  });

  it('never turns a withheld hosted edit capability into a standalone fallback', () => {
    expect(
      interactiveRepairEntry({
        ...base,
        inWorkspacePane: true,
        playback: false,
        showingClassroom: true,
        hostedCallback: false,
      }),
    ).toBeNull();
    expect(
      interactiveRepairEntry({
        ...base,
        inWorkspacePane: true,
        playback: false,
        showingClassroom: true,
        hostedCallback: true,
      }),
    ).toBe('direct');
    expect(
      interactiveRepairEntry({
        ...base,
        inWorkspacePane: true,
        playback: false,
        showingClassroom: false,
        hostedCallback: true,
      }),
    ).toBeNull();
  });

  it('does not consume pending handoffs without a writable course and ready conversation', () => {
    const ready = {
      courseId: 'course-A',
      isOwner: true,
      generating: false,
      conversationReady: true,
    };
    expect(mayConsumeInteractiveRepairHandoff(ready)).toBe(true);
    expect(mayConsumeInteractiveRepairHandoff({ ...ready, isOwner: undefined })).toBe(false);
    expect(mayConsumeInteractiveRepairHandoff({ ...ready, isOwner: false })).toBe(false);
    expect(mayConsumeInteractiveRepairHandoff({ ...ready, generating: true })).toBe(false);
    expect(mayConsumeInteractiveRepairHandoff({ ...ready, conversationReady: false })).toBe(false);
    expect(mayConsumeInteractiveRepairHandoff({ ...ready, courseId: null })).toBe(false);
  });

  it('never exposes Fix for read-only or generating courses', () => {
    for (const inWorkspacePane of [false, true]) {
      for (const playback of [false, true]) {
        const pane = {
          ...base,
          inWorkspacePane,
          playback,
          showingClassroom: true,
          hostedCallback: true,
        };
        expect(interactiveRepairEntry({ ...pane, writable: false })).toBeNull();
        expect(interactiveRepairEntry({ ...pane, generating: true })).toBeNull();
      }
    }
  });
});
