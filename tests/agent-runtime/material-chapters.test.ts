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

it('locates a child without assigning its offset to the missing parent', () => {
  const found = locateMaterialChapters(
    '# Child\n# Second\n',
    [
      { title: 'Absent', startPage: 1, sections: [{ title: 'Child', startPage: 1 }] },
      { title: 'Second', startPage: 2, sections: [] },
    ],
    2,
  );
  expect(found.map((item) => item.offset)).toEqual([undefined, 2, 10]);
});

it('does not use a repeated exercise heading when the next chapter is missing', () => {
  const text = '# First\n## Topic\nbody\n## Topic\nexercises\n# Second\n';
  const chapters = [
    { title: 'First', startPage: 1, sections: [{ title: 'Topic', startPage: 9 }] },
    { title: 'Second', startPage: 10, sections: [] },
  ];
  expect(locateMaterialChapters(text, chapters, 10)[1].offset).toBe(text.indexOf('Topic'));
  chapters[1].title = 'Missing';
  expect(locateMaterialChapters(text, chapters, 10)[1].offset).toBe(text.indexOf('Topic'));
});

it.each([
  ['**Title**', 'Title', 2],
  ['__Title__', 'Title', 2],
  ['*Title*', 'Title', 1],
  ['_Title_', 'Title', 1],
  ['**First** and __second__', 'First and second', 2],
  ['***Title***', 'Title', 3],
  ['Units **and** Measures', 'Units and Measures', 0],
])(
  'matches paired emphasis in %s and points to the first visible character',
  (line, title, skipped) => {
    const text = `😀\n## ${line}\n`;
    const found = locateMaterialChapters(text, [{ title, startPage: 1, sections: [] }]);
    expect(found[0].offset).toBe('😀\n## '.length + skipped);
  },
);

it.each([
  ['a*b*c', 'abc'],
  ['x_y_z', 'xyz'],
  ['x__y__z', 'xyz'],
  ['$a*b+c*d$', '$ab+cd$'],
  ['**Unpaired', 'Unpaired'],
  ['Title*', 'Title'],
  ['* Title *', 'Title'],
])('does not strip mathematical, identifier or unmatched markers in %s', (line, changed) => {
  const text = `# ${line}`;
  expect(
    locateMaterialChapters(text, [{ title: changed, startPage: 1, sections: [] }])[0].offset,
  ).toBeUndefined();
  expect(
    locateMaterialChapters(text, [{ title: line, startPage: 1, sections: [] }])[0].offset,
  ).toBe(2);
});

it.each(['## **First**', '__First__'])(
  'joins two adjacent nonempty lines starting with %s',
  (first) => {
    const text = `${first}\n  \n**Second**\n`;
    const found = locateMaterialChapters(text, [
      { title: 'First Second', startPage: 1, sections: [] },
    ]);
    expect(found[0].offset).toBe(text.indexOf('First'));
  },
);

it('does not join prose, cross intervening content, or concatenate a third line', () => {
  for (const text of [
    'First\nSecond',
    '## First\nintervening prose\nSecond',
    '## First\nSecond\nThird',
  ]) {
    const title = text.endsWith('Third') ? 'First Second Third' : 'First Second';
    expect(
      locateMaterialChapters(text, [{ title, startPage: 1, sections: [] }])[0].offset,
    ).toBeUndefined();
  }
});

it('leaves competing single- and two-line titles unlocated without page evidence', () => {
  const text = '# First\nSecond\n# First Second';
  expect(
    locateMaterialChapters(text, [{ title: 'First Second', startPage: 1, sections: [] }])[0].offset,
  ).toBeUndefined();
});

it('bounds sections of missing chapters by the nearest located entries and avoids earlier TOC matches', () => {
  const text =
    '## Shared\n## Another\n# First\n## Known\n## Shared\n## Another\n# Last\n## Outside\n';
  const found = locateMaterialChapters(
    text,
    [
      { title: 'First', startPage: 1, sections: [{ title: 'Known', startPage: 1 }] },
      {
        title: 'Missing',
        startPage: 2,
        sections: [
          { title: 'Shared', startPage: 2 },
          { title: 'Absent', startPage: 2 },
          { title: 'Another', startPage: 2 },
          { title: 'Outside', startPage: 2 },
        ],
      },
      { title: 'Also missing', startPage: 3, sections: [] },
      { title: 'Last', startPage: 4, sections: [] },
    ],
    4,
  );
  expect(found.map((item) => item.offset)).toEqual([
    text.indexOf('First'),
    text.indexOf('Known'),
    undefined,
    text.lastIndexOf('Shared'),
    undefined,
    text.lastIndexOf('Another'),
    undefined,
    undefined,
    text.indexOf('Last'),
  ]);
});

it('locates a two-line body title instead of its single-line TOC entry', () => {
  const text =
    '# Contents\n## Chapter 1 Motion\n\n' +
    'front matter\n'.repeat(100) +
    '# Chapter 1\nMotion\nBody starts here';
  expect(
    locateMaterialChapters(
      text,
      [{ title: 'Chapter 1 Motion', startPage: 90, sections: [] }],
      100,
    )[0].offset,
  ).toBe(text.lastIndexOf('Chapter 1'));
});

it('leaves repeated single-line titles unlocated when page estimates cannot distinguish them', () => {
  const text =
    '# Motion\n' + 'dense front matter\n'.repeat(40) + '# Motion\n' + 'body\n'.repeat(140);
  expect(
    locateMaterialChapters(text, [{ title: 'Motion', startPage: 26, sections: [] }], 100)[0].offset,
  ).toBeUndefined();
});
