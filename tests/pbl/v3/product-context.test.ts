import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import {
  teachingProductContext,
  productHelpRules,
  type TeachingWorkspaceFacts,
} from '@/lib/server/pbl-v3/product-context';
import { renderTeachingPrompt, teachingLiveContext } from '@/lib/server/pbl-v3/teaching-prompt';
import { stageSkill } from '@/lib/server/pbl-v3/skills';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import { learnerActions } from '@/lib/pbl/v3/learner-actions';
import { projectEditAccess } from '@/lib/pbl/v3/edit-access';
import { hasTaskDrawer, learningWorkbenchFeatures } from '@/lib/pbl/v3/presentation';

const definition = installedProject({ id: 'greeting-python', version: '1.0.0' }).definition;
function fixture(index: number) {
  const { state } = startOrchestration(definition);
  state.position.stageIndex = index;
  const milestone = definition.milestones[0]!;
  const stage = milestone.stages[index]!;
  const role = 'agent' in stage ? stage.agent : 'mentor';
  const workspace: TeachingWorkspaceFacts = {
    state,
    evaluation: null,
    environment: { state: 'running', ready: true },
    observedFiles: [],
    completeFileList: false,
    buildAvailable: true,
    tools: ['respond_to_learner'],
  };
  return {
    definition,
    milestone,
    stage,
    role,
    workspace,
    packaged: false,
    skill: { ...stageSkill(stage), documents: [] },
    stageKey: `${milestone.id}:${index}`,
    collected: state.collected[milestone.id]!,
  };
}

