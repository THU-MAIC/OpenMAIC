import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GeneratedPBLContent, SceneOutline } from '@/lib/types/generation';

const generatePBLV2ProjectSingleCallMock = vi.hoisted(() => vi.fn());
const generatePBLV2ProjectMock = vi.hoisted(() => vi.fn());
const projectV2ToLegacyProjectConfigMock = vi.hoisted(() => vi.fn());
const generatePBLContentMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/pbl/v2/agents/planner-single-call', () => ({
  generatePBLV2ProjectSingleCall: generatePBLV2ProjectSingleCallMock,
}));

vi.mock('@/lib/pbl/v2/agents/planner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pbl/v2/agents/planner')>();
  return {
    ...actual,
    generatePBLV2Project: generatePBLV2ProjectMock,
  };
});

vi.mock('@/lib/pbl/v2/compat', () => ({
  projectV2ToLegacyProjectConfig: projectV2ToLegacyProjectConfigMock,
}));

vi.mock('@/lib/pbl/generate-pbl', () => ({
  generatePBLContent: generatePBLContentMock,
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

describe('generateSceneContent — PBL v2 planner routing', () => {
  const originalDisabled = process.env.PBL_V2_DISABLED;
  const originalSingleCall = process.env.PBL_V2_SINGLE_CALL;

  beforeEach(() => {
    vi.resetModules();
    generatePBLV2ProjectSingleCallMock.mockReset();
    generatePBLV2ProjectMock.mockReset();
    projectV2ToLegacyProjectConfigMock.mockReset();
    generatePBLContentMock.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.error.mockReset();
    loggerMock.debug.mockReset();
    delete process.env.PBL_V2_DISABLED;
    delete process.env.PBL_V2_SINGLE_CALL;
  });

  afterEach(() => {
    if (originalDisabled === undefined) {
      delete process.env.PBL_V2_DISABLED;
    } else {
      process.env.PBL_V2_DISABLED = originalDisabled;
    }
    if (originalSingleCall === undefined) {
      delete process.env.PBL_V2_SINGLE_CALL;
    } else {
      process.env.PBL_V2_SINGLE_CALL = originalSingleCall;
    }
  });

  it('always tries single-call first, even if the removed env flag is set to false', async () => {
    process.env.PBL_V2_SINGLE_CALL = 'false';

    const projectV2 = {
      title: 'CSV Data Analyzer project',
      milestones: [{ microtasks: [] }],
      roles: [{ id: 'role_1' }],
    };
    const legacyConfig = { agents: [], issueboard: { issues: [] } };

    generatePBLV2ProjectSingleCallMock.mockResolvedValue(projectV2);
    projectV2ToLegacyProjectConfigMock.mockReturnValue(legacyConfig);

    const { generateSceneContent } = await import('@/lib/generation/scene-generator');
    const content = (await generateSceneContent(pblOutline(), vi.fn(), {
      languageModel: mockModel(),
      languageDirective: 'Reply in English.',
    })) as GeneratedPBLContent | null;

    expect(generatePBLV2ProjectSingleCallMock).toHaveBeenCalledTimes(1);
    expect(generatePBLV2ProjectMock).not.toHaveBeenCalled();
    expect(generatePBLContentMock).not.toHaveBeenCalled();
    expect(projectV2ToLegacyProjectConfigMock).toHaveBeenCalledWith(projectV2);
    expect(content).toEqual({
      projectConfig: legacyConfig,
      projectV2,
    });
  });

  it('falls back to the loop when single-call validation fails', async () => {
    const projectV2 = {
      title: 'CSV Data Analyzer project',
      milestones: [{ microtasks: [] }, { microtasks: [] }],
      roles: [{ id: 'role_1' }],
    };
    const legacyConfig = { agents: [{ id: 'coach' }], issueboard: { issues: [{ id: 'ms-1' }] } };

    generatePBLV2ProjectSingleCallMock.mockRejectedValueOnce(new Error('single-call failed'));
    generatePBLV2ProjectMock.mockResolvedValue(projectV2);
    projectV2ToLegacyProjectConfigMock.mockReturnValue(legacyConfig);

    const { generateSceneContent } = await import('@/lib/generation/scene-generator');
    const content = (await generateSceneContent(pblOutline(), vi.fn(), {
      languageModel: mockModel(),
      languageDirective: 'Reply in English.',
    })) as GeneratedPBLContent | null;

    expect(generatePBLV2ProjectSingleCallMock).toHaveBeenCalledTimes(1);
    expect(generatePBLV2ProjectMock).toHaveBeenCalledTimes(1);
    expect(generatePBLContentMock).not.toHaveBeenCalled();
    expect(content).toEqual({
      projectConfig: legacyConfig,
      projectV2,
    });
  });

  it('falls back to legacy v1 for ordinary PBL when both v2 attempts fail', async () => {
    const legacyConfig = { agents: [{ id: 'coach' }], issueboard: { issues: [{ id: 'issue-1' }] } };

    generatePBLV2ProjectSingleCallMock.mockRejectedValueOnce(new Error('single-call failed'));
    generatePBLV2ProjectMock.mockRejectedValueOnce(new Error('loop failed'));
    generatePBLContentMock.mockResolvedValue(legacyConfig);

    const { generateSceneContent } = await import('@/lib/generation/scene-generator');
    const content = (await generateSceneContent(pblOutline(), vi.fn(), {
      languageModel: mockModel(),
      languageDirective: 'Reply in English.',
    })) as GeneratedPBLContent | null;

    expect(generatePBLV2ProjectSingleCallMock).toHaveBeenCalledTimes(1);
    expect(generatePBLV2ProjectMock).toHaveBeenCalledTimes(1);
    expect(generatePBLContentMock).toHaveBeenCalledTimes(1);
    expect(content).toEqual({ projectConfig: legacyConfig });
  });

  it('does not fall back to legacy v1 when scenario PBL v2 generation fails', async () => {
    generatePBLV2ProjectSingleCallMock.mockRejectedValueOnce(new Error('single-call failed'));
    generatePBLV2ProjectMock.mockRejectedValueOnce(new Error('loop failed'));
    generatePBLContentMock.mockResolvedValue({ agents: [], issueboard: { issues: [] } });

    const { generateSceneContent } = await import('@/lib/generation/scene-generator');
    const content = (await generateSceneContent(scenarioPblOutline(), vi.fn(), {
      languageModel: mockModel(),
      languageDirective: 'Reply in English.',
    })) as GeneratedPBLContent | null;

    expect(generatePBLV2ProjectSingleCallMock).toHaveBeenCalledTimes(1);
    expect(generatePBLV2ProjectMock).toHaveBeenCalledTimes(1);
    expect(generatePBLContentMock).not.toHaveBeenCalled();
    expect(content).toBeNull();
  });

  it('does not fall back to legacy v1 when scenario PBL is requested and v2 is disabled', async () => {
    process.env.PBL_V2_DISABLED = 'true';
    generatePBLContentMock.mockResolvedValue({ agents: [], issueboard: { issues: [] } });

    const { generateSceneContent } = await import('@/lib/generation/scene-generator');
    const content = (await generateSceneContent(scenarioPblOutline(), vi.fn(), {
      languageModel: mockModel(),
      languageDirective: 'Reply in English.',
    })) as GeneratedPBLContent | null;

    expect(generatePBLV2ProjectSingleCallMock).not.toHaveBeenCalled();
    expect(generatePBLV2ProjectMock).not.toHaveBeenCalled();
    expect(generatePBLContentMock).not.toHaveBeenCalled();
    expect(content).toBeNull();
  });
});
