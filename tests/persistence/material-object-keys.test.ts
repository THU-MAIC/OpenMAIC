import { describe, expect, it } from 'vitest';

import {
  assertPortableMaterialObjectKey,
  isLegacySessionMaterialObjectKey,
  isSessionMaterialObjectKey,
  ownerMaterialObjectKey,
  safeMaterialStorageNamespace,
  sessionMaterialObjectKey,
} from '@/lib/server/materials/object-keys';

describe('material object key contract', () => {
  it('derives a stable domain-separated SHA-256 owner namespace', () => {
    expect(safeMaterialStorageNamespace('owner', 'anon:00000000-0000-4000-8000-000000000001')).toBe(
      'own_16f88273bc58605c2b7319fd6f009b66577da9c533fdc0f85c970b13e8f258db',
    );
    expect(safeMaterialStorageNamespace('owner', 'same')).not.toBe(
      safeMaterialStorageNamespace('session', 'same'),
    );
  });

  it('is deterministic and uses the same portable result on Windows and Linux', () => {
    const first = ownerMaterialObjectKey('anon:abc', 'mat_alpha');
    const second = ownerMaterialObjectKey('anon:abc', 'mat_alpha');
    expect(first).toBe(second);
    expect(first).toMatch(/^materials\/v1\/owners\/own_[a-f0-9]{64}\/mat_[a-f0-9]{64}\/raw$/);
    expect(first).not.toMatch(/[\\:<>'"|?*]/);
    expect(() => assertPortableMaterialObjectKey(first)).not.toThrow();
  });

  it('separates different owners without disclosing either owner or material id', () => {
    const first = ownerMaterialObjectKey('owner-a', 'mat_shared');
    const second = ownerMaterialObjectKey('owner-b', 'mat_shared');
    expect(first).not.toBe(second);
    expect(first).not.toContain('owner-a');
    expect(first).not.toContain('mat_shared');
  });

  it.each([
    'anon:00000000-0000-4000-8000-000000000001',
    '../outside',
    'owner/../../outside',
    'owner\\outside',
  ])('contains malicious owner input inside one safe namespace: %s', (ownerId) => {
    const key = ownerMaterialObjectKey(ownerId, 'mat_alpha');
    expect(() => assertPortableMaterialObjectKey(key)).not.toThrow();
    expect(key).not.toContain(ownerId);
  });

  it('hashes session and material identities and enforces the session prefix guard', () => {
    const key = sessionMaterialObjectKey(
      'session/../../foreign',
      'mat/../../foreign',
      'raw.YXBwbGljYXRpb24vcGRm',
    );
    expect(() => assertPortableMaterialObjectKey(key)).not.toThrow();
    expect(isSessionMaterialObjectKey('session/../../foreign', key)).toBe(true);
    expect(isSessionMaterialObjectKey('session-other', key)).toBe(false);
    expect(key).not.toContain('session/');
  });

  it('rejects traversal hidden behind an otherwise valid canonical session prefix', () => {
    const key = sessionMaterialObjectKey('session-a', 'mat-a', 'raw.bin');
    const traversal = key.replace(/\/[^/]+\/raw\.bin$/, '/../other-session/raw.bin');
    expect(traversal).toContain('/../');
    expect(isSessionMaterialObjectKey('session-a', traversal)).toBe(false);
  });

  it('permits legacy reads only for portable pre-v1 session segments', () => {
    expect(isLegacySessionMaterialObjectKey('session-1', 'materials/session-1/mat_1/raw.bin')).toBe(
      true,
    );
    expect(
      isLegacySessionMaterialObjectKey('../session', 'materials/../session/mat_1/raw.bin'),
    ).toBe(false);
    expect(
      isLegacySessionMaterialObjectKey('session/other', 'materials/session/other/mat_1/raw.bin'),
    ).toBe(false);
    expect(
      isLegacySessionMaterialObjectKey(
        'session-1',
        'materials/session-1/../session-2/mat_1/raw.bin',
      ),
    ).toBe(false);
    expect(isLegacySessionMaterialObjectKey('session.', 'materials/session./mat_1/raw.bin')).toBe(
      false,
    );
  });

  it.each([
    '../outside',
    'materials/anon:owner/mat',
    'materials/owner\\outside/mat',
    'materials/CON/file',
    'materials/trailing./file',
  ])('rejects non-portable direct object keys: %s', (key) => {
    expect(() => assertPortableMaterialObjectKey(key)).toThrow('invalid material object key');
  });
});
