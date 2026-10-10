import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTouchEvent } from '@/components/slide-renderer/Editor/Canvas/hooks/touch-event';

/**
 * Desktop Safari has no `TouchEvent` global, so an `instanceof` test against
 * it throws a ReferenceError there. The legacy slide editor's gesture hooks
 * used one on pointer-down, which broke every drag, resize and rotate in
 * Safari.
 */
describe('isTouchEvent', () => {
  it('runs where the TouchEvent global does not exist, as in desktop Safari', () => {
    expect(typeof (globalThis as { TouchEvent?: unknown }).TouchEvent).toBe('undefined');
    const mouse = { pageX: 10, pageY: 20 } as unknown as MouseEvent;
    expect(isTouchEvent(mouse)).toBe(false);
  });

  it('recognises a touch event by its changedTouches list', () => {
    const touch = { changedTouches: [{ pageX: 1, pageY: 2 }] } as unknown as TouchEvent;
    expect(isTouchEvent(touch)).toBe(true);
  });
});

const ROOT = path.resolve(__dirname, '../..');
const SCANNED = ['app', 'components', 'lib'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe('browser code never reads the TouchEvent global', () => {
  it('has no `instanceof TouchEvent` check', () => {
    const offenders = SCANNED.flatMap((dir) => sourceFiles(path.join(ROOT, dir)))
      .filter((file) => /instanceof\s+TouchEvent\b/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});
