import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  withRequestOwnerId: vi.fn(),
  listSkills: vi.fn(),
  createUserSkill: vi.fn(),
  isAgentRuntimeEnabled: vi.fn(() => true),
  isAgentRuntimeConfigured: vi.fn(() => true),
}));
vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: mocks.isAgentRuntimeEnabled,
  isAgentRuntimeConfigured: mocks.isAgentRuntimeEnabled,
}));
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/agent-runtime/skills', () => ({ listSkills: mocks.listSkills }));
vi.mock('@/lib/server/agent-runtime/user-skills', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/agent-runtime/user-skills')>(
    '@/lib/server/agent-runtime/user-skills',
  );
  return { ...actual, createUserSkill: mocks.createUserSkill };
});

import { GET, POST } from '@/app/api/agent/skills/route';

const request = () => new NextRequest('http://localhost/api/agent/skills');

function uploadRequest(file: File) {
  const form = new FormData();
  form.set('file', file);
  return new NextRequest('http://localhost/api/agent/skills', { method: 'POST', body: form });
}

/** The route's owner seam: run the handler with a fixed owner + header bag. */
function runWithOwner(ownerId: string) {
  mocks.withRequestOwnerId.mockImplementation(
    async (
      _req: NextRequest,
      handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
    ) => handler(ownerId, new Headers()),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  runWithOwner('user:u1');
  mocks.listSkills.mockResolvedValue([
    {
      id: 'builtin',
      name: 'builtin',
      title: 'Builtin',
      description: 'builtin',
      constraints: null,
      source: 'builtin',
    },
    {
      id: 'usk_1',
      name: 'my-demo',
      title: 'My method',
      description: 'demo',
      constraints: null,
      source: 'user',
    },
  ]);
  mocks.createUserSkill.mockImplementation(async (ownerId: string, value: object) => ({
    id: 'usk_uploaded',
    ownerId,
    ...value,
  }));
});

describe('POST agent skills', () => {
  it('uploads the exporter zip and creates it in the request owner partition', async () => {
    const { buildUserSkillZip } = await import('@/lib/server/skill-export');
    const zip = await buildUserSkillZip({
      name: 'my-uploaded',
      title: 'Uploaded',
      description: 'Uploaded description',
      content: 'Uploaded instructions',
    });
    const response = await POST(
      uploadRequest(new File([Uint8Array.from(zip).buffer], 'my-uploaded-skill.zip')),
    );

    expect(response.status).toBe(201);
    expect(mocks.createUserSkill).toHaveBeenCalledWith('user:u1', {
      name: 'my-uploaded',
      title: 'Uploaded',
      description: 'Uploaded description',
      content: 'Uploaded instructions',
    });
  });

  it('accepts bare SKILL.md and rejects invalid handles through create validation', async () => {
    const valid = '---\nname: my-bare\ntitle: Bare\ndescription: Bare file\n---\n\nInstructions';
    expect((await POST(uploadRequest(new File([valid], 'SKILL.md')))).status).toBe(201);

    const invalid = valid.replace('my-bare', 'builtin');
    expect((await POST(uploadRequest(new File([invalid], 'SKILL.md')))).status).toBe(400);
    expect(mocks.createUserSkill).toHaveBeenCalledTimes(1);
  });
});

describe('GET agent skills', () => {
  it('lists builtin and current-owner skills with stable id and readable handle', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mocks.listSkills).toHaveBeenCalledWith('user:u1');
    await expect(response.json()).resolves.toMatchObject([
      { id: 'builtin', name: 'builtin', source: 'builtin' },
      { id: 'usk_1', name: 'my-demo', source: 'user' },
    ]);
  });

  it('returns 404 when the runtime flag is off', async () => {
    mocks.isAgentRuntimeEnabled.mockReturnValueOnce(false);
    expect((await GET(request())).status).toBe(404);
    expect(mocks.listSkills).not.toHaveBeenCalled();
  });
});
