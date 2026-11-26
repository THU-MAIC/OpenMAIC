import { expect, it } from 'vitest';
import { deduplicateHandoffs, type LearningConversationEntry } from '@/lib/pbl/v3/conversation';
import {
  boardAt,
  boardWrites,
  narrationSegments,
  narrationSteps,
  pointerAt,
  recoveredReviewSpeech,
  spokenText,
  toldConversation,
  unspokenReceipt,
} from '@/lib/pbl/v3/narration';

type Part = LearningConversationEntry['parts'][number];
const text = (id: string, value: string, extra: object = {}) =>
  ({ kind: 'text', id, text: value, ...extra }) as Part;
const board = (id: string, ids: string[]) =>
  ({
    kind: 'tool',
    id,
    action: 'board',
    name: 'wb_draw_text',
    status: 'succeeded',
    display: { op: 'text', label: '', seq: 1, ids },
  }) as Part;
const point = (id: string, target: object = { path: 'a.ts', line: 3, pointer: 'laser' }) =>
  ({
    kind: 'tool',
    id,
    action: 'board',
    name: 'point_at_code',
    status: 'succeeded',
    display: {
      op: 'point',
      label: '',
      seq: null,
      target,
    },
  }) as Part;
const read = (id: string) =>
  ({ kind: 'tool', id, action: 'read', name: 'read_file', status: 'succeeded' }) as Part;

const entry = (parts: Part[]): LearningConversationEntry => ({
  id: 'r',
  speaker: 'mentor',
  status: 'succeeded',
  inputId: 1,
  parts,
});

