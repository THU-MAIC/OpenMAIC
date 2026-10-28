import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { completedProjectFiles } from '@/lib/server/pbl-v3/completed-files';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import type { Queryable } from '@openmaic/storage/document/pg';

it('only exposes public source from a committed final snapshot and leaves unfinished work live', async () => {
  const project = installedProject({ id: 'greeting-python', version: '1.0.0' });
  const row = { id: 'owner-scoped-study', state: startOrchestration(project.definition).state };
  const query = vi
    .fn()
    .mockResolvedValue({
      rows: [
        {
          files: {
            'PLAN.md': 'Reviewed plan',
            'src/greeting.py': 'Reviewed code',
            'rubric/answers.md': 'PRIVATE',
            '../secrets': 'PRIVATE',
          },
        },
      ],
    });
  const db = { query } as unknown as Queryable;
  expect(await completedProjectFiles(db, row, project)).toBeNull();
  expect(query).not.toHaveBeenCalled();
  row.state.status = 'completed';
  expect(await completedProjectFiles(db, row, project)).toEqual({
    'PLAN.md': 'Reviewed plan',
    'src/greeting.py': 'Reviewed code',
  });
  expect(query.mock.calls[0]?.[1]).toEqual([row.id]);
  query.mockResolvedValue({ rows: [] });
  expect(await completedProjectFiles(db, row, project)).toBeNull();
});
