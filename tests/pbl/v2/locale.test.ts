import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { applyRequestLocaleToProject } from '@/lib/pbl/v2/api/locale';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

function project(language = 'en-US'): PBLProjectV2 {
  return {
    uiPhase: 'hero',
    title: 'Demo Project',
    description: 'Build a demo artefact.',
    learningObjective: 'Practice a skill.',
    proficiency: 'beginner',
    language,
    tags: [],
    status: 'active',
    roles: [],
    milestones: [],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
  };
}

describe('PBL v2 route locale sync', () => {
  it('uses x-user-locale as the authoritative route-time language', () => {
    const p = project('en-US');
    const req = new NextRequest('http://localhost/api/pbl/v2/open-task', {
      headers: { 'x-user-locale': 'zh-CN' },
    });

    applyRequestLocaleToProject(req, p);

    expect(p.language).toBe('zh-CN');
  });

  it('ignores unsupported locale headers', () => {
    const p = project('en-US');
    const req = new NextRequest('http://localhost/api/pbl/v2/open-task', {
      headers: { 'x-user-locale': 'xx-YY' },
    });

    applyRequestLocaleToProject(req, p);

    expect(p.language).toBe('en-US');
  });
});
