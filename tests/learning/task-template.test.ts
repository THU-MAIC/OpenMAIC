import { describe, expect, it } from 'vitest';

import { buildConceptLearningRequirement } from '@/lib/learning/requirement-adapter';
import {
  createConceptLearningTask,
  validateConceptLearningTaskInput,
} from '@/lib/learning/task-template';

describe('concept learning task template', () => {
  it('normalizes input and creates a stable draft', () => {
    const task = createConceptLearningTask(
      {
        courseName: ' 高等数学 ',
        knowledgePoint: ' 极限 ',
        learningGoal: ' 理解极限的直观含义 ',
        priorKnowledge: ' 函数基础 ',
      },
      { id: 'task-1', now: 100 },
    );

    expect(task).toMatchObject({
      id: 'task-1',
      courseName: '高等数学',
      knowledgePoint: '极限',
      status: 'draft',
      createdAt: 100,
      updatedAt: 100,
      visitedSceneIds: [],
      reviewSceneIds: [],
      notes: {},
    });
  });

  it('reports required fields without requiring prior knowledge', () => {
    expect(
      validateConceptLearningTaskInput({
        courseName: '',
        knowledgePoint: ' ',
        learningGoal: '',
      }),
    ).toEqual({
      courseName: '请输入课程名称',
      knowledgePoint: '请输入要理解的知识点',
      learningGoal: '请输入本次学习目标',
    });
  });

  it('builds a focused generation requirement from task fields', () => {
    const requirement = buildConceptLearningRequirement({
      courseName: '数据结构',
      knowledgePoint: '二叉树遍历',
      learningGoal: '区分三种深度优先遍历',
      priorKnowledge: '了解递归',
    });

    expect(requirement).toContain('《数据结构》');
    expect(requirement).toContain('二叉树遍历');
    expect(requirement).toContain('区分三种深度优先遍历');
    expect(requirement).toContain('了解递归');
    expect(requirement).toContain('互动练习');
  });
});
