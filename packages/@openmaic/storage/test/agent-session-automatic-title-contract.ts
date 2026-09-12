import { describe, expect, test } from 'vitest';

import type {
  AgentSessionAutomaticTitleStore,
  AgentSessionTitleStore,
} from '../src/agent-session/types.js';
import type { AgentSessionContractStore } from './agent-session-contract.js';
import { makeAgentSessionInput } from './agent-session-contract.js';

type AutomaticTitleContractStore = AgentSessionContractStore &
  AgentSessionAutomaticTitleStore &
  AgentSessionTitleStore;

export function runAgentSessionAutomaticTitleContract(
  name: string,
  makeStore: () => AutomaticTitleContractStore,
  options: {
    genuineConcurrency: boolean;
    writeLegacyManualTitle: (
      sessionId: string,
      ownerId: string,
      title: string | null,
    ) => Promise<unknown>;
  },
): void {
  describe(`AgentSession automatic-title contract: ${name}`, () => {
    test('claims the immutable prompt for an ordinary session exactly once', async () => {
      const store = makeStore();
      await store.createSession(
        makeAgentSessionInput({ prompt: '  Original user prompt  ', titleState: 'pending' }),
      );

      await expect(store.claimAutomaticSessionTitle('session-1', 'owner-a')).resolves.toBe(
        '  Original user prompt  ',
      );
      await expect(store.claimAutomaticSessionTitle('session-1', 'owner-a')).resolves.toBeNull();
    });

    test('claims the first nonblank durable user message for an existing course', async () => {
      const store = makeStore();
      await store.createSession(
        makeAgentSessionInput({
          prompt: 'stage-1',
          existingCourse: true,
          titleState: 'pending',
        }),
      );
      await store.postUserMessage('session-1', {
        text: '   ',
        materials: [{ materialId: 'material-1' }],
      });
      await store.postUserMessage('session-1', { text: '  Explain the current lesson  ' });
      await store.postUserMessage('session-1', { text: 'Later question' });

      await expect(store.claimAutomaticSessionTitle('session-1', 'owner-a')).resolves.toBe(
        '  Explain the current lesson  ',
      );
    });

    test('skips all-whitespace durable messages when choosing existing-course input', async () => {
      const store = makeStore();
      await store.createSession(
        makeAgentSessionInput({
          prompt: 'stage-1',
          existingCourse: true,
          titleState: 'pending',
        }),
      );
      await store.postUserMessage('session-1', { text: '\t\n' });
      await store.postUserMessage('session-1', { text: 'Explain the current lesson' });

      await expect(store.claimAutomaticSessionTitle('session-1', 'owner-a')).resolves.toBe(
        'Explain the current lesson',
      );
    });

    test('keeps an attachment-only existing-course session pending for later text', async () => {
      const store = makeStore();
      await store.createSession(
        makeAgentSessionInput({
          prompt: 'stage-1',
          existingCourse: true,
          titleState: 'pending',
        }),
      );
      await store.postUserMessage('session-1', {
        text: '',
        materials: [{ materialId: 'material-1' }],
      });

      await expect(store.claimAutomaticSessionTitle('session-1', 'owner-a')).resolves.toBeNull();
      await store.postUserMessage('session-1', { text: 'Now explain this' });
      await expect(store.claimAutomaticSessionTitle('session-1', 'owner-a')).resolves.toBe(
        'Now explain this',
      );
    });

    test('leaves a claimed generation failure terminal without retry', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput({ titleState: 'pending' }));

      expect(await store.claimAutomaticSessionTitle('session-1', 'owner-a')).toBe(
        'Build a short course',
      );
      // No commit models a generator failure or process exit after the claim.
      await expect(store.claimAutomaticSessionTitle('session-1', 'owner-a')).resolves.toBeNull();
    });

    test('fences automatic claims by owner and deletion', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput({ titleState: 'pending' }));

      await expect(store.claimAutomaticSessionTitle('session-1', 'owner-b')).resolves.toBeNull();
      await store.softDeleteSession('session-1', 'owner-a');
      await expect(store.claimAutomaticSessionTitle('session-1', 'owner-a')).resolves.toBeNull();
    });

    test('commits an automatic title only once after a successful claim', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput({ titleState: 'pending' }));
      await store.claimAutomaticSessionTitle('session-1', 'owner-a');

      await expect(
        store.setAutomaticSessionTitle('session-1', 'owner-a', 'Generated title'),
      ).resolves.toMatchObject({ title: 'Generated title' });
      await expect(
        store.setAutomaticSessionTitle('session-1', 'owner-a', 'Late replacement'),
      ).resolves.toBeNull();
      await expect(store.getSession('session-1')).resolves.toMatchObject({
        title: 'Generated title',
      });
    });

    test('does not let an empty automatic title consume the one-shot commit', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput({ titleState: 'pending' }));
      await store.claimAutomaticSessionTitle('session-1', 'owner-a');

      await expect(store.setAutomaticSessionTitle('session-1', 'owner-a', '')).resolves.toBeNull();
      await expect(
        store.setAutomaticSessionTitle('session-1', 'owner-a', 'Generated title'),
      ).resolves.toMatchObject({ title: 'Generated title' });
    });

    test('fences automatic commits by owner', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput({ titleState: 'pending' }));
      await store.claimAutomaticSessionTitle('session-1', 'owner-a');
      await expect(
        store.setAutomaticSessionTitle('session-1', 'owner-b', 'Wrong owner'),
      ).resolves.toBeNull();
      expect(await store.getSession('session-1')).not.toHaveProperty('title');
    });

    test('fences automatic commits after deletion', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput({ titleState: 'pending' }));
      await store.claimAutomaticSessionTitle('session-1', 'owner-a');
      await store.softDeleteSession('session-1', 'owner-a');
      await expect(
        store.setAutomaticSessionTitle('session-1', 'owner-a', 'After deletion'),
      ).resolves.toBeNull();
    });

    test('manual title before claim prevents automatic generation', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput({ titleState: 'pending' }));
      await store.setManualSessionTitle('session-1', 'owner-a', 'Manual first');

      await expect(store.claimAutomaticSessionTitle('session-1', 'owner-a')).resolves.toBeNull();
      await expect(
        store.setAutomaticSessionTitle('session-1', 'owner-a', 'Generated late'),
      ).resolves.toBeNull();
      await expect(store.getSession('session-1')).resolves.toMatchObject({ title: 'Manual first' });
    });

    test('manual title during generation prevents the claimed automatic commit', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput({ titleState: 'pending' }));
      await store.claimAutomaticSessionTitle('session-1', 'owner-a');
      await store.setManualSessionTitle('session-1', 'owner-a', 'Manual during');

      await expect(
        store.setAutomaticSessionTitle('session-1', 'owner-a', 'Generated late'),
      ).resolves.toBeNull();
      await expect(store.getSession('session-1')).resolves.toMatchObject({
        title: 'Manual during',
      });
    });

    test('manual title after automatic generation remains authoritative', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput({ titleState: 'pending' }));
      await store.claimAutomaticSessionTitle('session-1', 'owner-a');
      await store.setAutomaticSessionTitle('session-1', 'owner-a', 'Generated first');

      await store.setManualSessionTitle('session-1', 'owner-a', 'Manual after');
      await expect(
        store.setAutomaticSessionTitle('session-1', 'owner-a', 'Generated again'),
      ).resolves.toBeNull();
      await expect(store.getSession('session-1')).resolves.toMatchObject({ title: 'Manual after' });
    });

    test('manual clear during generation prevents the claimed automatic commit', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput({ titleState: 'pending' }));
      await store.claimAutomaticSessionTitle('session-1', 'owner-a');
      await store.setManualSessionTitle('session-1', 'owner-a', null);

      await expect(
        store.setAutomaticSessionTitle('session-1', 'owner-a', 'Generated late'),
      ).resolves.toBeNull();
      expect(await store.getSession('session-1')).not.toHaveProperty('title');
    });

    test.each([
      ['clear before generation', null, 'before'],
      ['clear during generation', null, 'during'],
      ['rename before generation', 'Legacy title', 'before'],
      ['rename during generation', 'Legacy title', 'during'],
    ] as const)('does not overwrite a legacy manual %s', async (_case, legacyTitle, timing) => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput({ titleState: 'pending' }));

      if (timing === 'during') {
        await expect(store.claimAutomaticSessionTitle('session-1', 'owner-a')).resolves.toBe(
          'Build a short course',
        );
      }
      expect(await store.getSession('session-1')).not.toHaveProperty('title');

      // Pre-title-state processes write only the title and timestamp.
      await options.writeLegacyManualTitle('session-1', 'owner-a', legacyTitle);

      const expectLegacyTitle = async () => {
        const meta = await store.getSession('session-1');
        if (legacyTitle === null) expect(meta).not.toHaveProperty('title');
        else expect(meta).toMatchObject({ title: legacyTitle });
      };
      await expectLegacyTitle();

      await expect(store.claimAutomaticSessionTitle('session-1', 'owner-a')).resolves.toBeNull();
      await expect(
        store.setAutomaticSessionTitle('session-1', 'owner-a', 'Generated too late'),
      ).resolves.toBeNull();
      await expectLegacyTitle();
    });

    test.skipIf(!options.genuineConcurrency)(
      'allows exactly one simultaneous automatic-title claim',
      async () => {
        const store = makeStore();
        await store.createSession(makeAgentSessionInput({ titleState: 'pending' }));

        const claims = await Promise.all([
          store.claimAutomaticSessionTitle('session-1', 'owner-a'),
          store.claimAutomaticSessionTitle('session-1', 'owner-a'),
        ]);
        expect(claims.filter((claim) => claim !== null)).toEqual(['Build a short course']);
      },
    );
  });
}
