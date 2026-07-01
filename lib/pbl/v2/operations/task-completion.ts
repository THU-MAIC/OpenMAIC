import type {
  PBLChatMessage,
  PBLEvaluation,
  PBLInternalAssessment,
  PBLMilestone,
  PBLMicrotask,
  PBLPendingTaskCompletion,
  PBLProjectV2,
} from '../types';
import { recordEvent } from './engagement';

export const TASK_EVAL_PASS_SCORE = 60;

export function taskEvaluationCanComplete(evaluation: PBLEvaluation | undefined): boolean {
  return (
    evaluation?.kind === 'task' &&
    typeof evaluation.score === 'number' &&
    evaluation.score >= TASK_EVAL_PASS_SCORE
  );
}

export function orderedMicrotasks(milestone: PBLMilestone): PBLMicrotask[] {
  return milestone.microtasks.slice().sort((a, b) => a.order - b.order);
}

export function isLastMicrotaskOfMilestone(milestone: PBLMilestone, microtaskId: string): boolean {
  const tasks = orderedMicrotasks(milestone);
  return tasks.length > 0 && tasks[tasks.length - 1]?.id === microtaskId;
}

export function isCoreMilestoneFinalMicrotask(
  milestone: PBLMilestone,
  microtaskId: string,
): boolean {
  return !!milestone.synthesisCheck && isLastMicrotaskOfMilestone(milestone, microtaskId);
}

export function currentPendingTaskCompletion(
  project: PBLProjectV2,
  microtaskId: string | undefined,
): PBLPendingTaskCompletion | undefined {
  if (!microtaskId) return undefined;
  const pending = project.pendingTaskCompletion;
  return pending?.microtaskId === microtaskId ? pending : undefined;
}

export function setPendingTaskCompletion(
  project: PBLProjectV2,
  args: {
    microtaskId: string;
    milestoneId: string;
    reason: string;
    assessment?: PBLInternalAssessment;
    evidence?: PBLPendingTaskCompletion['evidence'];
  },
): PBLPendingTaskCompletion {
  const existing = currentPendingTaskCompletion(project, args.microtaskId);
  const pending: PBLPendingTaskCompletion = {
    microtaskId: args.microtaskId,
    milestoneId: args.milestoneId,
    reason: args.reason,
    assessment: args.assessment,
    evidence: args.evidence,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  project.pendingTaskCompletion = pending;
  project.updatedAt = new Date().toISOString();
  return pending;
}

export function taskCompletionReadyText(language: string | undefined): string {
  switch (language) {
    case 'zh-CN':
      return '这个任务已经完成了。如果你准备好了，也没有其他问题了，请点击左侧当前任务里的「完成」按钮进入下一步。';
    case 'zh-TW':
      return '這個任務已經完成了。如果你準備好了，也沒有其他問題了，請點擊左側目前任務裡的「完成」按鈕進入下一步。';
    case 'ja-JP':
      return 'このタスクは完了です。準備ができていて、ほかに質問がなければ、左側の現在のタスクにある「完了」ボタンを押して次へ進んでください。';
    case 'ru-RU':
      return 'Эта задача завершена. Если вы готовы и больше нет вопросов, нажмите кнопку «Готово» у текущей задачи слева, чтобы перейти дальше.';
    case 'ar-SA':
      return 'اكتملت هذه المهمة. إذا كنت مستعدًا ولا توجد لديك أسئلة أخرى، فاضغط زر «تم» في المهمة الحالية على اليسار للانتقال إلى الخطوة التالية.';
    case 'en-US':
    default:
      return 'This task is complete. When you are ready and have no other questions, click Done on the current task in the left sidebar to move on.';
  }
}

const TASK_COMPLETION_READY_TEXTS = new Set(
  ['zh-CN', 'zh-TW', 'ja-JP', 'ru-RU', 'ar-SA', 'en-US', undefined].map((language) =>
    taskCompletionReadyText(language),
  ),
);

export function isTaskCompletionReadyMessageContent(content: string | undefined): boolean {
  return TASK_COMPLETION_READY_TEXTS.has((content ?? '').trim());
}

function isoAfter(previous?: string): string {
  const now = Date.now();
  const previousMs = previous ? Date.parse(previous) : NaN;
  const min = Number.isFinite(previousMs) ? previousMs + 1 : 0;
  return new Date(Math.max(now, min)).toISOString();
}

export function appendTaskCompletionReadyMessage(
  project: PBLProjectV2,
  microtaskId: string,
  options: { afterTs?: string } = {},
): PBLChatMessage | undefined {
  const instructor = project.roles.find((r) => r.type === 'instructor');
  if (!instructor) return undefined;
  const thread = project.threads.find((t) => t.agentId === instructor.id);
  if (!thread) return undefined;
  const content = taskCompletionReadyText(project.language);
  const exists = thread.messages.some(
    (m) => m.microtaskId === microtaskId && m.content === content,
  );
  if (exists) return undefined;
  const message: PBLChatMessage = {
    id: 'msg_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6),
    agentId: instructor.id,
    roleType: 'instructor',
    content,
    ts: isoAfter(options.afterTs),
    microtaskId,
  };
  thread.messages.push(message);
  project.updatedAt = message.ts;
  return message;
}

export function recordPendingTaskCompletionEvidence(
  project: PBLProjectV2,
  milestone: PBLMilestone,
  microtask: PBLMicrotask,
  evidence: PBLPendingTaskCompletion['evidence'] | undefined,
): void {
  if (!evidence) return;
  recordEvent(project, 'observation_concept_unlocked', {
    microtaskId: microtask.id,
    milestoneId: milestone.id,
    payload: {
      signature: evidence.signature,
      label: evidence.label,
      note: evidence.note,
    },
  });
}

export function clearPendingTaskCompletion(project: PBLProjectV2, microtaskId?: string): void {
  if (!project.pendingTaskCompletion) return;
  if (microtaskId && project.pendingTaskCompletion.microtaskId !== microtaskId) return;
  delete project.pendingTaskCompletion;
  project.updatedAt = new Date().toISOString();
}
