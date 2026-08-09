import { beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene } from '@/lib/document-store/validators';
import { hasPBLProjectV2Containers, isRunnablePBLProjectV2 } from '@/lib/pbl/v2/types';
import type { GeneratedPBLContent, SceneOutline } from '@/lib/types/generation';
import type { AppScene } from '@/lib/types/stage';

const generatePBLV2ProjectSingleCallMock = vi.hoisted(() => vi.fn());
const generatePBLV2ProjectMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/pbl/v2/agents/planner-single-call', () => ({
  generatePBLV2ProjectSingleCall: generatePBLV2ProjectSingleCallMock,
}));

vi.mock('@/lib/pbl/v2/agents/planner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pbl/v2/agents/planner')>()),
  generatePBLV2Project: generatePBLV2ProjectMock,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => loggerMock,
}));

function pblOutline(): SceneOutline {
  return {
    id: 'scene-pbl-1',
    type: 'pbl',
    title: 'CSV Data Analyzer',
    description: 'Build a small CSV analysis project.',
    keyPoints: ['CSV', 'summary'],
    order: 1,
    pblConfig: {
      projectTopic: 'CSV Data Analyzer',
      projectDescription: 'Build a small CSV analysis project.',
      targetSkills: ['CSV parsing', 'summary writing'],
      issueCount: 2,
    },
  };
}

function scenarioPblOutline(): SceneOutline {
  const outline = pblOutline();
  return {
    ...outline,
    title: 'Difficult feedback conversation',
    description: 'Practice giving feedback to a teammate.',
    pblConfig: {
      ...outline.pblConfig!,
      projectTopic: 'Difficult feedback conversation',
      projectDescription: 'Practice giving feedback to a teammate.',
      targetSkills: ['active listening', 'clear feedback'],
      scenarioRoleplay: true,
      scenarioBrief: 'The learner gives feedback to a teammate after a missed deadline.',
    },
  };
}

function mockModel() {
  return { provider: 'test', modelId: 'test-model' } as never;
}

async function plannerError(message: string) {
  const { PlannerV2Error } = await import('@/lib/pbl/v2/agents/planner-core');
  return new PlannerV2Error(message, {} as never);
}

function expectPersistablePBLContent(content: GeneratedPBLContent | null): void {
  expect(content).not.toBeNull();
  if (!content) throw new Error('expected generated PBL content');

  expect(hasPBLProjectV2Containers(content.projectV2)).toBe(true);
  expect(isRunnablePBLProjectV2(content.projectV2)).toBe(true);
  const scene = {
    id: 'scene-pbl-1',
    stageId: 'stage-1',
    title: 'CSV Data Analyzer',
    order: 0,
    type: 'pbl',
    content: { type: 'pbl', ...content },
  } as AppScene;
  expect(validateAppScene(scene)).toEqual({ valid: true });
}

