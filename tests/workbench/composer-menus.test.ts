/**
 * One popover at a time in the composer.
 *
 * The `/` skill menu and the `@` course menu share one box and one set of keys,
 * and they used to be two derivations sitting next to each other. They drifted in
 * the way that pair always does: while a `/` query was live the course menu was
 * HIDDEN rather than closed, so the button's request survived — and the moment the
 * query ended, which is exactly what picking a skill does (the inserted handle
 * carries a trailing space), the course list appeared on its own over a composer
 * the user had just finished with.
 *
 * Both triggers now read the token AROUND THE CARET, so every case here states one
 * — `menuOf` puts it at the end of the draft, which is where typing leaves it, and
 * the caret-specific cases at the bottom put it somewhere else on purpose.
 */
import { describe, expect, it } from 'vitest';

import { resolveComposerMenu } from '@/lib/workbench/composer-menus';

type MenuInput = Parameters<typeof resolveComposerMenu>[0];

/** The rule, with the caret at the end of the draft unless a case overrides it. */
const menuOf = (draft: string, extra: Partial<Omit<MenuInput, 'draft'>> = {}) =>
  resolveComposerMenu({ draft, caret: draft.length, ...extra });

describe('which menu is open', () => {
  it('is the skill menu while a `/` query is being typed', () => {
    const state = menuOf('/stage');
    expect(state.menu).toBe('skill');
    expect(state.slash).toBe('stage');
    expect(state.mention).toBeNull();
  });

  it('is the course menu on an `@` token', () => {
    const state = menuOf('改一下 @光');
    expect(state.menu).toBe('course');
    expect(state.mention).toMatchObject({ query: '光' });
  });

  it('is the course menu when the button asked for it', () => {
    expect(menuOf('', { courseMenuRequested: true }).menu).toBe('course');
    expect(menuOf('写一节课', { courseMenuRequested: true }).menu).toBe('course');
  });

  it('is nothing at all on ordinary text', () => {
    expect(menuOf('写一节课').menu).toBeNull();
  });

  it('never shows both — a live `/` query wins the slot', () => {
    // Even with the button's request outstanding.
    const state = menuOf('/stage', { courseMenuRequested: true });
    expect(state.menu).toBe('skill');
    expect(state.mention).toBeNull();
  });
});

describe('what a dismissal covers', () => {
  it('holds for exactly the draft it was dismissed on', () => {
    expect(menuOf('@光', { mentionDismissedOn: '@光' }).menu).toBeNull();
    // One more keystroke and it is a different question again.
    expect(menuOf('@光的', { mentionDismissedOn: '@光' }).menu).toBe('course');
  });

  it('is per menu', () => {
    expect(menuOf('/stage', { slashDismissedOn: '/stage' }).menu).toBeNull();
    expect(menuOf('/stage', { mentionDismissedOn: '/stage' }).menu).toBe('skill');
  });

  it('is not undone by moving the caret inside the same text', () => {
    // Escape means "not for this text". A dismissal keyed on the draft AND the
    // caret would reopen on every arrow key, which is worse than useless: the menu
    // owns Enter while it is up.
    const draft = '@光 @影';
    expect(menuOf(draft, { mentionDismissedOn: draft, caret: 2 }).menu).toBeNull();
    expect(menuOf(draft, { mentionDismissedOn: draft, caret: draft.length }).menu).toBeNull();
  });
});

describe('after inserting a skill, nothing is open', () => {
  /**
   * The reported bug, as a state: the user pressed `@` (so the course menu was
   * requested), typed `/k12`, and picked. The composer then holds
   * `/k12-core-literacy-planning ` and BOTH dismissals are recorded against it.
   */
  const inserted = '/k12-core-literacy-planning ';

  it('closes the skill menu it was picked from', () => {
    // The trailing space ends the query on its own; the dismissal is belt and
    // braces for a handle typed by hand.
    expect(menuOf(inserted, { slashDismissedOn: inserted }).menu).toBeNull();
  });

  it('does not let the `@` request resurface', () => {
    expect(
      menuOf(inserted, {
        slashDismissedOn: inserted,
        mentionDismissedOn: inserted,
        // The composer clears this too; even if it did not, the dismissal holds.
        courseMenuRequested: true,
      }).menu,
    ).toBeNull();
  });

  it('leaves the next `@` working', () => {
    expect(menuOf(`${inserted}@光`, { mentionDismissedOn: inserted }).menu).toBe('course');
  });

  /**
   * THE BUG THIS CARET WORK FIXES. With a handle already in the box, the draft
   * contains a space — and the old rule tested the whole draft for one, so a second
   * `/` opened nothing at all, ever. Both triggers now read the token at the caret.
   */
  it('leaves the next `/` working, which is what the draft-wide test broke', () => {
    const draft = `${inserted}/`;
    const state = menuOf(draft, { slashDismissedOn: inserted });
    expect(state.menu).toBe('skill');
    expect(state.slash).toBe('');
  });

  it('and the one after that, typed out', () => {
    expect(menuOf('/my-interactive-course-qc /sli').slash).toBe('sli');
  });
});

describe('after picking a course, nothing is open', () => {
  it('does not pop the skill menu open on what the splice left behind', () => {
    // `/stage-design @course` → pick → `/stage-design`, which is a live query.
    const left = '/stage-design';
    expect(menuOf(left, { slashDismissedOn: left }).menu).toBeNull();
  });
});

describe('a surface with no courses to offer', () => {
  it('has no course menu at all, however it is asked', () => {
    expect(menuOf('@光', { courseMenuAvailable: false }).menu).toBeNull();
    expect(menuOf('', { courseMenuRequested: true, courseMenuAvailable: false }).menu).toBeNull();
    // The skill half is unaffected.
    expect(menuOf('/stage', { courseMenuAvailable: false }).menu).toBe('skill');
  });
});

describe('a dismissal binds however the menu was opened', () => {
  it('covers the button’s request, not only the token', () => {
    // The rule alone has to hold this: needing the component to ALSO clear its
    // request flag on every dismissal path is the arrangement that let the course
    // list reappear after a skill was inserted.
    expect(
      menuOf('写一节课', { mentionDismissedOn: '写一节课', courseMenuRequested: true }).menu,
    ).toBeNull();
    // …and one keystroke later the request is live again.
    expect(
      menuOf('写一节课。', { mentionDismissedOn: '写一节课', courseMenuRequested: true }).menu,
    ).toBe('course');
  });
});

describe('the caret decides, not the draft', () => {
  it('opens the skill menu on a token in the MIDDLE of a sentence', () => {
    const draft = '先写大纲 /sli 然后配图';
    // Caret just after `/sli`.
    expect(menuOf(draft, { caret: 9 }).slash).toBe('sli');
    // Caret parked in the prose after it: nothing is being typed.
    expect(menuOf(draft, { caret: draft.length }).menu).toBeNull();
  });

  it('opens the course menu on a mention in the middle of a sentence', () => {
    const draft = '把 @光 的第三页改一下';
    const state = menuOf(draft, { caret: 4 });
    expect(state.menu).toBe('course');
    expect(state.mention).toMatchObject({ query: '光', start: 2, end: 4 });
  });

  it('reads the token the caret is in, not the last one in the draft', () => {
    const draft = '/one /two';
    expect(menuOf(draft, { caret: 4 }).slash).toBe('one');
    expect(menuOf(draft, { caret: 9 }).slash).toBe('two');
  });
});
