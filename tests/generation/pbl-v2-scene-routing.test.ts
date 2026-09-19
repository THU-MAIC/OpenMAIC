import { describe, expect, it, vi } from 'vitest';
import { PBLGenerationError, generateSceneContent, type AICallFn } from '@openmaic/generation';
import { validateAppScene } from '@/lib/document-store/validators';
import { hasPBLProjectV2Containers, isRunnablePBLProjectV2 } from '@/lib/pbl/v2/types';
import type { GeneratedPBLContent, SceneOutline } from '@/lib/types/generation';
import type { AppScene } from '@/lib/types/stage';

function pblOutline(scenarioRoleplay = false): SceneOutline {
  return {
    id: 'scene-pbl-1',
    type: 'pbl',
    title: scenarioRoleplay ? 'Difficult feedback conversation' : 'CSV Data Analyzer',
    description: 'Build a small CSV analysis project.',
    keyPoints: ['CSV', 'summary'],
    order: 1,
    pblConfig: {
      projectTopic: scenarioRoleplay ? 'Difficult feedback conversation' : 'CSV Data Analyzer',
      projectDescription: 'Build a small CSV analysis project.',
      targetSkills: ['CSV parsing', 'summary writing'],
      issueCount: 2,
      scenarioRoleplay,
    },
  };
}

function validSingleCallResponse(): string {
  return JSON.stringify({
    projectInfo: {
      title: 'CSV Data Analyzer project',
      description: 'Analyze a CSV and report findings.',
      learningObjective: 'Practice end-to-end analysis.',
      gains: ['Inspect tabular data', 'Summarize evidence', 'Communicate a finding'],
      proficiency: 'beginner',
    },
    instructorRole: {
      name: 'Data Coach',
      description: 'I will guide your analysis.',
      systemPrompt: 'Coach the learner through evidence-based analysis.',
    },
    milestones: [
      {
        title: 'Inspect the CSV',
        description: 'Inspect columns and values.',
        briefing: 'Start with the data.',
        completionCriteria: 'The columns are understood.',
        debrief: 'The data is ready.',
        microtasks: [{ title: 'Inspect columns', description: 'List the columns.', hints: [] }],
      },
      {
        title: 'Report a finding',
        description: 'Write one supported finding.',
        briefing: 'Turn data into evidence.',
        completionCriteria: 'A supported finding is written.',
        debrief: 'The analysis is complete.',
        microtasks: [{ title: 'Write finding', description: 'Cite one value.', hints: [] }],
      },
    ],
  });
}

function fallbackProject() {
  return {
    title: 'Recovered project',
    description: 'Recovered by the app loop planner.',
    tags: [],
    language: 'en-US',
    proficiency: 'beginner' as const,
    status: 'active' as const,
    uiPhase: 'hero' as const,
    roles: [{ id: 'role-1', type: 'instructor' as const, name: 'Instructor' }],
    milestones: [{ id: 'ms-1', microtasks: [{ id: 'mt-1', title: 'Recovered task' }] }],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
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
  it('uses the package single-call path before the app loop fallback', async () => {
    const aiCall = vi.fn<AICallFn>().mockResolvedValue(validSingleCallResponse());
    const fallback = vi.fn();
    const content = (await generateSceneContent(pblOutline(), aiCall, {
      languageDirective: 'Reply in English.',
      pblLoopFallback: fallback,
    })) as GeneratedPBLContent | null;

    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(content).toMatchObject({ projectV2: { title: 'CSV Data Analyzer project' } });
    expectPersistablePBLContent(content);
  });

  it('runs the injected app loop after classified single-call validation failure', async () => {
    const fallback = vi.fn().mockResolvedValue(fallbackProject());
    const content = (await generateSceneContent(pblOutline(), async () => '{}', {
      pblLoopFallback: fallback,
    })) as GeneratedPBLContent | null;

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(content).toEqual({ projectV2: fallbackProject() });
    expectPersistablePBLContent(content);
  });

  it('preserves the loop planner failure as the terminal cause', async () => {
    const loopError = Object.assign(new Error('loop rate limited'), { status: 429 });
    await expect(
      generateSceneContent(pblOutline(), async () => '{}', {
        pblLoopFallback: vi.fn().mockRejectedValue(loopError),
      }),
    ).rejects.toMatchObject({
      name: PBLGenerationError.name,
      statusCode: 429,
      cause: loopError,
    });
  });

  it('skips the loop fallback after a provider failure', async () => {
    const fallback = vi.fn();
    const providerError = Object.assign(new Error('provider key rejected'), { statusCode: 401 });
    await expect(
      generateSceneContent(
        pblOutline(),
        async () => {
          throw providerError;
        },
        { pblLoopFallback: fallback },
      ),
    ).rejects.toMatchObject({
      name: PBLGenerationError.name,
      statusCode: 401,
      cause: providerError,
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('skips the loop fallback after cancellation', async () => {
    const fallback = vi.fn();
    const aborted = new DOMException('The operation was aborted', 'AbortError');
    await expect(
      generateSceneContent(
        pblOutline(),
        async () => {
          throw aborted;
        },
        { pblLoopFallback: fallback },
      ),
    ).rejects.toMatchObject({ name: PBLGenerationError.name, cause: aborted });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('keeps scenario failures on the no-degradation error path', async () => {
    await expect(
      generateSceneContent(pblOutline(true), async () => '{}', {
        pblLoopFallback: vi.fn().mockRejectedValue(new Error('loop failed')),
      }),
    ).rejects.toMatchObject({
      name: PBLGenerationError.name,
      message: expect.stringContaining('generation failed'),
    });
  });
});
