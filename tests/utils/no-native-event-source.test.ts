/**
 * App code opens event streams through `FetchEventSource`, never the native class.
 *
 * Going back to `new EventSource` compiles and passes every suite that fakes the
 * streams, and silently brings back what `FetchEventSource` exists to prevent: on a
 * slow connection, script chunks held behind the streams for tens of seconds.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const NATIVE = /\bnew\s+(?:(?:globalThis|window|self)\s*\.\s*)?EventSource\s*\(/;

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('native EventSource', () => {
  it('is not constructed by app code', () => {
    const offenders = ['app', 'components', 'lib', 'packages'].flatMap((directory) =>
      sources(join(ROOT, directory))
        .filter((path) => !/(^|\/)(node_modules|dist)\//.test(path))
        .filter((path) => NATIVE.test(readFileSync(path, 'utf8')))
        .map((path) => relative(ROOT, path)),
    );
    expect(offenders).toEqual([]);
  });

  it('would be caught in the forms a revert takes', () => {
    for (const code of [
      'new EventSource(url)',
      'new window.EventSource(url)',
      'new EventSource(\n  url,\n)',
    ]) {
      expect(code).toMatch(NATIVE);
    }
    expect('// a new EventSource without that cursor').not.toMatch(NATIVE);
    expect('new FetchEventSource(url)').not.toMatch(NATIVE);
  });
});