describe('generateSceneContent — PBL v2 planner routing', () => {
  beforeEach(() => {
    vi.resetModules();
    generatePBLV2ProjectSingleCallMock.mockReset();
    generatePBLV2ProjectMock.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.error.mockReset();
    loggerMock.debug.mockReset();
  });

  it('always tries single-call first and returns only projectV2', async () => {
    const projectV2 = {
      title: 'CSV Data Analyzer project',
      milestones: [{ microtasks: [{ id: 'task_1', title: 'Inspect the CSV' }] }],
      roles: [{ id: 'role_1', type: 'instructor', name: 'Instructor' }],
      submissions: [],
      evaluations: [],
      threads: [{ messages: [] }],
      engagementEvents: [],
    };
    generatePBLV2ProjectSingleCallMock.mockResolvedValue(projectV2);

    const { generateSceneContent } = await import('@/lib/generation/scene-generator');
    const content = (await generateSceneContent(pblOutline(), vi.fn(), {
      languageModel: mockModel(),
      languageDirective: 'Reply in English.',
    })) as GeneratedPBLContent | null;

    expect(generatePBLV2ProjectSingleCallMock).toHaveBeenCalledTimes(1);
    expect(generatePBLV2ProjectSingleCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        courseContext: expect.objectContaining({ languageDirective: 'Reply in English.' }),
      }),
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({ onProgress: expect.any(Function) }),
      undefined,
    );
    expect(generatePBLV2ProjectMock).not.toHaveBeenCalled();
    expect(content).toEqual({ projectV2 });
    expect(content).not.toHaveProperty('projectConfig');
    expectPersistablePBLContent(content);
  });

  it('falls back to the loop when single-call validation fails', async () => {
    const projectV2 = {
      title: 'CSV Data Analyzer project',
      milestones: [
        { microtasks: [{ id: 'task_1', title: 'Inspect the CSV' }] },
        { microtasks: [{ id: 'task_2', title: 'Summarize the data' }] },
      ],
      roles: [{ id: 'role_1', type: 'instructor', name: 'Instructor' }],
      submissions: [],
      evaluations: [],
      threads: [{ messages: [] }],
      engagementEvents: [],
    };
    generatePBLV2ProjectSingleCallMock.mockRejectedValueOnce(
      await plannerError('single-call failed'),
    );
    generatePBLV2ProjectMock.mockResolvedValue(projectV2);

    const { generateSceneContent } = await import('@/lib/generation/scene-generator');
    const content = (await generateSceneContent(pblOutline(), vi.fn(), {
      languageModel: mockModel(),
    })) as GeneratedPBLContent | null;
    expect(content).toEqual({ projectV2 });
    expectPersistablePBLContent(content);
    expect(generatePBLV2ProjectSingleCallMock).toHaveBeenCalledTimes(1);
    expect(generatePBLV2ProjectMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error for ordinary PBL when both v2 attempts fail', async () => {
    generatePBLV2ProjectSingleCallMock.mockRejectedValueOnce(
      await plannerError('single-call failed'),
    );
    generatePBLV2ProjectMock.mockRejectedValueOnce(new Error('loop failed'));

    const { generateSceneContent, PBLGenerationError } =
      await import('@/lib/generation/scene-generator');
    await expect(
      generateSceneContent(pblOutline(), vi.fn(), { languageModel: mockModel() }),
    ).rejects.toBeInstanceOf(PBLGenerationError);
    expect(generatePBLV2ProjectSingleCallMock).toHaveBeenCalledTimes(1);
    expect(generatePBLV2ProjectMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the last planner failure as cause and exposes its HTTP status', async () => {
    const firstError = await plannerError('single-call validation failed');
    const lastError = Object.assign(new Error('loop rate limited'), { status: 429 });
    generatePBLV2ProjectSingleCallMock.mockRejectedValueOnce(firstError);
    generatePBLV2ProjectMock.mockRejectedValueOnce(lastError);

    const { generateSceneContent, PBLGenerationError } =
      await import('@/lib/generation/scene-generator');

    try {
      await generateSceneContent(pblOutline(), vi.fn(), { languageModel: mockModel() });
      throw new Error('expected PBL generation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PBLGenerationError);
      expect(error).toMatchObject({
        message: 'PBL v2 generation failed for "CSV Data Analyzer" after all planner attempts.',
        statusCode: 429,
        cause: lastError,
      });
    }
  });

  it('parses a numeric-string provider status and skips the loop fallback', async () => {
    const firstError = Object.assign(new Error('single-call rate limited'), {
      statusCode: '429',
    });
    generatePBLV2ProjectSingleCallMock.mockRejectedValueOnce(firstError);

    const { generateSceneContent, PBLGenerationError } =
      await import('@/lib/generation/scene-generator');

    try {
      await generateSceneContent(pblOutline(), vi.fn(), { languageModel: mockModel() });
      throw new Error('expected PBL generation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PBLGenerationError);
      expect(error).toMatchObject({ statusCode: 429, cause: firstError });
    }
    expect(generatePBLV2ProjectMock).not.toHaveBeenCalled();
  });

  it('continues to refuse degradation when scenario PBL v2 generation fails', async () => {
    const firstError = await plannerError('single-call validation failed');
    const lastError = Object.assign(new Error('loop rate limited'), { status: 429 });
    generatePBLV2ProjectSingleCallMock.mockRejectedValueOnce(firstError);
    generatePBLV2ProjectMock.mockRejectedValueOnce(lastError);

    const { generateSceneContent, PBLGenerationError } =
      await import('@/lib/generation/scene-generator');

    try {
      await generateSceneContent(scenarioPblOutline(), vi.fn(), { languageModel: mockModel() });
      throw new Error('expected scenario PBL generation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PBLGenerationError);
      expect(error).toMatchObject({
        message:
          'PBL v2 scenario generation failed for "Difficult feedback conversation" after all planner attempts.',
        statusCode: 429,
        cause: lastError,
      });
    }
    expect(generatePBLV2ProjectSingleCallMock).toHaveBeenCalledTimes(1);
    expect(generatePBLV2ProjectMock).toHaveBeenCalledTimes(1);
  });

  it('does not run the loop planner after a single-call provider failure', async () => {
    const unauthorized = Object.assign(new Error('provider key rejected'), { statusCode: 401 });
    generatePBLV2ProjectSingleCallMock.mockRejectedValueOnce(unauthorized);

    const { generateSceneContent, PBLGenerationError } =
      await import('@/lib/generation/scene-generator');

    try {
      await generateSceneContent(pblOutline(), vi.fn(), { languageModel: mockModel() });
      throw new Error('expected PBL generation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PBLGenerationError);
      expect(error).toMatchObject({ statusCode: 401, cause: unauthorized });
    }
    expect(generatePBLV2ProjectSingleCallMock).toHaveBeenCalledTimes(1);
    expect(generatePBLV2ProjectMock).not.toHaveBeenCalled();
  });

  it('falls back to the loop planner after an unexpected runtime error', async () => {
    const projectV2 = {
      title: 'Recovered project',
      roles: [{ id: 'role-i', type: 'instructor', name: 'Instructor' }],
      milestones: [{ id: 'ms-1', microtasks: [{ id: 'mt-1', title: 'Recovered task' }] }],
      submissions: [],
      evaluations: [],
      threads: [],
      engagementEvents: [],
    };
    generatePBLV2ProjectSingleCallMock.mockRejectedValueOnce(
      new TypeError('unexpected runtime failure'),
    );
    generatePBLV2ProjectMock.mockResolvedValueOnce(projectV2);

    const { generateSceneContent } = await import('@/lib/generation/scene-generator');
    await expect(
      generateSceneContent(pblOutline(), vi.fn(), { languageModel: mockModel() }),
    ).resolves.toEqual({ projectV2 });
    expect(generatePBLV2ProjectSingleCallMock).toHaveBeenCalledTimes(1);
    expect(generatePBLV2ProjectMock).toHaveBeenCalledTimes(1);
  });

  it('does not run the loop planner after cancellation', async () => {
    const aborted = new DOMException('The operation was aborted', 'AbortError');
    generatePBLV2ProjectSingleCallMock.mockRejectedValueOnce(aborted);

    const { generateSceneContent, PBLGenerationError } =
      await import('@/lib/generation/scene-generator');

    await expect(
      generateSceneContent(pblOutline(), vi.fn(), { languageModel: mockModel() }),
    ).rejects.toMatchObject({ name: PBLGenerationError.name, cause: aborted });
    expect(generatePBLV2ProjectSingleCallMock).toHaveBeenCalledTimes(1);
    expect(generatePBLV2ProjectMock).not.toHaveBeenCalled();
  });
});