it('tells a reply as the conversation stream lists it', () => {
  const steps = narrationSteps(
    entry([
      text('a', 'Start with the overview.'),
      read('b'),
      board('c', ['title']),
      board('d', ['table']),
      text('e', 'Compare the **two paths** in the [file](#pbl-file=a.ts).'),
      point('f'),
      text('g', 'Look at this line.'),
      board('h', ['note']),
      text('q', 'Which step would you try first?', { canonical: true }),
    ]),
  );
  expect(steps.map((step) => step.kind)).toEqual([
    'say',
    'tool',
    'board',
    'board',
    'say',
    'point',
    'say',
    'board',
    'say',
  ]);
  expect(steps[4]).toMatchObject({ text: 'Compare the two paths in the file.' });
  // Parts locate each step in the current transcript; their IDs follow it across snapshots.
  expect(steps.map((step) => step.part)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  // The pointer is held through the sentence after it and leaves when the board is written.
  expect(pointerAt(steps, 4)).toBeUndefined();
  expect(pointerAt(steps, 6)).toMatchObject({ id: 'f' });
  expect(pointerAt(steps, 7)).toBeUndefined();
});

it('keeps a displaced live draft visible and reveals the retry only when its turn comes', () => {
  const source = {
    ...entry([text('receipt', 'Only the formal answer remains.')]),
    id: 'pbl-role-a:1',
    inputId: 6,
  };
  const retry = { ...source, id: 'pbl-role-a:2' };
  const another = { ...source, id: 'pbl-role-b:1' };
  const conversation = [source, retry, another];
  const [heard, held, differentSession] = toldConversation(conversation, {
    id: source.id,
    part: -1,
    said: 1,
    displaced: 'Still speaking.',
  });
  expect(heard.parts).toMatchObject([{ kind: 'text', text: 'Still speaking.' }]);
  expect(held.parts).toEqual([]);
  expect(differentSession).toBe(another);
  expect(toldConversation(conversation, null)).toBe(conversation);
});

it('shows the conversation only as far as it has been told', () => {
  const thinking = { kind: 'thinking', id: 't', text: '…' } as Part;
  const reply = entry([
    thinking,
    text('a', 'Read **both**.'),
    board('c', ['title']),
    text('e', 'The table compares two paths.'),
  ]);
  const earlier = { ...entry([text('x', 'Earlier reply.')]), id: 'earlier' };
  const conversation = [earlier, reply];
  // Nothing is being told: the conversation is as the stream has it.
  expect(toldConversation(conversation, null)).toBe(conversation);
  // Half way through the first piece of text: nothing after the playhead is there yet, and
  // the text keeps its own marks rather than the plain words that are read out.
  const [before, half] = toldConversation(conversation, { id: 'r', part: 1, said: 0.5 });
  expect(before).toBe(earlier);
  expect(half.parts.map((part) => part.id)).toEqual(['t', 'a']);
  expect(half.parts[1]).toMatchObject({
    text: 'Read **both**.'.slice(0, 7),
    streaming: true,
  });
  // On a tool call: everything up to it, the text before it whole.
  const [, onBoard] = toldConversation(conversation, { id: 'r', part: 2, said: 0 });
  expect(onBoard.parts.map((part) => part.id)).toEqual(['t', 'a', 'c']);
  expect(onBoard.parts[1]).toBe(reply.parts[1]);
  // Before anything has been told the reply is there with nothing said.
  const [, unsaid] = toldConversation(conversation, { id: 'r', part: -1, said: 0 });
  expect(unsaid.parts).toEqual([]);
});

it('keeps what the role said between board calls beside the recorded closing', () => {
  const [kept] = deduplicateHandoffs([
    entry([
      text('a', 'Start with the overview.', { messageId: 1 }),
      board('c', ['title']),
      text('e', 'The table compares two paths.', { messageId: 2 }),
      text('question-1', 'Which step would you try first?', { canonical: true }),
    ]),
  ]);
  expect(kept.parts.filter((part) => part.kind === 'text').map((part) => part.id)).toEqual([
    'a',
    'e',
    'question-1',
  ]);
  // The spoken introduction stays before the board action; only the new question follows it.
  const [echoed] = deduplicateHandoffs([
    entry([
      text('a', 'Start with the overview.', { messageId: 1 }),
      board('c', ['title']),
      text('question-1', 'Start with the overview.\n\nWhich step would you try first?', {
        canonical: true,
      }),
    ]),
  ]);
  expect(
    narrationSteps(echoed).map((step) => (step.kind === 'say' ? step.text : step.kind)),
  ).toEqual(['Start with the overview.', 'board', 'Which step would you try first?']);
});

it('maps a reply onto bubbles: each piece of text with the tool calls that follow it', () => {
  const steps = narrationSteps(
    entry([
      read('r'),
      text('a', 'Start with the overview.'),
      board('c', ['title']),
      board('d', ['table']),
      text('e', 'The table compares two paths.'),
      point('f'),
      text('q', 'Which step would you try first?', { canonical: true }),
    ]),
  );
  const segments = narrationSegments(steps);
  // Tool calls made before any text open the reply as a segment with nothing said yet.
  expect(
    segments.map((segment) => [segment.say?.id, segment.tools.map((tool) => tool.id)]),
  ).toEqual([
    [undefined, ['r']],
    ['a', ['c', 'd']],
    ['e', ['f']],
    ['q', []],
  ]);
  expect(segments.map((segment) => [segment.from, segment.to])).toEqual([
    [0, 0],
    [1, 3],
    [4, 5],
    [6, 6],
  ]);
  // Whiteboard changes are written one at a time, in the order they were made.
  expect(boardWrites(steps)).toEqual([
    { index: 2, ids: ['title'], clear: false },
    { index: 3, ids: ['table'], clear: false },
  ]);
});

const firstPoint = point('first', { path: 'a.ts', line: 2, end: 4, pointer: 'spotlight' });
const secondPoint = point('next', { path: 'b.ts', line: 7, end: 9, pointer: 'spotlight' });
const firstLink = '[setup](#pbl-file=a.ts&line=2&end=4)';
const secondLink = '[work](#pbl-file=b.ts&line=7&end=9)';
const close = {
  kind: 'tool',
  id: 'close',
  name: 'wb_close',
  action: 'board',
  status: 'succeeded',
  display: { op: 'close', label: '', seq: null },
} as const;

it('voices each passage with its own previously issued cue, retaining the original transcript', () => {
  const words = `Inspect ${firstLink}.\n\nWhich step would you change?`;
  const reply = entry([
    firstPoint,
    read('read'),
    secondPoint,
    text('ask', words, { canonical: true }),
  ]);
  const steps = narrationSteps(reply);
  expect(steps.slice(3).map((s) => s.kind === 'say' && s.text)).toEqual([
    'Inspect setup.',
    'Which step would you change?',
  ]);
  expect(pointerAt(steps, 2)?.id).toBe('first');
  expect(pointerAt(steps, 3)?.id).toBe('first');
  const silent = entry([firstPoint, secondPoint]);
  expect(pointerAt(narrationSteps({ ...silent, status: 'running' }), 1)?.id).toBe('first');
  expect(pointerAt(narrationSteps(silent), 1)?.id).toBe('next');
  expect(pointerAt(steps, 4)?.id).toBe('next');
  for (const step of steps.slice(3)) {
    if (step.kind !== 'say' || !step.passage) throw new Error('Missing passage');
    const [partial] = toldConversation([reply], {
      id: reply.id,
      part: step.part,
      said: step.passage.to,
    });
    expect(partial.parts.at(-1)).toMatchObject({
      text: step === steps[3] ? words.split('\n')[0] : words,
    });
  }
  // A partial Markdown link must not be spoken, or change an already queued paragraph.
  const streamed = (body: string) =>
    narrationSteps(entry([firstPoint, secondPoint, text('live', body, { streaming: true })]));
  expect(streamed('Inspect [setup](#pbl').map((s) => s.kind)).toEqual(['point', 'point']);
  const prefix = streamed(`Inspect ${firstLink}.\n\nWh`);
  expect(prefix[2]).toMatchObject({ part: 2, text: 'Inspect setup.', streaming: false });
  expect(pointerAt(prefix, 2)?.id).toBe('first');
});

it('matches a cited subrange only to an unambiguous issued code cue', () => {
  const cue = (id: string, line: number, end: number) =>
    point(id, { path: 'PLAN.md', line, end, pointer: 'spotlight' });
  const first = cue('choice', 13, 19);
  const second = cue('steps', 35, 41);
  const paragraph = text(
    'explain',
    '[choice](PLAN.md#pbl-file=PLAN.md&line=13&end=18)\n\n[steps](PLAN.md#pbl-file=PLAN.md&line=35&end=41)',
  );
  const steps = narrationSteps(entry([first, second, paragraph]));
  expect(pointerAt(steps, 2)?.id).toBe('choice');
  expect(pointerAt(steps, 3)?.id).toBe('steps');
  const ambiguous = narrationSteps(entry([first, cue('overlap', 12, 18), second, paragraph]));
  expect(pointerAt(ambiguous, 3)).toBeUndefined();
});

it('adds one spoken next action after confirmed completion, never on failure, review or final recap', () => {
  const instruction = 'Click Enter discussion.';
  const complete = {
    kind: 'tool',
    id: 'done',
    action: 'complete',
    status: 'succeeded',
    readyForStudentConfirmation: true,
  } as const;
  const reply = entry([
    text('summary', 'Keep this explanation.'),
    { ...complete, id: 'try', status: 'failed' },
    complete,
    { ...complete, id: 'retry' },
  ]);
  const spoken = (e: LearningConversationEntry, next?: string) =>
    narrationSteps(e, next).flatMap((s) => (s.kind === 'say' ? [s.text] : []));
  const afterMention = { label: 'Enter discussion', confirmation: 'This step is complete.' };
  for (const closing of [
    'Click **Enter discussion**.',
    'Wait until you can click Enter discussion.',
    'Enter discussion later.\n\nFirst, compare both options.',
  ]) {
    expect(
      narrationSteps(entry([text('summary', closing), complete]), instruction, afterMention).at(-1),
    ).toMatchObject({ kind: 'say', text: afterMention.confirmation });
  }
  for (const closing of ['Let us discuss this.', 'Go on when you are ready.']) {
    expect(
      narrationSteps(entry([text('summary', closing), complete]), instruction, afterMention).at(-1),
    ).toMatchObject({ kind: 'say', text: instruction });
  }
  expect(spoken(reply, instruction)).toEqual(['Keep this explanation.', instruction]);
  expect(
    spoken(entry([{ ...complete, readyForStudentConfirmation: undefined }]), instruction),
  ).toEqual([]);
  expect(spoken(reply)).toEqual(['Keep this explanation.']);
  expect(spoken(entry([{ ...complete, projectCompleted: true }]), instruction)).toEqual([]);
  expect(spoken(entry([{ ...complete, action: 'read' }]), instruction)).toEqual([]);
});

it('never navigates from a file link alone and avoids guessing between competing ranges', () => {
  const during = (parts: Part[], words: string) => {
    const steps = narrationSteps(entry([...parts, text('speech', words)]));
    return pointerAt(steps, steps.length - 1)?.id;
  };
  expect(during([], firstLink)).toBeUndefined();
  expect(during([firstPoint, secondPoint], `${firstLink} and ${secondLink}`)).toBeUndefined();
  expect(during([firstPoint, secondPoint], `\`${firstLink}\``)).toBe('next');
  expect(during([firstPoint, secondPoint], '[a file](#pbl-file=z.ts&line=2)')).toBeUndefined();
  expect(during([firstPoint, board('note', ['item']), secondPoint], firstLink)).toBe('next');
  expect(
    during([firstPoint, point('preview', { selector: '.item', pointer: 'laser' })], firstLink),
  ).toBe('preview');
});

it('matches each text part or list item to its own issued location', () => {
  const a = `Read ${firstLink}.`;
  const b = `Check ${secondLink}.`;
  for (const parts of [
    [text('a', a), read('file'), text('b', b)],
    [text('list', `1. ${a}\n2. ${b}`)],
    [text('list', `- ${a}\n- ${b}`)],
  ]) {
    const steps = narrationSteps(entry([firstPoint, secondPoint, ...parts]));
    expect(
      steps.flatMap((s, i) => (s.kind === 'say' ? [[s.text, pointerAt(steps, i)?.id]] : [])),
    ).toEqual([
      [expect.stringContaining('Read setup.'), 'first'],
      [expect.stringContaining('Check work.'), 'next'],
    ]);
  }
});

it('only queues complete list items and maps them back to the original transcript', () => {
  const lead = `1. Read ${firstLink}.`;
  const tail = `2. Check ${secondLink}.`;
  const partial = narrationSteps(
    entry([firstPoint, secondPoint, text('list', `${lead}\n2. Check [wo`, { streaming: true })]),
  );
  const reply = entry([firstPoint, secondPoint, text('list', `${lead}\n${tail}`)]);
  const steps = narrationSteps(reply);
  expect(partial.length).toBe(3);
  expect(steps.length).toBe(4);
  expect(partial[2]).toMatchObject({ id: steps[2].id, text: '1. Read setup.' });
  for (const [index, prefix] of [
    [2, lead],
    [3, `${lead}\n${tail}`],
  ] as const) {
    const step = steps[index];
    if (step.kind !== 'say' || !step.passage) throw Error('Expected a passage');
    const [shown] = toldConversation([reply], {
      id: reply.id,
      part: step.part,
      said: step.passage.to,
    });
    expect(shown.parts.at(-1)).toMatchObject({ text: prefix });
  }
});

it('retires the previous explanation when a new point or board action takes over', () => {
  const steps = (parts: Part[]) =>
    narrationSteps(
      entry([
        firstPoint,
        secondPoint,
        text('first words', firstLink),
        ...parts,
        text('after', firstLink),
      ]),
    );
  for (const [parts, id] of [
    [[point('third', { path: 'c.ts', line: 1 })], 'third'],
    [[board('draw', ['one'])], undefined],
    [[point('app', { selector: '.app' })], 'app'],
    [[close, text('unissued', '[missing](#pbl-file=c.ts&line=1)')], 'first'],
  ] as const) {
    const result = steps([...parts]);
    expect(pointerAt(result, result.length - 1)?.id).toBe(id);
    if (id === 'first') expect(pointerAt(result, result.length - 2)).toBeUndefined();
  }
});

it('keeps the active code cue through board close and clears it for a real board action', () => {
  const steps = (parts: Part[]) => narrationSteps(entry(parts));
  const code = steps([
    firstPoint,
    close,
    read('review'),
    text('ask', 'Which line receives the answer?'),
  ]);
  expect(pointerAt(code, 3)?.id).toBe('first');
  expect(boardAt(code, 3)?.show).toBe(false);
  expect(pointerAt(steps([close]), 0)).toBeUndefined();
  expect(pointerAt(steps([firstPoint, board('draw', ['item']), close]), 2)).toBeUndefined();
  expect(
    pointerAt(
      steps([
        firstPoint,
        { ...close, name: 'wb_open', display: { op: 'open', label: '', seq: null } },
      ]),
      1,
    ),
  ).toBeUndefined();
  expect(pointerAt(steps([firstPoint, { ...close, status: 'failed' }]), 1)?.id).toBe('first');
  expect(
    pointerAt(steps([point('preview', { selector: '.item', pointer: 'laser' }), close]), 1),
  ).toBeUndefined();
});

it('reveals a file hint and its entire review question as a Markdown link arrives in chunks', () => {
  const prefix = 'Read ';
  const link = '[PLAN.md](#pbl-file=PLAN.md&line=12)';
  const question = ' before answering. Which step will you change?';
  let delivered = '';
  const source = prefix + link + question;
  for (let end = 1; end <= source.length; end++) {
    const steps = narrationSteps(
      entry([text('reply', source.slice(0, end), { streaming: end < source.length })]),
    );
    const words = steps[0]?.kind === 'say' ? steps[0].text : '';
    expect(words.startsWith(delivered)).toBe(true);
    expect(words).not.toContain('#pbl-file');
    delivered = words;
  }
  expect(delivered).toBe(prefix + 'PLAN.md' + question);
  const literal = narrationSteps(entry([text('reply', 'Inspect array[0]')]));
  expect(literal[0]).toMatchObject({ text: 'Inspect array[0]' });
});

it('retains literal brackets on seal and never reopens a link inside a finished destination', () => {
  for (const source of [
    'Inspect array[0]',
    'Review an unfinished [reference',
    'Great! Inspect ![diagram](guide.png) then choose.',
    'Read [sample](#pbl-file=src/[id].ts&line=2), then [notes](#pbl-file=b.md).',
  ]) {
    let revealed = '';
    for (let end = 1; end <= source.length; end++) {
      const next = spokenText(source.slice(0, end), end < source.length);
      expect(next.startsWith(revealed)).toBe(true);
      revealed = next;
    }
    expect(revealed).toBe(spokenText(source));
  }
});

it('restores a previously spoken receipt without queuing it when the source page is absent', () => {
  const words = 'Read [the plan](#pbl-file=PLAN.md). Which branch?';
  const source = text('message-1', words, { spokenAt: 5 });
  const receipt = text('question-2-review', words, { spokenAt: 5 });
  const snapshot = entry([text('other', 'Earlier hint.'), receipt]);
  expect(narrationSteps(snapshot).map((step) => step.id)).toEqual(['other']);
  expect(recoveredReviewSpeech(snapshot)?.text).toBe('Read the plan. Which branch?');
  expect(recoveredReviewSpeech({ ...snapshot, status: undefined })?.text).toBe(
    'Read the plan. Which branch?',
  );
  expect(recoveredReviewSpeech(entry([receipt, source]))).toBeUndefined();
  expect(narrationSteps(entry([source])).map((step) => step.kind)).toEqual(['say']);
  expect(
    narrationSteps(entry([text('question-tool-only', words)])).map((step) => step.kind),
  ).toEqual(['say']);
});

it('voices the rest of a legacy receipt after the source has played', () => {
  expect(unspokenReceipt('浏览器发送问题。请打开 PLAN.md 第七行。', ['浏览器发送问题。'])).toBe(
    '请打开 PLAN.md 第七行。',
  );
  expect(unspokenReceipt('First. Second. A new direction.', ['First.', 'Second.'])).toBe(
    'A new direction.',
  );
  expect(unspokenReceipt('First. New direction.', ['First. Old direction.'])).toBe(
    'New direction.',
  );
  expect(unspokenReceipt('First.', ['First.'])).toBe('');
  expect(unspokenReceipt('42 records returned.', ['4'])).toBe('42 records returned.');
  expect(unspokenReceipt('Open main.ts.', ['Open main.'])).toBe('Open main.ts.');
  expect(
    unspokenReceipt('Open the shell. Run `echo "A. C"`.', ['Open the shell. Run `echo "A. B"`.']),
  ).toBe('Run `echo "A. C"`.');
});
