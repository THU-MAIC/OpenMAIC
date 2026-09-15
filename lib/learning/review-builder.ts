import type { CompleteSummary } from '@/lib/classroom/complete-summary';
import type { LearningTask } from './types';
import type { Scene } from '@/lib/types/stage';

export interface LearningReviewItem {
  sceneId: string;
  order: number;
  title: string;
  available: boolean;
  visited: boolean;
  markedForReview: boolean;
  note?: string;
}

export interface LearningReviewQueueItem extends LearningReviewItem {
  priority: 'high' | 'medium' | 'reference';
  reason: 'marked-and-noted' | 'marked' | 'noted';
}

export interface LearningReview {
  task: LearningTask;
  courseTitle: string;
  items: LearningReviewItem[];
  reviewQueue: LearningReviewQueueItem[];
  sceneCount: number;
  visitedCount: number;
  progressPercent: number;
  quiz: CompleteSummary['quiz'];
}

export function buildReviewQueue(items: LearningReviewItem[]): LearningReviewQueueItem[] {
  const rank = { high: 0, medium: 1, reference: 2 } as const;
  return items
    .filter((item) => item.markedForReview || item.note)
    .map((item): LearningReviewQueueItem => {
      if (item.markedForReview && item.note) {
        return { ...item, priority: 'high', reason: 'marked-and-noted' };
      }
      if (item.markedForReview) return { ...item, priority: 'medium', reason: 'marked' };
      return { ...item, priority: 'reference', reason: 'noted' };
    })
    .sort((a, b) => rank[a.priority] - rank[b.priority] || a.order - b.order);
}

export function buildLearningReview(
  task: LearningTask,
  scenes: Scene[],
  options: { courseTitle?: string; quiz?: CompleteSummary['quiz'] } = {},
): LearningReview {
  const items: LearningReviewItem[] = [...scenes]
    .sort((a, b) => a.order - b.order)
    .map((scene, index) => ({
      sceneId: scene.id,
      order: scene.order,
      title: scene.title || `环节 ${index + 1}`,
      available: true,
      visited: task.visitedSceneIds.includes(scene.id),
      markedForReview: task.reviewSceneIds.includes(scene.id),
      note: task.notes[scene.id]?.content,
    }));
  const knownSceneIds = new Set(items.map((item) => item.sceneId));
  const orphanSceneIds = new Set([
    ...task.reviewSceneIds.filter((sceneId) => !knownSceneIds.has(sceneId)),
    ...Object.keys(task.notes).filter((sceneId) => !knownSceneIds.has(sceneId)),
  ]);
  let orphanOrder = scenes.length;
  orphanSceneIds.forEach((sceneId) => {
    orphanOrder += 1;
    items.push({
      sceneId,
      order: orphanOrder,
      title: '已移除的课堂环节',
      available: false,
      visited: task.visitedSceneIds.includes(sceneId),
      markedForReview: task.reviewSceneIds.includes(sceneId),
      note: task.notes[sceneId]?.content,
    });
  });
  const availableItems = items.filter((item) => item.available);
  const visitedCount = availableItems.filter((item) => item.visited).length;
  return {
    task,
    courseTitle: options.courseTitle || task.courseName,
    items,
    reviewQueue: buildReviewQueue(items),
    sceneCount: availableItems.length,
    visitedCount,
    progressPercent: availableItems.length
      ? Math.round((visitedCount / availableItems.length) * 100)
      : 0,
    quiz: options.quiz ?? null,
  };
}

export function learningReviewToMarkdown(review: LearningReview): string {
  const lines = [
    `# ${review.task.knowledgePoint}｜知构 AI 学习回顾`,
    '',
    `- 课程：${review.courseTitle}`,
    `- 学习目标：${review.task.learningGoal}`,
    `- 学习进度：${review.visitedCount}/${review.sceneCount}（${review.progressPercent}%）`,
    review.quiz
      ? `- 测验结果：${review.quiz.correct}/${review.quiz.total}（${review.quiz.pct}%）`
      : '- 测验结果：暂无可用记录',
    '',
    '## 待复习重点',
    '',
  ];

  const marked = review.items.filter((item) => item.markedForReview);
  if (marked.length === 0) lines.push('- 暂无主动标记的环节');
  else marked.forEach((item) => lines.push(`- [ ] ${item.title}`));

  lines.push('', '## 学习笔记', '');
  const noted = review.items.filter((item) => item.note);
  if (noted.length === 0) lines.push('- 暂无笔记');
  else {
    noted.forEach((item) => {
      lines.push(`### ${item.title}`, '', item.note ?? '', '');
    });
  }

  lines.push('---', '由知构 AI 生成');
  return lines.join('\n');
}
