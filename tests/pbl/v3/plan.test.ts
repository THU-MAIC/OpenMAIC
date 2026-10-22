import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { assertLearningPlan } from '@/lib/server/pbl-v3/plan';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import { digest } from '@/lib/server/pbl-v3/runtime';
import type { Study, LearningStore } from '@/lib/server/pbl-v3/store';
it('preserves a full approved plan even when report evidence is clipped', async () => {
  const project = installedProject({ id: 'greeting-python-lab', version: '1.0.0' });
  const state = startOrchestration(project.definition).state;
  state.introCompleted = true;
  state.position = { milestoneIndex: 1, milestoneId: 'normalize', stageIndex: 1 };
  const text = 'Earlier approved section\n'.repeat(1000);
  state.collected.greeting!.plan = {
    id: 'plan',
    kind: 'plan',
    milestoneId: 'greeting',
    revision: 1,
    workspaceRevisionId: 'files',
    contentHash: digest(text),
    contentLength: text.length,
  };
  const row = { state, project_id: project.ref.id, project_version: project.ref.version } as Study;
  const store = { pool: { query: vi.fn() } } as unknown as LearningStore;
  await expect(
    assertLearningPlan(store, row, text + '\nNew milestone', true),
  ).resolves.toBeUndefined();
  await expect(assertLearningPlan(store, row, text, true)).rejects.toThrow('append');
  await expect(
    assertLearningPlan(store, row, text.replace('Earlier', 'Changed') + '\nNew', true),
  ).rejects.toThrow('Preserve');
  expect(store.pool.query).not.toHaveBeenCalled();
});
