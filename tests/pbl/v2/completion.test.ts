import { describe, expect, it } from 'vitest';

import {
  buildCompletionReportViewModel,
  cleanCompletionIntro,
} from '@/components/scene-renderers/pbl/v2/completion';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

function makeProject(): PBLProjectV2 {
  return {
    uiPhase: 'completed',
    title: 'Project',
    description: 'Build something',
    proficiency: 'beginner',
    language: 'zh-CN',
    tags: [],
    status: 'completed',
    roles: [],
    milestones: [
      {
        id: 'ms-1',
        title: 'Stage 1',
        status: 'completed',
        order: 0,
        documents: [],
        microtasks: [
          {
            id: 'mt-1',
            title: 'Task 1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
          },
        ],
      },
    ],
    submissions: [],
    evaluations: [
      {
        id: 'eval-final-old',
        kind: 'final',
        feedback: 'older report',
        strengths: [],
        improvements: [],
        whatYouBuilt: ['旧成果'],
        whatYouLearned: ['旧收获'],
        whatsNext: '旧建议',
        stars: 3,
        createdAt: '2026-05-29T00:00:01.000Z',
      },
      {
        id: 'eval-final-new',
        kind: 'final',
        feedback:
          '你完成了门禁判断项目，也能用样例验证逻辑。{{NAME}} 在报告里不应该出现。\n\n```json\n{"stars":4.5,"what_you_built":["门禁判断程序","测试样例"],"what_you_learned":["if 条件判断","用样例验证逻辑"],"whats_next":"继续把判断逻辑封装成函数。"}\n```',
        strengths: [],
        improvements: [],
        whatYouBuilt: ['门禁判断程序', '测试样例'],
        whatYouLearned: ['if 条件判断', '用样例验证逻辑'],
        whatsNext: '继续把判断逻辑封装成函数。',
        stars: 4.5,
        createdAt: '2026-05-29T00:00:02.000Z',
      },
    ],
    threads: [],
    engagementEvents: [],
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:02.000Z',
  };
}

describe('PBL v2 completion report', () => {
  it('uses the latest final evaluation as the completion report data source', () => {
    const report = buildCompletionReportViewModel(makeProject());

    expect(report.finalEvaluation?.id).toBe('eval-final-new');
    expect(report.intro).toBe('你完成了门禁判断项目，也能用样例验证逻辑。 在报告里不应该出现。');
    expect(report.whatYouBuilt).toEqual(['门禁判断程序', '测试样例']);
    expect(report.whatYouLearned).toEqual(['if 条件判断', '用样例验证逻辑']);
    expect(report.whatsNext).toBe('继续把判断逻辑封装成函数。');
    expect(report.stars).toBe(4.5);
    expect(report.completedMicrotasks).toBe(1);
    expect(report.totalMicrotasks).toBe(1);
  });

  it('cleans template placeholders from the completion intro', () => {
    expect(cleanCompletionIntro('做得很好，{{NAME}}。\n\n{"stars":4}')).toBe('做得很好，。');
    expect(cleanCompletionIntro('{{NAME}}')).toBeUndefined();
  });
});
