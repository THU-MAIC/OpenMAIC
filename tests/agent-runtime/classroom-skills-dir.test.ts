import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

let root: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

it('discovers and reads classroom skills from the configured directory without changing authoring', async () => {
  root = mkdtempSync(join(tmpdir(), 'classroom-skills-'));
  const directory = join(root, 'test-classroom');
  mkdirSync(directory);
  const path = join(directory, 'SKILL.md');
  writeFileSync(
    path,
    '---\nname: test-classroom\ndescription: Local classroom guidance.\n---\n\n# Test guidance\nOnly in the configured directory.\n',
  );
  vi.stubEnv('OPENMAIC_CLASSROOM_SKILLS_DIR', root);
  vi.stubEnv('OPENMAIC_AGENT_SKILLS_DIR', join(root, 'authoring'));
  vi.resetModules();
  const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
  expect(agentRuntimeConfig.classroomSkillsDir).toBe(root);
  expect(agentRuntimeConfig.skillsDir).toBe(join(root, 'authoring'));
  const { listClassroomSkills, availableSkillsPromptBlock, createNativeSkillReadTool } =
    await import('@/lib/server/agent-runtime/skills');
  const skills = await listClassroomSkills();
  expect(skills.map((s) => s.name)).toEqual(['test-classroom']);
  expect(availableSkillsPromptBlock(skills)).not.toContain('Only in the configured directory.');
  const result = await createNativeSkillReadTool(skills, () => {}).execute('read', { path });
  expect(JSON.stringify(result.content)).toContain('Only in the configured directory.');
});

it('defaults to the existing classroom directory', async () => {
  vi.stubEnv('OPENMAIC_CLASSROOM_SKILLS_DIR', undefined);
  vi.resetModules();
  const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
  expect(agentRuntimeConfig.classroomSkillsDir).toBe(join(process.cwd(), 'skills/classroom'));
});
