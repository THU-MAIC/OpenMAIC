import { AgentSessionAccessError } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  postUserMessage: vi.fn(),
  bindOwnerMaterialsToSession: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => true,
  isAgentRuntimeConfigured: () => true,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: (_request: NextRequest, headers: Headers) => {
    headers.append('Set-Cookie', 'anonymous_id=test; Path=/; HttpOnly');
    return 'owner-1';
  },
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({
    getSession: mocks.getSession,
    postUserMessage: mocks.postUserMessage,
  }),
}));
vi.mock('@/lib/server/agent-runtime/session-materials', () => ({
  SessionMaterialBindingError: class SessionMaterialBindingError extends Error {},
  bindOwnerMaterialsToSession: mocks.bindOwnerMaterialsToSession,
}));

import { POST } from '@/app/api/agent/sessions/[id]/messages/route';
import { MAX_SESSION_TEXT_LENGTH } from '@/lib/server/agent-runtime/limits';

function call(body: unknown) {
  const request = new NextRequest('http://localhost/api/agent/sessions/session-1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: 'session-1' }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-1', status: 'succeeded' });
  mocks.postUserMessage.mockResolvedValue({ seq: 4, delivery: 'queued', requeued: true });
  mocks.bindOwnerMaterialsToSession.mockResolvedValue([]);
});

describe('POST agent session message', () => {
  it('posts a trimmed message with an owner fence and returns its delivery', async () => {
    const response = await call({ text: ' Continue ' });

    expect(response.status).toBe(202);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
    expect(mocks.postUserMessage).toHaveBeenCalledWith(
      'session-1',
      { text: 'Continue' },
      { expectedOwnerId: 'owner-1' },
    );
    await expect(response.json()).resolves.toEqual({
      id: 'session-1',
      message: { seq: 4, text: 'Continue', delivery: 'queued' },
      elementRefsAccepted: false,
      courseRefsAccepted: false,
    });
  });

  it('persists course mentions and returns the capability receipt', async () => {
    const courseRef = {
      kind: 'course' as const,
      stageId: 'course-1',
      title: 'Physics',
    };

    const response = await call({ text: 'Update this course', courseRefs: [courseRef] });

    expect(response.status).toBe(202);
    expect(mocks.postUserMessage).toHaveBeenCalledWith(
      'session-1',
      { text: 'Update this course', courseRefs: [courseRef] },
      { expectedOwnerId: 'owner-1' },
    );
    await expect(response.json()).resolves.toMatchObject({ courseRefsAccepted: true });
  });

  it('binds uploaded materials before posting the message the agent reads', async () => {
    const material = {
      materialId: 'mat-1',
      originalName: 'notes.pdf',
      mime: 'application/pdf',
      bytes: 42,
    };
    mocks.bindOwnerMaterialsToSession.mockResolvedValue([material]);

    const response = await call({ text: '', materialIds: ['mat-1'] });

    expect(response.status).toBe(202);
    expect(mocks.bindOwnerMaterialsToSession).toHaveBeenCalledWith('session-1', 'owner-1', [
      'mat-1',
    ]);
    expect(mocks.postUserMessage).toHaveBeenCalledWith(
      'session-1',
      { text: '', materials: [material] },
      { expectedOwnerId: 'owner-1' },
    );
  });

  it('accepts a follow-up for a failed session', async () => {
    mocks.getSession.mockResolvedValue({
      id: 'session-1',
      ownerId: 'owner-1',
      status: 'failed',
      attempt: 6,
    });

    expect((await call({ text: 'Retry' })).status).toBe(202);
    expect(mocks.postUserMessage).toHaveBeenCalledOnce();
  });

  it('requires non-empty text', async () => {
    const response = await call({ text: ' ' });

    expect(response.status).toBe(400);
    expect(mocks.postUserMessage).not.toHaveBeenCalled();
  });

  it('rejects a message that exceeds the text length cap', async () => {
    const response = await call({ text: 'x'.repeat(MAX_SESSION_TEXT_LENGTH + 1) });

    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
    expect(mocks.postUserMessage).not.toHaveBeenCalled();
  });

  it('hides an absent or foreign session', async () => {
    mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-2' });

    const response = await call({ text: 'Continue' });
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
    expect(mocks.postUserMessage).not.toHaveBeenCalled();
  });

  it('keeps the minted owner cookie when the store fails', async () => {
    mocks.getSession.mockRejectedValue(new Error('database unavailable'));

    const response = await call({ text: 'Continue' });

    expect(response.status).toBe(500);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
  });

  it('maps a transactional ownership race to forbidden', async () => {
    mocks.postUserMessage.mockRejectedValue(new AgentSessionAccessError('session-1'));

    const response = await call({ text: 'Continue' });
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
  });
});
