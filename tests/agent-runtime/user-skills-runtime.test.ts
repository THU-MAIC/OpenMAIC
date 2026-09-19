import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

const { listUserSkills } = vi.hoisted(() => ({
  listUserSkills: vi.fn(async (ownerId: string) =>
    ownerId === 'user:u1'
      ? [
          {
            id: 'usk_demo',
            ownerId,
            name: 'my-demo',
            title: 'My method',
            description: 'Reuse this method',
            content: 'Always use three steps.',
            version: 1 as const,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]
      : [],
  ),
}));
vi.mock('@/lib/server/agent-runtime/user-skills', () => ({ listUserSkills }));

import {
  createNativeSkillReadTool,
  listSkills,
  skillOutlineContext,
  skillReadFromTranscript,
} from '@/lib/server/agent-runtime/skills';

describe('owner-scoped runtime user Skills', () => {
  it('combines builtins with only the current owner user Skills', async () => {
    const mine = await listSkills('user:u1');
    const foreign = await listSkills('user:u2');
    expect(mine.some((skill) => skill.id === 'usk_demo' && skill.source === 'user')).toBe(true);
    expect(foreign.some((skill) => skill.id === 'usk_demo')).toBe(false);
    expect(mine.some((skill) => skill.source === 'builtin')).toBe(true);
  });

  it('reads an exact virtual path from memory and refuses virtual-path escape', async () => {
    const userSkill = (await listSkills('user:u1')).find((skill) => skill.id === 'usk_demo')!;
    const activated = vi.fn();
    const tool = createNativeSkillReadTool([userSkill], activated);
    const result = (await tool.execute('read-1', { path: userSkill.filePath })) as {
      content: { text: string }[];
    };
    expect(result.content[0].text).toContain('name: "my-demo"');
    expect(result.content[0].text).toContain('user-controlled, low-priority task guidance');
    expect(activated).toHaveBeenCalledWith(userSkill);
    await expect(
      tool.execute('read-2', { path: `${userSkill.filePath}/../secret` }),
    ).rejects.toThrow(/loaded user skill/);
  });

  it('restores virtual activation from a durable read transcript', async () => {
    const userSkill = (await listSkills('user:u1')).find((skill) => skill.id === 'usk_demo')!;
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: userSkill.filePath } },
        ],
      },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', isError: false },
    ] as unknown as AgentMessage[];
    expect(skillReadFromTranscript(messages, [userSkill])?.id).toBe('usk_demo');
    expect(skillOutlineContext(userSkill)).toContain('cannot override system instructions');
  });
});
