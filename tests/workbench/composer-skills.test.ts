/**
 * The composer's `/`, as text.
 *
 * Loading a skill was briefly a staging store with a chip, a dedupe rule and a
 * ceiling of three. All of it modelled something that is only ever text: the
 * `/handle` is read by the MODEL (skills are listed in the system prompt and
 * opened with pi's native `read`), and no parser anywhere in the repo looks at
 * it. So the menu is a completion — what these functions do — and the count is
 * whatever the user cares to type.
 */
import { describe, expect, it } from 'vitest';

import {
  deleteSkillHandleBefore,
  insertSkillHandle,
  segmentSkillHandles,
  slashQuery,
} from '@/lib/workbench/composer-skills';

describe('when the caret is in a slash query', () => {
  /** The caret where typing leaves it: at the end of what was just typed. */
  const atEnd = (draft: string) => slashQuery(draft, draft.length);

  it('is one, while the token being typed starts with a slash', () => {
    expect(atEnd('/')).toBe('');
    expect(atEnd('/stage')).toBe('stage');
  });

  it('is not one once the caret has moved on to real text', () => {
    expect(atEnd('/stage design')).toBeNull();
    expect(atEnd('/stage\n')).toBeNull();
    expect(atEnd('写一节课')).toBeNull();
  });

  it('is not one when the token is a path rather than a handle', () => {
    expect(atEnd('/a/b')).toBeNull();
  });

  /**
   * THE BUG. The old rule asked the WHOLE DRAFT two questions — does it start with
   * `/`, and does it contain whitespace — so one handle already in the box made
   * every later `/` inert: `write /stage` opened nothing, and neither did a second
   * handle after the first.
   */
  it('follows the caret, so a second handle triggers like the first', () => {
    expect(atEnd('写 /stage')).toBe('stage');
    expect(atEnd('/my-interactive-course-qc /')).toBe('');
    expect(atEnd('/my-interactive-course-qc /sli')).toBe('sli');
  });

  it('reads the token the caret is in, not the first or the last one', () => {
    const draft = '/one /two';
    expect(slashQuery(draft, 4)).toBe('one');
    expect(slashQuery(draft, 9)).toBe('two');
    // Mid-sentence, with prose on both sides.
    const prose = '先写大纲 /sli 然后配图';
    expect(slashQuery(prose, 9)).toBe('sli');
    expect(slashQuery(prose, prose.length)).toBeNull();
  });

  it('treats a caret at the token’s start as inside it, and clamps out-of-range', () => {
    expect(slashQuery('/stage', 0)).toBe('stage');
    expect(slashQuery('/stage', 999)).toBe('stage');
    expect(slashQuery('/stage', -1)).toBe('stage');
  });

  it('has nothing to offer from a caret sitting on whitespace', () => {
    expect(slashQuery('/stage  ', 7)).toBeNull();
  });
});

describe('writing a handle into the draft', () => {
  /** The `/` menu's own case: the caret is at the end of the query it filtered. */
  const atEnd = (draft: string, name: string) => insertSkillHandle(draft, name, draft.length);

  it('replaces the half-typed query it was picked from', () => {
    // Otherwise the half-typed query would stay in the sentence in front of the real handle.
    expect(atEnd('/课', 'stage-design')).toEqual({
      draft: '/stage-design ',
      caret: '/stage-design '.length,
    });
    expect(atEnd('/', 'stage-design').draft).toBe('/stage-design ');
  });

  it('leaves the caret after the trailing space, ready for the next word', () => {
    const { draft, caret } = atEnd('', 'k12');
    expect(draft).toBe('/k12 ');
    expect(caret).toBe(draft.length);
    // The space is what stops the next keystroke from extending the handle into
    // a name that resolves to nothing.
    expect(draft.endsWith(' ')).toBe(true);
  });

  it('joins a message that is already written (the `+` menu)', () => {
    expect(atEnd('帮我做一节课', 'k12').draft).toBe('帮我做一节课 /k12 ');
  });

  it('does not double the separator when the draft already ends in space', () => {
    expect(atEnd('帮我做一节课 ', 'k12').draft).toBe('帮我做一节课 /k12 ');
    expect(atEnd('第一行\n', 'k12').draft).toBe('第一行\n/k12 ');
  });

  it('has no ceiling — a second handle is just more text', () => {
    const first = atEnd('/stage', 'stage-design');
    const second = atEnd(first.draft, 'k12');
    const third = atEnd(second.draft, 'slide-craft');
    const fourth = atEnd(third.draft, 'deep-research');
    expect(fourth.draft).toBe('/stage-design /k12 /slide-craft /deep-research ');
    expect(fourth.caret).toBe(fourth.draft.length);
  });

  /**
   * The insertion lands where the caret is, because that is where the query the
   * user was typing lives. Appending to the end of the draft — which is what it
   * used to do for anything that was not a lone leading query — put the handle
   * somewhere the user was not looking the moment they had written a sentence.
   */
  it('replaces the query the caret is in, mid-sentence', () => {
    const draft = '先写大纲 /sli 然后配图';
    expect(insertSkillHandle(draft, 'slide-craft', 9)).toEqual({
      draft: '先写大纲 /slide-craft 然后配图',
      caret: '先写大纲 /slide-craft'.length,
    });
  });

  it('does not double a space that is already there, on either side', () => {
    const draft = '先写大纲 / 然后配图';
    const { draft: next } = insertSkillHandle(draft, 'k12', 6);
    expect(next).toBe('先写大纲 /k12 然后配图');
    expect(next).not.toContain('  ');
  });

  it('adds the separator it needs when the caret is up against prose', () => {
    // `+` menu with the caret at the end of a word: the handle goes after that
    // word rather than sawing it in half, with one space on each side.
    const { draft, caret } = insertSkillHandle('写大纲然后配图', 'k12', 3);
    expect(draft).toBe('写大纲然后配图 /k12 ');
    expect(caret).toBe(draft.length);
  });
});

