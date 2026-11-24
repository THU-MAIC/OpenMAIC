import { describe, expect, it } from 'vitest';
import { FAILURE_REASON_MAX_LENGTH, sanitizeFailureReason } from '../src/failure-reason.js';

describe('sanitizeFailureReason', () => {
  it.each([
    '/tmp/render-private/course.html',
    '/var/projects/private/output.mp4',
    'C:\\Users\\private\\course.html',
    '\\\\server\\private\\course.html',
  ])('masks absolute path %s', (path) => {
    expect(sanitizeFailureReason(`ENOENT: no such file or directory, open '${path}'`)).toBe(
      "ENOENT: no such file or directory, open '[path]'",
    );
  });

  it.each([
    ["'/tmp/render/Private Course/index.html'", "'[path]'"],
    ['"/tmp/render/Teacher\'s Notes/a.mp3"', '"[path]"'],
    ["'C:\\Users\\Private User\\course.html'", "'[path]'"],
    ["'/tmp/render/Teacher's Private Notes/a.mp3'", "'[path]'"],
  ])('masks a whole quoted path with spaces or quotes: %s', (quoted, masked) => {
    const reason = sanitizeFailureReason(`ENOENT: no such file or directory, open ${quoted}`);
    expect(reason).toBe(`ENOENT: no such file or directory, open ${masked}`);
    expect(reason).not.toMatch(/Private|Teacher|Course|Notes/);
  });

  it.each([
    'https://example.com/private?token=secret',
    'http://192.0.2.10:9000/render/abc',
    'www.example.com/a?b=c',
    'data:text/html,secret-course',
  ])('masks URL %s', (url) => {
    const reason = sanitizeFailureReason(`Failed to fetch ${url} (status 500)`);
    expect(reason).toBe('Failed to fetch [url] (status 500)');
    expect(reason).not.toContain('secret');
  });

  it('masks a URL or unquoted path through embedded quote characters', () => {
    const reason = sanitizeFailureReason(
      "Failed to fetch https://cdn.example.com/Teacher'sNotes/a.mp3?token=Secret and /tmp/a'b/Private.mp3",
    );
    expect(reason).toBe('Failed to fetch [url] and [path]');
  });

  it('keeps an unknown error message so the failure stays explainable', () => {
    expect(sanitizeFailureReason("Cannot read properties of undefined (reading 'duration')")).toBe(
      "Cannot read properties of undefined (reading 'duration')",
    );
  });

  it('keeps nested executor diagnostics', () => {
    expect(
      sanitizeFailureReason(
        'Chunk 2 failed after 2 attempts: [plan] entry file not found: /tmp/p/index.html',
      ),
    ).toBe('Chunk 2 failed after 2 attempts: [plan] entry file not found: [path]');
  });

  it('collapses newlines and control characters into one line', () => {
    expect(sanitizeFailureReason('Chunk assembly failed:\r\n\tENOMEM\u0000\u001b[31m')).toBe(
      'Chunk assembly failed: ENOMEM [31m',
    );
  });

  it('caps the reason, masking before truncating', () => {
    const long = sanitizeFailureReason(`${'x'.repeat(290)} https://example.com/${'y'.repeat(50)}`);
    expect(long.length).toBeLessThanOrEqual(FAILURE_REASON_MAX_LENGTH);
    expect(long).not.toContain('example');
    expect(sanitizeFailureReason('a'.repeat(1000))).toHaveLength(FAILURE_REASON_MAX_LENGTH);
  });

  it('is idempotent and never empty', () => {
    const once = sanitizeFailureReason('spawn ffmpeg ENOENT at /usr/bin/ffmpeg');
    expect(sanitizeFailureReason(once)).toBe(once);
    expect(sanitizeFailureReason(' \n ')).toBe('[empty]');
  });
});
