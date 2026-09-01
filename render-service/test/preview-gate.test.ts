import { describe, expect, it } from 'vitest';
import { PreviewGate, PreviewRejectedError } from '../src/preview-gate.js';

describe('PreviewGate', () => {
  it('enforces the global in-flight cap', () => {
    const gate = new PreviewGate(1, 0);
    const release = gate.acquire('alice');
    expect(() => gate.acquire('bob')).toThrow(PreviewRejectedError);
    expect(() => gate.acquire('bob')).toThrow(/preview queue is full/i);

    release();
    expect(() => gate.acquire('bob')).not.toThrow();
  });

  it('enforces an independent per-identity cap', () => {
    const gate = new PreviewGate(8, 1);
    const releaseAlice = gate.acquire('alice');
    expect(() => gate.acquire('alice')).toThrow(/Too many concurrent previews \(limit 1\)/);

    const releaseBob = gate.acquire('bob');
    expect(() => gate.acquire('bob')).toThrow(PreviewRejectedError);
    releaseAlice();
    releaseBob();
  });

  it('disables the per-identity check when maxPerUser is zero', () => {
    const gate = new PreviewGate(3, 0);
    const releases = [gate.acquire('alice'), gate.acquire('alice'), gate.acquire('alice')];
    expect(() => gate.acquire('bob')).toThrow(/preview queue is full/i);
    releases.forEach((release) => release());
  });

  it('returns an idempotent release function', () => {
    const gate = new PreviewGate(2, 1);
    const release = gate.acquire('alice');
    release();
    release();

    const current = gate.acquire('alice');
    expect(() => gate.acquire('alice')).toThrow(PreviewRejectedError);
    current();
    expect(() => gate.acquire('alice')).not.toThrow();
  });
});
