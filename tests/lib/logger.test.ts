import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/lib/logger';

describe('createLogger error formatting', () => {
  afterEach(() => vi.restoreAllMocks());

  function logged(error: Error): string {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('Test').error('failed:', error);
    return String(spy.mock.calls[0]?.[0]);
  }

  it('keeps a V8-style stack that already contains the message', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at work (file.js:1:1)';
    const line = logged(error);
    expect(line).toContain('Error: boom\n    at work (file.js:1:1)');
    expect(line.match(/boom/g)).toHaveLength(1);
  });

  it('adds the name and message when a WebKit-style stack lists frames only', () => {
    const error = new TypeError('Chat storage requires the Web Locks API');
    error.stack = 'withPartitionLocks@http://host/chunk.js:1:9622';
    expect(logged(error)).toContain(
      'TypeError: Chat storage requires the Web Locks API\nwithPartitionLocks@http://host/chunk.js:1:9622',
    );
  });

  it('falls back to name and message without a stack', () => {
    const error = new Error('no stack');
    error.stack = undefined;
    expect(logged(error)).toContain('Error: no stack');
  });
  it('adds the header when the message only appears inside a frame', () => {
    const error = new TypeError('fetch');
    error.stack = 'fetch@http://host/app.js:1:1';
    expect(logged(error)).toContain('TypeError: fetch\nfetch@http://host/app.js:1:1');
  });

  it('adds the header for an empty message with a frame-only stack', () => {
    const error = new Error('');
    error.stack = 'work@http://host/app.js:1:1';
    expect(logged(error)).toContain('Error: \nwork@http://host/app.js:1:1');
  });
});
