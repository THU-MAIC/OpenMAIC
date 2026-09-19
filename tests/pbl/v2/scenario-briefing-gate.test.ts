/**
 * Guard tests for the scenario-briefing visibility gate.
 *
 * The right-column briefing tab is SCENARIO ONLY and must appear exactly when
 * the learner has ENTERED the scenario (prep completed) and stay visible for
 * the rest of the run — never for ordinary projects, never during prep. These
 * lock the five states that matter so the gate can't silently regress.
 */
import { describe, expect, it } from 'vitest';
import { shouldShowScenarioBriefing } from '@/components/scene-renderers/pbl/v2/scenario-briefing-gate';
import type { PBLMilestone, PBLProjectV2, PBLScenarioConfig } from '@/lib/pbl/v2/types';

const NOW = '2026-06-17T00:00:00.000Z';

function microtask(status: PBLMilestone['microtasks'][number]['status']) {
  return {
    id: 'mt',
    title: 't',
    description: 'd',
    status,
    assignee: 'user' as const,
    hints: [],
    order: 0,
  };
}

function milestone(
  id: string,
  order: number,
  status: PBLMilestone['status'],
  scenarioStage?: PBLMilestone['scenarioStage'],
): PBLMilestone {
  return {
    id,
    title: id,
    order,
    status,
    description: 'd',
    microtasks: [microtask(status === 'completed' ? 'completed' : 'in_progress')],
    documents: [],
    ...(scenarioStage ? { scenarioStage } : {}),
  };
}

const scenarioConfig: PBLScenarioConfig = {
  setting: 'A clinic',
  characters: [{ id: 'c1', name: '小明', persona: 'a kid', situation: 'has a cold' }],
};

function makeProject(args: {
  scenario?: PBLScenarioConfig;
  milestones: PBLMilestone[];
  status?: PBLProjectV2['status'];
}): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 'P',
    description: 'd',
    learningObjective: 'o',
    proficiency: 'beginner',
    language: 'zh-CN',
    tags: [],
    status: args.status ?? 'active',
    roles: [{ id: 'role-i', type: 'instructor', name: 'Instructor' }],
    milestones: args.milestones,
    submissions: [],
    evaluations: [],
    threads: [{ agentId: 'role-i', messages: [] }],
    engagementEvents: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...(args.scenario ? { scenario: args.scenario } : {}),
  };
}

describe('shouldShowScenarioBriefing — right-column briefing gate', () => {
  it('is FALSE for ordinary (non-scenario) projects, regardless of milestone state', () => {
    const project = makeProject({
      milestones: [milestone('ms-1', 0, 'completed'), milestone('ms-2', 1, 'active')],
    });
    expect(shouldShowScenarioBriefing(project)).toBe(false);
  });

  it('is FALSE for a scenario project still in prep (not yet entered)', () => {
    const project = makeProject({
      scenario: scenarioConfig,
      milestones: [
        milestone('prep', 0, 'active', 'prep'),
        milestone('rp', 1, 'locked', 'roleplay'),
        milestone('wrap', 2, 'locked', 'wrapup'),
      ],
    });
    expect(shouldShowScenarioBriefing(project)).toBe(false);
  });

  it('is TRUE once prep is completed and a roleplay stage is active (entered)', () => {
    const project = makeProject({
      scenario: scenarioConfig,
      milestones: [
        milestone('prep', 0, 'completed', 'prep'),
        milestone('rp', 1, 'active', 'roleplay'),
        milestone('wrap', 2, 'locked', 'wrapup'),
      ],
    });
    expect(shouldShowScenarioBriefing(project)).toBe(true);
  });

  it('stays TRUE during a stage handover gap (no active milestone)', () => {
    const project = makeProject({
      scenario: scenarioConfig,
      milestones: [
        milestone('prep', 0, 'completed', 'prep'),
        milestone('rp', 1, 'completed', 'roleplay'),
        milestone('wrap', 2, 'locked', 'wrapup'),
      ],
    });
    expect(shouldShowScenarioBriefing(project)).toBe(true);
  });

  it('stays TRUE on a fully completed project (e.g. returning from the completion page)', () => {
    const project = makeProject({
      scenario: scenarioConfig,
      status: 'completed',
      milestones: [
        milestone('prep', 0, 'completed', 'prep'),
        milestone('rp', 1, 'completed', 'roleplay'),
        milestone('wrap', 2, 'completed', 'wrapup'),
      ],
    });
    expect(shouldShowScenarioBriefing(project)).toBe(true);
  });
});
