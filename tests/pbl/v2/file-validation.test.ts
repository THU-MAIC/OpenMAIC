import { describe, expect, it } from 'vitest';

import {
  TEXT_FILE_EXTENSIONS,
  TEXT_FILE_ACCEPT,
  isValidTextFile,
} from '@/lib/pbl/v2/operations/file-validation';

function file(name: string, type = ''): File {
  return new File(['dummy content'], name, { type });
}

describe('PBL v2 — file upload type validation', () => {
  describe('TEXT_FILE_EXTENSIONS', () => {
    it('contains common text extensions', () => {
      expect(TEXT_FILE_EXTENSIONS.has('txt')).toBe(true);
      expect(TEXT_FILE_EXTENSIONS.has('py')).toBe(true);
      expect(TEXT_FILE_EXTENSIONS.has('json')).toBe(true);
      expect(TEXT_FILE_EXTENSIONS.has('csv')).toBe(true);
      expect(TEXT_FILE_EXTENSIONS.has('md')).toBe(true);
    });

    it('deliberately excludes .ipynb', () => {
      expect(TEXT_FILE_EXTENSIONS.has('ipynb')).toBe(false);
    });
  });

  describe('TEXT_FILE_ACCEPT', () => {
    it('produces a comma-separated dot-prefixed list', () => {
      expect(TEXT_FILE_ACCEPT.startsWith('.txt,.md,.markdown,.csv,.json')).toBe(true);
    });
  });

  describe('isValidTextFile', () => {
    it('accepts a .py file with text/ MIME', () => {
      expect(isValidTextFile(file('hello.py', 'text/x-python'))).toBe(true);
    });

    it('accepts a file with no MIME (browsers often omit for uncommon extensions)', () => {
      expect(isValidTextFile(file('data.jsonl', ''))).toBe(true);
    });

    it('accepts application/octet-stream with a valid text extension', () => {
      expect(isValidTextFile(file('script.sh', 'application/octet-stream'))).toBe(true);
    });

    it('accepts application/json MIME', () => {
      expect(isValidTextFile(file('config.json', 'application/json'))).toBe(true);
    });

    it('rejects a file with no extension', () => {
      expect(isValidTextFile(file('Makefile', 'text/plain'))).toBe(false);
    });

    it('rejects an unsupported extension', () => {
      expect(isValidTextFile(file('photo.png', 'image/png'))).toBe(false);
    });

    it('rejects .ipynb even though it is JSON underneath', () => {
      expect(isValidTextFile(file('notebook.ipynb', 'application/json'))).toBe(false);
    });

    it('rejects a rename attack: .exe renamed to .py but carrying x-msdownload MIME', () => {
      expect(isValidTextFile(file('malware.py', 'application/x-msdownload'))).toBe(false);
    });

    it('rejects a binary file with an explicit non-text MIME', () => {
      expect(isValidTextFile(file('data.pdf', 'application/pdf'))).toBe(false);
    });

    it('case-insensitive on extension', () => {
      expect(isValidTextFile(file('Main.PY', 'text/x-python'))).toBe(true);
      expect(isValidTextFile(file('README.MD', ''))).toBe(true);
    });
  });
});