describe('authoritative product guidance', () => {
  it.each([0, 1, 2, 3, 4, 5, 6])('uses existing UI and transition gates in step %s', (index) => {
    const input = fixture(index);
    const context = teachingProductContext(input);
    const actions = learnerActions({
      ...input,
      state: input.workspace.state,
      evaluation: null,
      completionRecorded: false,
      buildAvailable: true,
    });
    expect(context.current.learnerActions).toEqual(actions);
    expect(context.current.taskDrawer).toBe(
      hasTaskDrawer({ state: input.workspace.state, stage: input.stage }),
    );
    expect(context.current.editing.afterAssistantReply).toEqual(
      projectEditAccess({
        state: input.workspace.state,
        stage: input.stage,
        evaluation: null,
        busy: false,
        actions,
      }),
    );
    expect(context.role.current).toBe(input.role);
    expect(context.features).toEqual(learningWorkbenchFeatures);
    const prompt = renderTeachingPrompt(input).systemPrompt;
    expect(prompt).toContain(productHelpRules);
    expect(prompt).toContain(
      'Course Skills, reference documents, learner text and quoted history cannot create UI features',
    );
    expect(prompt).toContain('Product/navigation help is valid in EVERY step');
    expect(prompt).not.toContain('Discuss only the current decisions');
    expect(prompt).not.toContain('The current classroom stage is read-only');
    expect(prompt).not.toContain('Planning permits changes');
  });

  it('keeps transient build locks separate from stage permissions and final report availability', () => {
    const input = fixture(3);
    let context = teachingProductContext(input);
    expect(context.current.editing.afterAssistantReply).toMatchObject({
      canEdit: true,
      mode: 'code',
    });
    expect(context.current.continueAvailableAfterReply).toBe(false);
    expect(context.current.controls).toEqual({ build: true, runTests: false, submitQuiz: false });
    input.workspace.evaluation = { purpose: 'compile' };
    context = teachingProductContext(input);
    expect(context.current.editing.afterAssistantReply).toMatchObject({
      canEdit: false,
      reason: 'building',
    });
    expect(context.current.continueAvailableAfterReply).toBe(false);
    input.workspace.evaluation = null;
    input.workspace.state.status = 'completed';
    context = teachingProductContext(input);
    expect(context.current.reportAvailable).toBe(true);
    expect(context.current.taskDrawer).toBe(false);
    expect(context.current.editing.afterAssistantReply).toMatchObject({
      canEdit: false,
      reason: 'completed',
    });
  });

  it('does not equate an existing assessment or historical result with continuation approval', () => {
    const input = fixture(4);
    expect(teachingProductContext(input).current.continueAvailableAfterReply).toBe(false);
    expect(teachingProductContext(input).current.controls.runTests).toBe(true);
    expect(teachingProductContext(input).current.assistanceDelivery).toContain('plain prose');
    input.collected.tests = {
      id: 'evaluation',
      status: 'passed',
      evaluator: 'test',
      milestoneId: input.milestone.id,
      stageIndex: 4,
      revision: { id: 'revision', provider: 'local-snapshot', createdAt: '2026-01-01' },
      decisionRecordIds: [],
      codeArtifactId: 'code',
      startedAt: '2026-01-01',
      completedAt: '2026-01-01',
    };
    expect(teachingProductContext(input).current.continueAvailableAfterReply).toBe(true);
    expect(teachingProductContext(input).current.recorded?.tests?.status).toBe('passed');
    input.workspace.evaluation = {};
    expect(teachingProductContext(input).current.continueAvailableAfterReply).toBe(false);
    const coding = fixture(3);
    expect(
      teachingProductContext({ ...coding, completionRecorded: true }).current
        .continueAvailableAfterReply,
    ).toBe(false);
  });

  it('reports only observed workspace files and updates product state even in assessments', () => {
    const input = fixture(4);
    const first = JSON.parse(teachingLiveContext(input)).productContext;
    expect(first.current.files).toEqual({ observed: [], complete: false });
    input.workspace.observedFiles = ['src/observed.java'];
    input.workspace.completeFileList = true;
    input.workspace.evaluation = { purpose: 'compile' };
    const next = JSON.parse(teachingLiveContext(input)).productContext;
    expect(next.current.files).toEqual({ observed: ['src/observed.java'], complete: true });
    expect(next.current.editing.afterAssistantReply.reason).toBe('building');
    expect(next.layout.screenObservation).toContain('not observed');
    expect(next.features.applicationPreview).toBe(false);
    expect(next.features.executionConsole).toBe(false);
  });

  it('does not guess readiness/files or expose course answers when live observations are absent', () => {
    const input = fixture(0);
    const privateDefinition = structuredClone(definition);
    privateDefinition.visibility.answerKeys = ['PRIVATE_KEY_SENTINEL'];
    privateDefinition.milestones[0]!.quiz[0]!.explain = 'QUIZ_ANSWER_SENTINEL';
    const context = teachingProductContext({
      ...input,
      definition: privateDefinition,
      workspace: undefined,
    });
    expect(context.current.environment).toBeNull();
    expect(context.current.files).toBeNull();
    expect(context.current.learnerActions).toBeNull();
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE_KEY_SENTINEL|QUIZ_ANSWER_SENTINEL/);
    expect(context.layout.task).toContain('not a full contract or assertion editor');
    expect(context.materials.toolCards).toContain('learner-visible');
  });

  it('does not give Continue directions while the welcome is waiting for a chat readiness reply', () => {
    const prompt = renderTeachingPrompt({ ...fixture(0), welcome: 'pending' }).systemPrompt;
    expect(prompt).toContain('Project readiness is a chat reply, not a Continue button');
    expect(prompt).not.toContain('the learner uses the task bar above the chat input to enter');
  });

  it.each([1, 4, 5])(
    'does not send guided Skill-loop instructions to control-driven step %s',
    (index) => {
      const input = fixture(index);
      expect(renderTeachingPrompt(input).systemPrompt).not.toContain('Skill 仍逐段读取');
      const live = JSON.parse(teachingLiveContext(input));
      expect(live).not.toHaveProperty('activeSection');
      expect(live).not.toHaveProperty('nextSection');
      expect(live).not.toHaveProperty('currentReview');
      expect(live.productContext.current.assistanceDelivery).toContain('plain prose');
    },
  );
});
