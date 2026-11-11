import { describe, expect, it } from 'vitest';

import { firstInteractiveCover } from '@/lib/utils/course-cover';

/** A scene record reduced to the fields the cover selection reads. */
function scene(overrides: {
  type?: string;
  title?: string | null;
  widgetType?: string | null;
}): object {
  return {
    title: overrides.title ?? null,
    content:
      overrides.type === undefined
        ? null
        : {
            type: overrides.type,
            ...(overrides.widgetType ? { widgetType: overrides.widgetType } : {}),
          },
  };
}

describe('firstInteractiveCover', () => {
  it('picks the first interactive scene, skipping slides and quizzes before it', () => {
    const cover = firstInteractiveCover([
      scene({ type: 'slide', title: 'Introduction' }),
      scene({ type: 'quiz', title: 'Warm-up' }),
      scene({ type: 'interactive', title: 'Orbit simulator', widgetType: 'simulation' }),
      scene({ type: 'interactive', title: 'A later page', widgetType: 'game' }),
    ]);
    expect(cover).toEqual({ title: 'Orbit simulator', widgetType: 'simulation' });
  });

  it('trims the title and keeps an empty one', () => {
    expect(
      firstInteractiveCover([scene({ type: 'interactive', title: '  Phase changes  ' })]),
    ).toEqual({ title: 'Phase changes', widgetType: null });
    expect(firstInteractiveCover([scene({ type: 'interactive', title: null })])).toEqual({
      title: '',
      widgetType: null,
    });
  });

  it('is null when no scene is interactive', () => {
    expect(
      firstInteractiveCover([
        scene({ type: 'slide', title: 'Only slides' }),
        scene({ type: 'quiz' }),
        { title: 'A scene without content' },
      ]),
    ).toBeNull();
  });
});
