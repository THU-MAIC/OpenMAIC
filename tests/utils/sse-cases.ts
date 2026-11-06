/**
 * Streams and the frames a conforming `EventSource` delivers for them. Each is
 * read to its end: `expected` lists what arrives before the stream closes.
 */
export interface SseCase {
  readonly name: string;
  readonly body: string;
  readonly expected: ReadonlyArray<{ type: string; data: string; lastEventId: string }>;
}

const frame = (data: string, type = 'message', lastEventId = '') => ({ type, data, lastEventId });

export const SSE_CASES: readonly SseCase[] = [
  { name: 'one message', body: 'data: a\n\n', expected: [frame('a')] },
  { name: 'multi-line data', body: 'data: a\ndata: b\ndata:\n\n', expected: [frame('a\nb\n')] },
  { name: 'empty data dispatches', body: 'data\n\ndata:\n\n', expected: [frame(''), frame('')] },
  { name: 'named event', body: 'event: x\ndata: a\n\n', expected: [frame('a', 'x')] },
  {
    name: 'type resets per frame',
    body: 'event: x\ndata: a\n\ndata: b\n\n',
    expected: [frame('a', 'x'), frame('b')],
  },
  {
    name: 'frame without data dispatches nothing and drops its type',
    body: 'event: x\n\ndata: a\n\n',
    expected: [frame('a')],
  },
  {
    name: 'id persists until replaced',
    body: 'id: 1\ndata: a\n\ndata: b\n\nid: 2\ndata: c\n\n',
    expected: [frame('a', 'message', '1'), frame('b', 'message', '1'), frame('c', 'message', '2')],
  },
  {
    name: 'id on a frame without data still commits',
    body: 'id: 7\n\ndata: a\n\n',
    expected: [frame('a', 'message', '7')],
  },
  {
    name: 'empty id clears',
    body: 'id: 1\ndata: a\n\nid\ndata: b\n\n',
    expected: [frame('a', 'message', '1'), frame('b')],
  },
  {
    name: 'id containing NUL is ignored',
    body: 'id: 1\ndata: a\n\nid: 2\0\ndata: b\n\n',
    expected: [frame('a', 'message', '1'), frame('b', 'message', '1')],
  },
  { name: 'comments are ignored', body: ': ping\n\n:\ndata: a\n: x\n\n', expected: [frame('a')] },
  { name: 'unknown fields are ignored', body: 'foo: 1\nbar\ndata: a\n\n', expected: [frame('a')] },
  {
    name: 'only one leading space goes',
    body: 'data:  a \ndata:b\n\n',
    expected: [frame(' a \nb')],
  },
  { name: 'colons in the value stay', body: 'data: a:b: c\n\n', expected: [frame('a:b: c')] },
  { name: 'field names are case sensitive', body: 'DATA: a\ndata: b\n\n', expected: [frame('b')] },
  { name: 'CR line ends', body: 'event: x\rdata: a\r\r', expected: [frame('a', 'x')] },
  { name: 'CRLF line ends', body: 'event: x\r\ndata: a\r\n\r\n', expected: [frame('a', 'x')] },
  {
    name: 'mixed line ends',
    body: 'data: a\r\ndata: b\n\rdata: c\r\r\ndata: d\n\n',
    expected: [frame('a\nb'), frame('c'), frame('d')],
  },
  { name: 'unterminated frame is dropped', body: 'data: a\n\ndata: b\n', expected: [frame('a')] },
  { name: 'unterminated line is dropped', body: 'data: a\n\ndata: b', expected: [frame('a')] },
  { name: 'leading BOM is skipped', body: '\uFEFFdata: a\n\n', expected: [frame('a')] },
  { name: 'later BOM is data', body: 'data: \uFEFFa\n\n', expected: [frame('\uFEFFa')] },
  { name: 'multibyte text', body: 'data: 课堂 🎓 é\n\n', expected: [frame('课堂 🎓 é')] },
  {
    name: 'retry alone dispatches nothing',
    body: 'retry: 5000\n\ndata: a\n\n',
    expected: [frame('a')],
  },
];
