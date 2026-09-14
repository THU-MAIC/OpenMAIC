import { describe, expect, it } from 'vitest';

import { buildLearningReview, learningReviewToMarkdown } from '@/lib/learning/review-builder';
import { createConceptLearningTask } from '@/lib/learning/task-template';
import type { Scene } from '@/lib/types/stage';

describe('learning review builder', () => {
  it('uses real scene activity and exports a useful markdown checklist', () => {
    const task = {
      ...createConceptLearningTask(
        { courseName: '高数', knowledgePoint: '极限', learningGoal: '解释极限' },
        { id: 'task', now: 1 },
      ),
      visitedSceneIds: ['s2'],
      reviewSceneIds: ['s1'],
      notes: { s2: { sceneId: 's2', content: '左右极限必须一致', updatedAt: 2 } },
    };
    const scenes = [
      { id: 's2', order: 2, title: '例题', type: 'slide', content: { type: 'slide' } },
      { id: 's1', order: 1, title: '直观理解', type: 'slide', content: { type: 'slide' } },
    ] as Scene[];

    const review = buildLearningReview(task, scenes, {
      courseTitle: '高等数学',
      quiz: { correct: 2, total: 3, pct: 67 },
    });
    expect(review.items.map((item) => item.sceneId)).toEqual(['s1', 's2']);
    expect(review.progressPercent).toBe(50);

    const markdown = learningReviewToMarkdown(review);
    expect(markdown).toContain('- [ ] 直观理解');
    expect(markdown).toContain('左右极限必须一致');
    expect(markdown).toContain('2/3（67%）');
  });

  it('retains notes for scenes removed from the linked classroom', () => {
    const task = {
      ...createConceptLearningTask(
        { courseName: '高数', knowledgePoint: '极限', learningGoal: '解释极限' },
        { id: 'task', now: 1 },
      ),
      reviewSceneIds: ['removed'],
      notes: {
        removed: { sceneId: 'removed', content: '仍需复习这部分', updatedAt: 2 },
      },
    };
    const review = buildLearningReview(task, []);
    expect(review.items[0]).toMatchObject({
      sceneId: 'removed',
      available: false,
      title: '已移除的课堂环节',
      note: '仍需复习这部分',
    });
  });
});
