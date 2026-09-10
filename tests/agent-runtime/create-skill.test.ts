import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createUserSkill } = vi.hoisted(() => ({ createUserSkill: vi.fn() }));
vi.mock('@/lib/server/agent-runtime/user-skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/agent-runtime/user-skills')>();
  return { ...actual, createUserSkill };
});

import { buildCreateSkillTool } from '@/lib/server/agent-runtime/create-skill';
import { UserSkillError } from '@/lib/server/agent-runtime/user-skills';

const params = {
  name: 'my-review-method',
  title: 'Review method',
  description: 'Turn a discussion into a reusable review procedure',
  instructions: 'First restate the goal, then list the evidence, then give the next step.',
};

beforeEach(() => {
  createUserSkill.mockReset();
});

describe('create_skill tool', () => {
  it('binds ownership outside model parameters and returns durable details', async () => {
    createUserSkill.mockResolvedValue({
      id: 'usk_abc',
      ownerId: 'user:u1',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      content: params.instructions,
      ...params,
    });
    const tool = buildCreateSkillTool('user:u1');
    expect(Object.keys((tool.parameters as { properties: object }).properties)).not.toContain(
      'ownerId',
    );
    const result = (await tool.execute('call-1', params)) as {
      details: Record<string, unknown>;
      isError?: boolean;
    };
    expect(createUserSkill).toHaveBeenCalledWith('user:u1', {
      name: params.name,
      title: params.title,
      description: params.description,
      content: params.instructions,
    });
    expect(result.isError).not.toBe(true);
    expect(result.details).toEqual({
      skillId: 'usk_abc',
      name: params.name,
      title: params.title,
      description: params.description,
      content: params.instructions,
      source: 'user',
    });
  });

  it('returns readable duplicate and quota errors without throwing', async () => {
    const tool = buildCreateSkillTool('user:u1');
    for (const [code, message] of [
      ['duplicate', 'will not be overwritten'],
      ['quota', 'at most 50'],
    ] as const) {
      createUserSkill.mockRejectedValueOnce(new UserSkillError(message, code));
      const result = (await tool.execute(`call-${code}`, params)) as {
        details: Record<string, unknown>;
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBe(true);
      expect(result.details.error).toBe(code);
      expect(result.content[0].text).toBe(message);
    }
  });
});
