import { describe, expect, test } from 'vitest';

import type { AgentSessionMaterialStore } from '../src/material/types.js';
import type { AgentSessionStore } from '../src/agent-session/types.js';

export type AgentSessionMaterialContractStore = AgentSessionMaterialStore & {
  createSession: AgentSessionStore['createSession'];
};

/**
 * Backend-neutral semantics for the durable session-scoped material store.
 *
 * The anchor mirrors the reference: materials are minted with the `mat_` id
 * shape, every read is scoped by session id (a foreign or nonexistent id reads
 * as absent), and listing pages newest-first with a keyset `before` cursor.
 * The bytes are not part of this contract — the row records the byte-store
 * asset ids that the host persisted through the asset registry — so the
 * linkage is verified by round-tripping the recorded ids, not the bytes.
 */
export function runAgentSessionMaterialContract(
  name: string,
  makeStore: () => AgentSessionMaterialContractStore,
): void {
  describe(`AgentSessionMaterialStore contract: ${name}`, () => {
    test('creates a material with a minted mat_ id and persists the linkage fields', async () => {
      const store = makeStore();
      await store.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });

      const material = await store.createMaterial('session-1', {
        kind: 'web',
        title: 'Example page',
        sourceUrl: 'https://example.com/article',
        textAssetId: 'ast_text_1',
        rawAssetId: 'ast_raw_1',
        textChars: 1200,
      });

      expect(material.id).toMatch(/^mat_[0-9a-hjkmnp-tv-z]{26}$/);
      expect(material).toMatchObject({
        sessionId: 'session-1',
        kind: 'web',
        title: 'Example page',
        sourceUrl: 'https://example.com/article',
        textAssetId: 'ast_text_1',
        rawAssetId: 'ast_raw_1',
        textChars: 1200,
      });
      expect(new Date(material.createdAt).getTime()).toBeGreaterThan(0);

      // The row is the linkage: the recorded asset ids resolve back to the
      // exact values fetch_url persisted through the asset registry.
      const read = await store.getMaterial('session-1', material.id);
      expect(read).toEqual(material);
    });

    test('accepts a caller-minted id and defaults textChars to 0', async () => {
      const store = makeStore();
      await store.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });

      const material = await store.createMaterial('session-1', {
        id: 'mat_custom',
        kind: 'web',
        sourceUrl: 'https://example.com/',
      });

      expect(material.id).toBe('mat_custom');
      expect(material.textChars).toBe(0);
      expect(material.title).toBeNull();
      expect(material.textAssetId).toBeNull();
      expect(material.rawAssetId).toBeNull();
    });

    test('scopes reads by session: foreign and nonexistent ids read as absent', async () => {
      const store = makeStore();
      await store.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
      await store.createSession({ id: 'session-2', ownerId: 'owner-a', prompt: 'p' });

      const material = await store.createMaterial('session-1', {
        kind: 'web',
        sourceUrl: 'https://example.com/a',
      });

      await expect(store.getMaterial('session-2', material.id)).resolves.toBeNull();
      await expect(store.getMaterial('session-1', 'mat_missing')).resolves.toBeNull();
      // The same id cannot be re-created for another session.
      await expect(
        store.createMaterial('session-2', { id: material.id, kind: 'web' }),
      ).rejects.toThrow();
    });

    test('lists newest-first and pages with a keyset before cursor', async () => {
      const store = makeStore();
      await store.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });

      const first = await store.createMaterial('session-1', {
        kind: 'web',
        sourceUrl: 'https://example.com/1',
        title: 'one',
      });
      const second = await store.createMaterial('session-1', {
        kind: 'web',
        sourceUrl: 'https://example.com/2',
        title: 'two',
      });
      const third = await store.createMaterial('session-1', {
        kind: 'web',
        sourceUrl: 'https://example.com/3',
        title: 'three',
      });

      const all = await store.listMaterials('session-1');
      expect(all.map((material) => material.id)).toEqual([third.id, second.id, first.id]);

      // Keyset paging: the newest page first, then strictly older rows.
      const pageOne = await store.listMaterials('session-1', { limit: 2 });
      expect(pageOne.map((material) => material.id)).toEqual([third.id, second.id]);
      const pageTwo = await store.listMaterials('session-1', {
        limit: 2,
        before: pageOne[1]!.id,
      });
      expect(pageTwo.map((material) => material.id)).toEqual([first.id]);

      // A stale cursor simply pages to an empty tail; it never errors.
      const empty = await store.listMaterials('session-1', { before: first.id });
      expect(empty).toEqual([]);

      // Sessions do not leak into each other's listings.
      await store.createSession({ id: 'session-2', ownerId: 'owner-a', prompt: 'p' });
      expect(await store.listMaterials('session-2')).toEqual([]);
    });

    test('enforces the kind vocabulary at the store boundary', async () => {
      const store = makeStore();
      await store.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });

      await expect(
        store.createMaterial('session-1', { kind: 'unknown' as never }),
      ).rejects.toMatchObject({ name: 'AgentSessionMaterialError', code: 'invalid_input' });
    });

    test('fails closed when the session does not exist', async () => {
      const store = makeStore();
      await expect(store.createMaterial('session-missing', { kind: 'web' })).rejects.toMatchObject({
        name: 'AgentSessionMaterialError',
        code: 'session_missing',
      });
    });
  });
}
