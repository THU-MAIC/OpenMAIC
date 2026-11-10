import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { recoveredProgress } from '@/lib/server/pbl-v3/environment';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import type { Study } from '@/lib/server/pbl-v3/store';
import { createHash } from 'node:crypto';
const project = installedProject({ id: 'greeting-python', version: '1.0.0' });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const files = {
  'PLAN.md': 'Return a formatted greeting.',
  'greeting.py': 'def greet(name): return f"Hello, {name}!"',
};
const fingerprint = hash(
  JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
);
function row() {
  const state = startOrchestration(project.definition).state;
  state.position.stageIndex = 5;
  state.milestones[0]!.completedStageIndexes = [0, 1, 2, 3, 4];
  const collected = state.collected.greeting!;
  collected.plan = {
    id: 'plan',
    kind: 'plan',
    milestoneId: 'greeting',
    revision: 1,
    contentHash: hash(files['PLAN.md']),
    workspaceRevisionId: 'older-code',
  };
  collected.code = {
    id: 'code',
    kind: 'code',
    milestoneId: 'greeting',
    revision: 1,
    value: 'reviewed',
    workspaceRevisionId: fingerprint,
  };
  collected.tests = {
    id: 'test',
    status: 'passed',
    evaluator: 'sandbox-command',
    milestoneId: 'greeting',
    stageIndex: 4,
    revision: { id: fingerprint, provider: 'sandbox', createdAt: '' },
    decisionRecordIds: [],
    startedAt: '',
    completedAt: '',
  };
  collected.planReviewCompleted = collected.codeReviewCompleted = collected.recapCompleted = true;
  collected.quiz = { id: 'quiz', attempt: 1, passed: true, score: 1, total: 1, wrong: [] };
  return { state, evaluation: null } as Study;
}
describe('restored workspace evidence', () => {
  it('preserves matching plan content, reviewed code and tests despite the older plan workspace hash', () => {
    const original = row();
    const result = recoveredProgress(original, project, files);
    expect(result.reset).toBe(false);
    expect(result.state.collected.greeting?.tests?.status).toBe('passed');
    expect(result.state.collected.greeting?.planReviewCompleted).toBe(true);
    expect(original.state.collected.greeting?.plan?.workspaceRevisionId).toBe('older-code');
  });
  it.each([
    ['PLAN.md', 2],
    ['greeting.py', 3],
  ] as const)(
    'rewinds to the %s production stage instead of stranding a learner in the quiz',
    (path, stage) => {
      const result = recoveredProgress(row(), project, { ...files, [path]: 'old file' });
      expect(result.reset).toBe(true);
      expect(result.state.position.stageIndex).toBe(stage);
      expect(result.state.collected.greeting).toMatchObject({
        code: null,
        tests: null,
        quiz: null,
        recapCompleted: false,
      });
      expect(result.state.milestones[0]?.completedStageIndexes.every((i) => i < stage)).toBe(true);
      if (path === 'greeting.py')
        expect(result.state.collected.greeting?.planReviewCompleted).toBe(true);
    },
  );
  it('drops an interrupted evaluation without applying its old command to the new environment', () => {
    const original = row();
    original.evaluation = { id: 'old-command', fingerprint, stageKey: 'greeting:4', startedAt: '' };
    const result = recoveredProgress(original, project, files);
    expect(result.state.position.stageIndex).toBe(4);
    expect(result.state.collected.greeting?.tests).toBeNull();
  });
});

it('rewinds later milestones to the saved position and drops only their current gates', () => {
  const lab = installedProject({ id: 'greeting-python-lab', version: '1.1.0' });
  const state = startOrchestration(lab.definition).state;
  state.position = { milestoneIndex: 1, milestoneId: 'normalize', stageIndex: 3 };
  state.milestones[0]!.status = 'completed';
  state.milestones[1]!.status = 'active';
  state.collected.normalize!.codeReviewCompleted = true;
  const study = {
    state,
    evaluation: null,
    environment_recovery: {
      requestId: 'old',
      savedPosition: { revision: 2, milestoneIndex: 0, stageIndex: 3, fingerprint },
    },
  } as Study;
  const result = recoveredProgress(study, lab, files, 2);
  expect(result.reset).toBe(true);
  expect(result.state.position).toMatchObject({ milestoneIndex: 0, stageIndex: 3 });
  expect(result.state.collected.normalize!.codeReviewCompleted).toBe(false);
  expect(result.state.milestones[1]!.status).toBe('pending');
  expect(study.state.position.milestoneIndex).toBe(1);
});

it('keeps completed submission evidence when a restored application workspace has changed', () => {
  const original = row();
  original.state.status = 'completed';
  original.state.milestones[0]!.status = 'completed';
  const result = recoveredProgress(
    original,
    project,
    { ...files, 'greeting.py': 'runtime application changed a file' },
    0,
  );
  expect(result.reset).toBe(false);
  expect(result.state).toEqual(original.state);
  expect(result.state.collected.greeting?.tests?.status).toBe('passed');
});
