import { describe, expect, it } from 'vitest';
import {
  createParserState,
  finalizeParser,
  parseStructuredChunk,
} from '@/lib/chat/structured-output';

function collect(input: string, chunkSize: number) {
  const state = createParserState();
  const results = [];
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    results.push(parseStructuredChunk(input.slice(offset, offset + chunkSize), state));
  }
  results.push(finalizeParser(state));
  return {
    text: results.flatMap((result) => result.textChunks).join(''),
    actions: results.flatMap((result) => result.actions.map((action) => action.actionName)),
  };
}

describe('structured output stream boundaries', () => {
  it.each([
    'The lesson uses [H] and ATP.',
    '[H] is a label. Here is an array example: [{"name":"tree"}].',
  ])('preserves brackets in plain speech: %s', (speech) => {
    for (let size = 1; size <= speech.length; size++) {
      expect(collect(speech, size)).toEqual({ text: speech, actions: [] });
    }
  });

  it.each(['', 'Here is the classroom response for [H]: ', '```json\n'])(
    'emits text and actions once with the prefix %j',
    (prefix) => {
      const speech = 'Follow [H] to the next panel. "Look here."';
      const input =
        prefix +
        JSON.stringify([
          { type: 'action', name: 'wb_open', params: {} },
          { type: 'text', content: speech },
          { type: 'action', name: 'wb_close', params: { nested: [[1, 2]] } },
        ]) +
        (prefix.startsWith('```') ? '\n```' : '');
      for (let size = 1; size <= input.length; size++) {
        expect(collect(input, size), `chunk size ${size}`).toEqual({
          text: speech,
          actions: ['wb_open', 'wb_close'],
        });
      }
    },
  );

  it.each(['', 'Here is the classroom response: '])(
    'preserves unescaped quotation marks in speech with the prefix %j',
    (prefix) => {
      const input =
        prefix +
        '[{"type":"text","content":"The label says "start" here."},' +
        '{"type":"action","name":"wb_open","params":{}}]';
      for (let size = 1; size <= input.length; size++) {
        expect(collect(input, size)).toEqual({
          text: 'The label says "start" here.',
          actions: ['wb_open'],
        });
      }
    },
  );

  it('streams text in order and waits for the drawing item to finish', () => {
    const state = createParserState();
    const start = parseStructuredChunk(
      '[{"type":"action","name":"wb_open"},{"type":"text","content":"Follow [H]',
      state,
    );
    expect(start.actions.map((action) => action.actionName)).toEqual(['wb_open']);
    expect(start.textChunks).toEqual(['Follow [H]']);
    expect(start.ordered).toEqual([
      { type: 'action', index: 0 },
      { type: 'text', index: 0 },
    ]);
    expect(start.isDone).toBe(false);

    const middle = parseStructuredChunk(
      ' here."},{"type":"action","name":"wb_draw_line","params":{"points":[1,2]',
      state,
    );
    expect(middle.textChunks).toEqual([' here.']);
    expect(middle.actions).toEqual([]);
    expect(middle.isDone).toBe(false);

    const end = parseStructuredChunk('}}]', state);
    expect(end.actions.map((action) => action.actionName)).toEqual(['wb_draw_line']);
    expect(end.isDone).toBe(true);
    expect(finalizeParser(state).actions).toEqual([]);
  });

  it.each(['', '```json\n'])(
    'recovers an unescaped quote and the following items at end of stream with prefix %j',
    (prefix) => {
      const input =
        prefix +
        '[{"type":"action","name":"wb_open"},' +
        '{"type":"text","content":"The screen is 27" wide."},' +
        '{"type":"action","name":"wb_draw_line","params":{"points":[0,0,1,1]}},' +
        '{"type":"text","content":"Look here."}]' +
        (prefix ? '\n```' : '');
      for (let size = 1; size <= input.length; size++) {
        expect(collect(input, size), `chunk size ${size}`).toEqual({
          text: 'The screen is 27" wide.Look here.',
          actions: ['wb_open', 'wb_draw_line'],
        });
      }
    },
  );

  it.each(['', '{"type":"text","content":"Before. "},', '{"type":"action","name":"wb_open"},'])(
    'preserves the recoverable speech prefix after a false item boundary with preceding item %j',
    (preceding) => {
      const input =
        '[' +
        preceding +
        '{"type":"text","content":"Use "}" to close the object."},' +
        '{"type":"action","name":"wb_close","params":{}}]';
      for (let size = 1; size <= input.length; size++) {
        // Preserve the baseline's text prefix, without promising recovery of
        // the malformed remainder or the following action.
        expect(collect(input, size), `chunk size ${size}`).toEqual({
          text: (preceding.includes('Before.') ? 'Before. ' : '') + 'Use ',
          actions: preceding.includes('wb_open') ? ['wb_open'] : [],
        });
      }
    },
  );

  it('does not repair a truncated action after an unescaped quote', () => {
    const input =
      '[{"type":"action","name":"wb_open"},' +
      '{"type":"text","content":"The screen is 27" wide."},' +
      '{"type":"action","name":"wb_draw_line","params":{"points":[{"x":1}]';
    expect(collect(input, 1).actions).toEqual(['wb_open']);
  });
});
