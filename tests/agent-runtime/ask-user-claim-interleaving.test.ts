import { PGlite } from '@electric-sql/pglite';
import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
} from '@openmaic/storage/agent-session/pg';
import { AGENT_SESSION_LIFECYCLE } from '@openmaic/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('ask_user claim-boundary interleavings', () => {
  let db: PGlite;
  let store: PgAgentSessionStore;
  let askAttempt: number;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    store = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
  });

  beforeEach(async () => {
    await db.query(
      'TRUNCATE agent_owner_session_events, agent_owner_session_event_counters, ' +
        'agent_session_entries, agent_session_events, agent_sessions CASCADE',
    );
    await store.createSession({
      id: 'session-ask',
      ownerId: 'owner-1',
      prompt: 'Build a lesson',
      stageId: 'stage-1',
    });
    const claim = await store.claimNextSession('ask-worker', 101, {
      leaseTtlMs: 10_000,
      maxAttempts: 3,
    });
    expect(claim).not.toBeNull();
    askAttempt = claim!.attempt;
    await store.appendRunEvent('session-ask', 'ask-worker', {
      ts: 2,
      attempt: askAttempt,
      type: AGENT_SESSION_LIFECYCLE.userQuestion,
      data: { question: 'Continue?' },
    });
  });

  async function finishAsk(): Promise<void> {
    await store.finishSession('session-ask', 'ask-worker', {
      status: 'succeeded',
      resetAttempt: true,
      expectedAttempt: askAttempt,
    });
  }

  afterAll(async () => {
    await db.close();
  });

  it('ask pending -> material attach -> no run starts', async () => {
    const posted = await store.postUserMessage('session-ask', {
      text: '',
      materials: [{ materialId: 'material-1', originalName: 'notes.pdf' }],
    });
    expect(posted.delivery).toBe('queued');
    await finishAsk();
    await store.requeueSession('session-ask');

    expect(await store.getSession('session-ask')).toMatchObject({ status: 'queued' });
    await expect(
      store.claimNextSession('material-worker', 102, {
        leaseTtlMs: 10_000,
        maxAttempts: 3,
      }),
    ).resolves.toBeNull();
  });

  it('ask pending -> answer -> one run resumes', async () => {
    const posted = await store.postUserMessage('session-ask', { text: 'Continue' });
    expect(posted.delivery).toBe('queued');
    await finishAsk();
    await store.requeueSession('session-ask');

    const claim = await store.claimNextSession('answer-worker', 102, {
      leaseTtlMs: 10_000,
      maxAttempts: 3,
    });
    expect(claim).toMatchObject({ id: 'session-ask', claimReason: 'queued' });
    await expect(
      store.claimNextSession('duplicate-worker', 103, {
        leaseTtlMs: 10_000,
        maxAttempts: 3,
      }),
    ).resolves.toBeNull();
  });

  it('ask pending -> plain user message -> the ask is superseded', async () => {
    await finishAsk();
    await store.postUserMessage('session-ask', { text: 'Ignore that; change the title.' });

    await expect(
      store.claimNextSession('supersede-worker', 102, {
        leaseTtlMs: 10_000,
        maxAttempts: 3,
      }),
    ).resolves.toMatchObject({ id: 'session-ask', claimReason: 'queued' });
  });
});
