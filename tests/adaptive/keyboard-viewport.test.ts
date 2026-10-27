import { describe, expect, it } from 'vitest';
import { keyboardViewportState } from '@/lib/adaptive/keyboard-viewport';

const portrait = { width: 390, height: 844, scale: 1 };
describe('phone keyboard viewport baseline', () => {
  it('does not mistake a portrait-to-landscape rotation for an opened keyboard', () => {
    const first = keyboardViewportState(null, portrait);
    const landscape = keyboardViewportState(first, { width: 844, height: 390, scale: 1 });
    expect(landscape.keyboardOpen).toBe(false);
    expect(landscape.height).toBe(390);
  });
  it('detects keyboard shrinkage at a stable width in either orientation', () => {
    const first = keyboardViewportState(null, portrait);
    const typing = keyboardViewportState(first, { ...portrait, height: 440 });
    expect(typing.keyboardOpen).toBe(true);
    const landscape = keyboardViewportState(typing, { width: 844, height: 390, scale: 1 });
    expect(
      keyboardViewportState(landscape, { width: 844, height: 210, scale: 1 }).keyboardOpen,
    ).toBe(true);
  });
  it('clears the keyboard state after it closes', () => {
    const first = keyboardViewportState(null, portrait);
    const typing = keyboardViewportState(first, { ...portrait, height: 440 });
    expect(keyboardViewportState(typing, portrait).keyboardOpen).toBe(false);
  });
  it('does not treat pinch zoom as a keyboard or replace the unzoomed baseline', () => {
    const first = keyboardViewportState(null, portrait);
    const zoomed = keyboardViewportState(first, { width: 195, height: 422, scale: 2 });
    expect(zoomed).toEqual({ width: 390, height: 844, keyboardOpen: false });
  });
});
