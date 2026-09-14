'use client';

import { BookOpenCheck, Target } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ConceptLearningTaskInput } from '@/lib/learning/types';

interface TaskCreateFieldsProps {
  value: ConceptLearningTaskInput;
  errors?: Partial<Record<keyof ConceptLearningTaskInput, string>>;
  locale?: string;
  disabled?: boolean;
  onChange: (value: ConceptLearningTaskInput) => void;
}

export function TaskCreateFields({
  value,
  errors = {},
  locale = 'zh-CN',
  disabled,
  onChange,
}: TaskCreateFieldsProps) {
  const zh = locale === 'zh-CN';
  const update = <K extends keyof ConceptLearningTaskInput>(
    field: K,
    next: ConceptLearningTaskInput[K],
  ) => onChange({ ...value, [field]: next });

  return (
    <section
      className="border-b border-border/70 px-5 pb-5 pt-4"
      data-testid="learning-task-fields"
    >
      <div className="mb-4 flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Target className="size-4.5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {zh ? '先确定这次要真正学会什么' : 'Define what you want to master'}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {zh
              ? '知构 AI 会据此组织讲解、示例、互动练习和复习清单。'
              : 'ZhiGou AI will organize explanations, examples, practice, and review around it.'}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={zh ? '课程名称' : 'Course'} error={errors.courseName}>
          <Input
            value={value.courseName}
            disabled={disabled}
            aria-invalid={!!errors.courseName}
            placeholder={zh ? '例如：数据结构' : 'e.g. Data Structures'}
            onChange={(event) => update('courseName', event.target.value)}
          />
        </Field>
        <Field label={zh ? '核心知识点' : 'Core concept'} error={errors.knowledgePoint}>
          <Input
            value={value.knowledgePoint}
            disabled={disabled}
            aria-invalid={!!errors.knowledgePoint}
            placeholder={zh ? '例如：二叉树遍历' : 'e.g. Tree traversal'}
            onChange={(event) => update('knowledgePoint', event.target.value)}
          />
        </Field>
        <Field label={zh ? '本次学习目标' : 'Learning goal'} error={errors.learningGoal}>
          <Textarea
            value={value.learningGoal}
            disabled={disabled}
            aria-invalid={!!errors.learningGoal}
            className="min-h-20 resize-none"
            placeholder={zh ? '例如：能区分并手写三种遍历过程' : 'What should you be able to do?'}
            onChange={(event) => update('learningGoal', event.target.value)}
          />
        </Field>
        <Field label={zh ? '已有基础（选填）' : 'Prior knowledge (optional)'}>
          <Textarea
            value={value.priorKnowledge ?? ''}
            disabled={disabled}
            className="min-h-20 resize-none"
            placeholder={zh ? '例如：了解递归和栈' : 'What do you already know?'}
            onChange={(event) => update('priorKnowledge', event.target.value)}
          />
        </Field>
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-xl bg-primary/[0.06] px-3 py-2 text-xs text-muted-foreground">
        <BookOpenCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
        {zh
          ? '任务会与生成的课堂关联，学习进度、笔记和待复习内容将持续保留。'
          : 'This task will stay linked to its classroom, progress, notes, and review items.'}
      </div>
    </section>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
