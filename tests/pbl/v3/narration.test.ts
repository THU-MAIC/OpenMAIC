import { expect, it } from 'vitest';
import { deduplicateHandoffs, type LearningConversationEntry } from '@/lib/pbl/v3/conversation';
import {
  boardWrites,
  narrationSegments,
  narrationSteps,
  pointerAt,
  toldConversation,
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
const point = (id: string) =>
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
      target: { path: 'a.ts', line: 3, pointer: 'laser' },
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
  // A step is known by its place among the reply's parts, not by an id the stream may change.
  expect(steps.map((step) => step.part)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  // The pointer is held through the sentence after it and leaves when the board is written.
  expect(pointerAt(steps, 4)).toBeUndefined();
  expect(pointerAt(steps, 6)).toMatchObject({ id: 'f' });
  expect(pointerAt(steps, 7)).toBeUndefined();
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
  // Speech the recorded reply repeats is the echo it always was.
  const [echoed] = deduplicateHandoffs([
    entry([
      text('a', 'Start with the overview.', { messageId: 1 }),
      board('c', ['title']),
      text('question-1', 'Start with the overview.\n\nWhich step would you try first?', {
        canonical: true,
      }),
    ]),
  ]);
  expect(echoed.parts.filter((part) => part.kind === 'text').map((part) => part.id)).toEqual([
    'question-1',
  ]);
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
