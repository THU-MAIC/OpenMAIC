/**
 * PBL v2 — Scene-visual sanitization (increment 5).
 *
 * The backdrop is driven by the LLM-authored, project-wide `scenario.sceneVisual`.
 * The renderer sanitizes it so a missing / malformed spec (e.g. an older
 * package, or a bad colour) can never break the view — always a complete,
 * valid, render-safe object.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeSceneVisual } from '@/components/scene-renderers/pbl/v2/scene-stage/scene-types';

describe('PBL v2 — sanitizeSceneVisual', () => {
  it('passes through a well-formed visual', () => {
    const v = sanitizeSceneVisual({
      caption: '深夜，各自房间隔着手机聊到天亮',
      bg1: '#221133',
      bg2: '#0d0a1a',
      accent: '#ff8fab',
      motifs: ['📱', '🌙', '🛏️'],
    });
    expect(v.bg1).toBe('#221133');
    expect(v.bg2).toBe('#0d0a1a');
    expect(v.accent).toBe('#ff8fab');
    expect(v.motifs).toEqual(['📱', '🌙', '🛏️']);
    expect(v.caption).toBe('深夜，各自房间隔着手机聊到天亮');
  });

  it('falls back to a neutral palette when sceneVisual is absent (older package)', () => {
    const v = sanitizeSceneVisual(undefined);
    expect(v.bg1).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(v.bg2).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(v.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(v.motifs).toEqual([]);
    expect(v.caption).toBeUndefined();
  });

  it('rejects malformed colours and keeps the fallback (never breaks render)', () => {
    const v = sanitizeSceneVisual({
      bg1: 'rgb(1,2,3)',
      bg2: 'not-a-colour',
      accent: '#12g',
      motifs: [],
    });
    expect(v.bg1).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(v.bg2).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(v.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('accepts shorthand hex and caps motifs at 4 (dropping empties)', () => {
    const v = sanitizeSceneVisual({
      bg1: '#abc',
      motifs: ['🃏', '', '  ', '♠️', '🪙', '💵', '🎲'],
    });
    expect(v.bg1).toBe('#abc');
    expect(v.motifs).toHaveLength(4);
    expect(v.motifs).toEqual(['🃏', '♠️', '🪙', '💵']);
  });
});
