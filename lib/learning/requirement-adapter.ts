import type { ConceptLearningTaskInput, LearningTask } from './types';
import { normalizeConceptLearningTaskInput } from './task-template';

type RequirementSource = ConceptLearningTaskInput | LearningTask;

export function buildConceptLearningRequirement(
  source: RequirementSource,
  locale = 'zh-CN',
): string {
  const input = normalizeConceptLearningTaskInput(source);
  const priorKnowledge =
    input.priorKnowledge || (locale === 'zh-CN' ? '未特别说明' : 'Not specified');

  if (locale !== 'zh-CN') {
    return [
      `Create a focused learning course for ${input.courseName}.`,
      `Core concept: ${input.knowledgePoint}.`,
      `Learning goal: ${input.learningGoal}.`,
      `Prior knowledge: ${priorKnowledge}.`,
      'Build a clear path from intuitive explanation to key principles, worked examples, interaction, and a short knowledge check.',
      'Keep every scene focused on this learning goal and end with a concise review checklist.',
    ].join('\n');
  }

  return [
    `请为《${input.courseName}》创建一门聚焦式学习课程。`,
    `核心知识点：${input.knowledgePoint}。`,
    `本次学习目标：${input.learningGoal}。`,
    `学习者已有基础：${priorKnowledge}。`,
    '课程路径应从直观解释进入关键原理，再通过示例、互动练习和简短测验帮助理解。',
    '所有场景围绕本次学习目标展开，并在结尾提供精炼的复习清单。',
  ].join('\n');
}
