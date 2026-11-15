import { expect, it } from 'vitest';
import { locateMaterialChapters } from '@/lib/server/agent-runtime/material-chapters';

it('prefers body headings near the source page over earlier TOC matches', () => {
  const text = '## A\n## Topic\n' + 'contents\n'.repeat(30) + '## A\n## Topic\nbody';
  const located = locateMaterialChapters(
    text,
    [{ title: 'A', startPage: 9, sections: [{ title: 'Topic', startPage: 10 }] }],
    10,
  );
  expect(located.map((item) => item.offset)).toEqual([
    text.lastIndexOf('A'),
    text.lastIndexOf('Topic'),
  ]);
});

it('keeps repeated sections within their own chapters, in tree order, and retains misses', () => {
  const text = '# First\n## Shared\n## Later\n## Earlier\n# Second\n## Shared\n## Only here\n';
  const found = locateMaterialChapters(
    text,
    [
      {
        title: 'First',
        startPage: 1,
        sections: [
          { title: 'Shared', startPage: 1 },
          { title: 'Absent', startPage: 1 },
          { title: 'Earlier', startPage: 1 },
          { title: 'Later', startPage: 1 },
          { title: 'Only here', startPage: 1 },
        ],
      },
      { title: 'Second', startPage: 2, sections: [{ title: 'Shared', startPage: 2 }] },
    ],
    2,
  );
  expect(found.map((item) => item.offset)).toEqual([
    text.indexOf('First'),
    text.indexOf('Shared'),
    undefined,
    text.indexOf('Earlier'),
    undefined,
    undefined,
    text.indexOf('Second'),
    text.lastIndexOf('Shared'),
  ]);
});

it('normalizes whitespace, preserves UTF-16 offsets, and does not fuzzy-match titles', () => {
  const text = '😀\n# 　Chapter　 one\n## Topic  \t name\n## Topic similar\n';
  const found = locateMaterialChapters(text, [
    {
      title: 'Chapter one',
      startPage: 1,
      sections: [
        { title: ' Topic　name ', startPage: 1 },
        { title: 'Topic simila', startPage: 1 },
      ],
    },
  ]);
  expect(found[0].offset).toBe(text.indexOf('Chapter'));
  expect(found[1].offset).toBe(text.indexOf('Topic'));
  expect(found[2].offset).toBeUndefined();
});

it('does not assign a child offset when its parent could not be located', () => {
  const found = locateMaterialChapters(
    '# Child\n# Second\n',
    [
      { title: 'Absent', startPage: 1, sections: [{ title: 'Child', startPage: 1 }] },
      { title: 'Second', startPage: 2, sections: [] },
    ],
    2,
  );
  expect(found.map((item) => item.offset)).toEqual([undefined, undefined, 10]);
});

it('does not use a repeated exercise heading or cross an unknown next chapter boundary', () => {
  const text = '# First\n## Topic\nbody\n## Topic\nexercises\n# Second\n';
  const chapters = [
    { title: 'First', startPage: 1, sections: [{ title: 'Topic', startPage: 9 }] },
    { title: 'Second', startPage: 10, sections: [] },
  ];
  expect(locateMaterialChapters(text, chapters, 10)[1].offset).toBe(text.indexOf('Topic'));
  chapters[1].title = 'Missing';
  expect(locateMaterialChapters(text, chapters, 10)[1].offset).toBeUndefined();
});
