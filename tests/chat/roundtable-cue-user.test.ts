import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { isResumeLessonOption, Roundtable } from '@/components/roundtable';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('Roundtable cue-user card', () => {
  it('shows the learner-facing prompt and structured quick replies', () => {
    const html = renderToStaticMarkup(
      createElement(Roundtable, {
        isCueUser: true,
        cueUserPrompt: 'Which path should we explore next?',
        cueUserOptions: ['Show an example', 'Let me practice'],
        onMessageSend: vi.fn(),
        onResumeLesson: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="cue-user-card"');
    expect(html).toContain('data-testid="cue-user-floating-panel"');
    expect(html).toContain('data-testid="cue-user-resume-lesson"');
    expect(html).toContain('roundtable.yourTurn');
    expect(html).toContain('roundtable.textInput');
    expect(html).toContain('roundtable.voiceInput');
    expect(html).toContain('roundtable.resumeLesson');
    expect(html).toContain('Which path should we explore next?');
    expect(html).toContain('Show an example');
    expect(html).toContain('Let me practice');
  });

  it('recognizes resume-lesson replies so they can bypass another LLM round', () => {
    expect(isResumeLessonOption('继续课程')).toBe(true);
    expect(isResumeLessonOption('不用，继续课程')).toBe(true);
    expect(isResumeLessonOption('回到课堂')).toBe(true);
    expect(isResumeLessonOption('Continue the lesson')).toBe(true);
    expect(isResumeLessonOption('继续讲讲装饰器')).toBe(false);
  });
});
