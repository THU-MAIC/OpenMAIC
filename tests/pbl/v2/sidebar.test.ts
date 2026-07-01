import { describe, expect, it } from 'vitest';

import { sidebarDefaultExpandedMilestoneIds } from '@/components/scene-renderers/pbl/v2/sidebar';
import type { PBLMilestone, PBLProjectV2 } from '@/lib/pbl/v2/types';

function milestone(id: string, status: PBLMilestone['status'], order: number): PBLMilestone {
  return {
    id,
    title: id,
    status,
    order,
    documents: [],
    microtasks: [],
  };
}

function project(milestones: PBLMilestone[], status: PBLProjectV2['status']): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 'Project',
    description: 'Build something',
    proficiency: 'beginner',
    language: 'zh-CN',
    tags: [],
    status,
    roles: [],
    milestones,
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
  };
}

describe('PBL v2 sidebar roadmap expansion', () => {
  it('defaults to the active milestone while the project is in progress', () => {
    const p = project(
      [
        milestone('ms-1', 'completed', 0),
        milestone('ms-2', 'active', 1),
        milestone('ms-3', 'locked', 2),
      ],
      'active',
    );

    expect(sidebarDefaultExpandedMilestoneIds(p)).toEqual(['ms-2']);
  });

  it('defaults to all milestones expanded after the project completes', () => {
    const p = project(
      [
        milestone('ms-1', 'completed', 0),
        milestone('ms-2', 'completed', 1),
        milestone('ms-3', 'completed', 2),
      ],
      'completed',
    );

    expect(sidebarDefaultExpandedMilestoneIds(p)).toEqual(['ms-1', 'ms-2', 'ms-3']);
  });
});