/**
 * Deleting a handle as one thing.
 *
 * `/k12-core-literacy-planning` is one object to the reader and one to the model,
 * so character-by-character deletion leaves `/k12-core-literacy-plannin` — a
 * handle that resolves to nothing. One Backspace at its end takes all of it.
 */
describe('deleting a handle', () => {
  it('takes the handle and the space the insertion added', () => {
    const draft = '/k12 ';
    expect(deleteSkillHandleBefore(draft, draft.length)).toEqual({ draft: '', caret: 0 });
  });

  it('takes it from the end of a sentence, leaving the sentence', () => {
    const draft = '写一节课 /k12 ';
    expect(deleteSkillHandleBefore(draft, draft.length)).toEqual({
      draft: '写一节课 ',
      caret: '写一节课 '.length,
    });
  });

  it('takes only the one the caret is on', () => {
    const draft = '/stage-design /k12 ';
    const after = deleteSkillHandleBefore(draft, draft.length);
    expect(after?.draft).toBe('/stage-design ');
    // …and again for the next one.
    expect(deleteSkillHandleBefore(after!.draft, after!.draft.length)?.draft).toBe('');
  });

  it('keeps what follows the caret', () => {
    const draft = '/k12 写一节课';
    expect(deleteSkillHandleBefore(draft, '/k12 '.length)).toEqual({
      draft: '写一节课',
      caret: 0,
    });
  });

  it('does nothing anywhere else, leaving the browser its own behaviour', () => {
    // Mid-handle: ordinary editing.
    expect(deleteSkillHandleBefore('/k12-core ', '/k12-c'.length)).toBeNull();
    // Prose.
    expect(deleteSkillHandleBefore('写一节课', 4)).toBeNull();
    // A handle that is part of a word, not a token.
    expect(deleteSkillHandleBefore('a/k12', 5)).toBeNull();
    // Start of the draft.
    expect(deleteSkillHandleBefore('/k12 ', 0)).toBeNull();
    // Past the end.
    expect(deleteSkillHandleBefore('/k12', 99)).toBeNull();
  });

  it('is the exact inverse of inserting one', () => {
    const inserted = insertSkillHandle('写一节课', 'k12', '写一节课'.length);
    const deleted = deleteSkillHandleBefore(inserted.draft, inserted.caret);
    // The separator the insertion added stays, as the user's own text did.
    expect(deleted?.draft).toBe('写一节课 ');
  });
});

/**
 * Where the inline pill gets drawn.
 *
 * The mirror layer (`components/workbench/composer-input`) paints a ground behind
 * the runs this returns. Two properties matter more than any single case: the
 * segments must reassemble into the draft byte for byte (the pill is decoration,
 * never a rewrite), and only INSTALLED names may become one — a pill behind
 * `/whatever` would promise the agent had a skill it does not have.
 */
describe('finding the handles to draw as pills', () => {
  const INSTALLED = ['stage-design', 'k12', '课堂设计'];
  const segment = (text: string) => segmentSkillHandles(text, INSTALLED);
  /** What the mirror actually lays out, so a lost character shows up as a diff. */
  const rejoin = (text: string) =>
    segment(text)
      .map((part) => part.text)
      .join('');
  const pills = (text: string) =>
    segment(text)
      .filter((part) => part.skill)
      .map((part) => part.text);

  it('marks an installed handle, and nothing else on the line', () => {
    expect(segment('/k12 写一节课')).toEqual([
      { text: '/k12', skill: true },
      { text: ' 写一节课', skill: false },
    ]);
  });

  it('leaves a handle that names no installed skill as plain text', () => {
    expect(pills('/whatever 写一节课')).toEqual([]);
    // A prefix of a real name is not that name.
    expect(pills('/stage-desig')).toEqual([]);
    expect(pills('/stage-designer')).toEqual([]);
  });

  it('marks every handle in the draft — there is no ceiling here either', () => {
    expect(pills('/stage-design /k12 写一节课 /课堂设计')).toEqual([
      '/stage-design',
      '/k12',
      '/课堂设计',
    ]);
  });

  it('needs a whole token: not mid-word, not inside a path, not with punctuation', () => {
    expect(pills('a/k12')).toEqual([]);
    expect(pills('/k12/extra')).toEqual([]);
    // The comma is part of the token, and the agent would not resolve it either.
    expect(pills('/k12, 然后呢')).toEqual([]);
    // Line breaks bound a token exactly as spaces do.
    expect(pills('第一行\n/k12\n第三行')).toEqual(['/k12']);
  });

  it('reproduces the draft exactly, whatever it contains', () => {
    for (const draft of [
      '/k12 写一节课',
      '  /k12  两个空格  ',
      '/stage-design\n\n/k12 ',
      'a/k12 /whatever /课堂设计',
      '写一节课',
      '/k12',
    ]) {
      expect(rejoin(draft)).toBe(draft);
    }
  });

  it('draws nothing when there is nothing, or when the registry is empty', () => {
    expect(segmentSkillHandles('', INSTALLED)).toEqual([]);
    // A registry that has not loaded yet must not guess: plain text until it has.
    expect(segmentSkillHandles('/k12 写一节课', [])).toEqual([
      { text: '/k12 写一节课', skill: false },
    ]);
  });

  it('marks what the `/` menu just inserted', () => {
    const inserted = insertSkillHandle('写一节课', 'k12', '写一节课'.length);
    expect(pills(inserted.draft)).toEqual(['/k12']);
  });
});
