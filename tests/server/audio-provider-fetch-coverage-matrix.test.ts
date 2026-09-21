/**
 * Coverage matrix for the audio-provider strict transport.
 *
 * A per-provider manual fix drifts: a new provider (or a refactor) can quietly
 * reintroduce a raw `fetch(\`${baseUrl}/…\`)` that skips redirect re-validation
 * and connect-time DNS pinning. This test scans every `lib/audio/*.ts` source
 * file for outbound request calls and fails unless each one is either:
 *
 *  - the strict helper (`audioProviderFetch` / `createAudioProviderFetch`), or
 *  - a client-relative request to this app's own API (`fetch('/api/…')`).
 *
 * There are no per-file exceptions: the last one (`downloadAudio`, which kept
 * its own result-host allowlist and `redirect: 'error'`) now goes through the
 * pinned helper too, so any raw provider `fetch` in `lib/audio` is a finding.
 *
 * The four provider modules must also import the helper, so deleting the wiring
 * (not just adding a raw fetch) is caught.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const AUDIO_DIR = join(process.cwd(), 'lib', 'audio');

/** Modules whose outbound provider requests must all use the strict helper. */
const PROVIDER_MODULES = [
  'tts-providers.ts',
  'asr-providers.ts',
  'qwen-voice-clone.ts',
  'voxcpm-registration.ts',
];

/** Call spellings that would bypass the helper. */
const RAW_REQUEST_PATTERN = /\b(?:fetch|undiciFetch|request)\s*\(/g;

/**
 * Remove comments while preserving string/`template` literals, so a `fetch(`
 * inside a doc example is ignored but one in real code is not.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          out += '  ';
          i += 2;
          break;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          out += `${source[i]}${source[i + 1] ?? ''}`;
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Walk from an opening `(` to its matching `)` and return the end index. */
function matchingParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface RawCall {
  file: string;
  call: string;
  firstArg: string;
}

function findRawRequestCalls(file: string, source: string): RawCall[] {
  const text = stripComments(source);
  const calls: RawCall[] = [];
  RAW_REQUEST_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RAW_REQUEST_PATTERN.exec(text)) !== null) {
    const open = text.indexOf('(', match.index);
    const close = matchingParen(text, open);
    if (close === -1) continue;
    const call = source.slice(match.index, close + 1);
    const firstArg = text
      .slice(open + 1, close)
      .split(',', 1)[0]!
      .trim();
    calls.push({ file, call, firstArg });
  }
  return calls;
}

function isClientRelative(firstArg: string): boolean {
  return /^['"`]\//.test(firstArg);
}

describe('lib/audio outbound request coverage matrix', () => {
  const files = readdirSync(AUDIO_DIR).filter((name) => name.endsWith('.ts'));

  it('scans the audio module set', () => {
    for (const required of PROVIDER_MODULES) {
      expect(files).toContain(required);
    }
  });

  it('every outbound request uses audioProviderFetch or is client-relative', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(AUDIO_DIR, file), 'utf-8');
      for (const raw of findRawRequestCalls(file, source)) {
        if (isClientRelative(raw.firstArg)) continue;
        offenders.push(`${raw.file}: ${raw.call.slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every provider module wired to the strict helper', () => {
    for (const file of PROVIDER_MODULES) {
      const source = readFileSync(join(AUDIO_DIR, file), 'utf-8');
      expect(source, `${file} must import the strict helper`).toMatch(
        /from '@\/lib\/server\/audio-provider-fetch'/,
      );
      expect(source, `${file} must use the strict helper`).toMatch(/audioProviderFetch\s*\(/);
    }
  });
});
