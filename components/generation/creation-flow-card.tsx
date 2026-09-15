'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowRight,
  BookOpenCheck,
  Check,
  CircleDot,
  FileText,
  LockKeyhole,
  NotebookPen,
  Presentation,
  Sparkles,
  Target,
} from 'lucide-react';

import { cn } from '@/lib/utils';

interface CreationFlowCardProps {
  mode: 'create' | 'learning';
  locale: string;
  requirementReady: boolean;
  materialCount: number;
  learningFieldsCompleted?: number;
  onFocusPrimary: () => void;
}

interface FlowStep {
  title: string;
  detail: string;
  icon: typeof Target;
}

export function CreationFlowCard({
  mode,
  locale,
  requirementReady,
  materialCount,
  learningFieldsCompleted = 0,
  onFocusPrimary,
}: CreationFlowCardProps) {
  const zh = locale === 'zh-CN';
  const learning = mode === 'learning';
  const firstStepReady = learning ? learningFieldsCompleted === 3 : requirementReady;
  const [focusedStep, setFocusedStep] = useState(0);
  const [lockedStep, setLockedStep] = useState<number | null>(null);

  const steps: FlowStep[] = learning
    ? [
        {
          title: zh ? '明确学习目标' : 'Define your goal',
          detail: zh
            ? `必填信息已完成 ${learningFieldsCompleted} / 3`
            : `${learningFieldsCompleted} of 3 required fields completed`,
          icon: Target,
        },
        {
          title: zh ? '生成目标课堂' : 'Generate goal-based class',
          detail: zh
            ? '提交目标后，AI 将组织对应的学习路径。'
            : 'AI will build a path around your goal.',
          icon: Presentation,
        },
        {
          title: zh ? '记录理解与重点' : 'Capture notes and review points',
          detail: zh
            ? '在课堂中保存笔记，并主动标记待复习环节。'
            : 'Save notes and mark scenes to revisit.',
          icon: NotebookPen,
        },
        {
          title: zh ? '形成学习回顾' : 'Build your learning review',
          detail: zh
            ? '汇总真实访问、笔记和复习内容。'
            : 'Summarize visits, notes, and review items.',
          icon: BookOpenCheck,
        },
      ]
    : [
        {
          title: zh ? '描述课程需求' : 'Describe the course',
          detail: requirementReady
            ? zh
              ? '课程主题已经准备好，可以生成方案。'
              : 'Your course brief is ready to generate.'
            : zh
              ? '输入课程主题、教学目标或希望解决的问题。'
              : 'Enter a topic, teaching goal, or problem to solve.',
          icon: FileText,
        },
        {
          title: zh ? '确认课程计划' : 'Review the course plan',
          detail: zh
            ? '生成后可调整章节结构与互动场景。'
            : 'Adjust sections and interactive scenes after generation.',
          icon: Presentation,
        },
        {
          title: zh ? '进入互动课堂' : 'Enter the interactive class',
          detail: zh
            ? '确认方案后生成可播放、可编辑的课堂。'
            : 'Create a playable, editable classroom from the plan.',
          icon: Sparkles,
        },
      ];

  const handleStepClick = (index: number) => {
    setFocusedStep(index);
    if (index === 0) {
      setLockedStep(null);
      onFocusPrimary();
      return;
    }
    setLockedStep(index);
  };

  const message =
    lockedStep === null
      ? steps[focusedStep].detail
      : zh
        ? firstStepReady
          ? '点击左侧生成按钮后开放此步骤。'
          : '先完成左侧必填内容，再进入下一步。'
        : firstStepReady
          ? 'Generate from the left panel to unlock this step.'
          : 'Complete the required fields to unlock this step.';

  return (
    <motion.aside
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.4 }}
      onMouseLeave={() => setFocusedStep(0)}
      className="group relative min-h-[300px] overflow-hidden rounded-2xl border border-primary/15 bg-primary p-5 text-primary-foreground shadow-[0_22px_60px_-36px_color-mix(in_oklab,var(--primary)_70%,transparent)] lg:col-span-4 lg:row-span-3"
      data-testid={`creation-flow-${mode}`}
    >
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-20 size-52 rounded-full border-[34px] border-white/10"
        animate={{ x: focusedStep * -3, y: focusedStep * 2, scale: 1 + focusedStep * 0.025 }}
        transition={{ type: 'spring', stiffness: 120, damping: 18 }}
      />
      <div className="pointer-events-none absolute -bottom-14 right-8 size-32 rounded-full bg-white/[0.06] transition-transform duration-700 group-hover:-translate-y-2 group-hover:translate-x-2" />

      <div className="relative flex h-full flex-col">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-foreground/65">
              {learning
                ? zh
                  ? '目标学习闭环'
                  : 'Goal-based learning'
                : zh
                  ? '课程创作流程'
                  : 'Course creation'}
            </p>
            <h2 className="mt-1.5 text-xl font-semibold leading-snug">
              {learning
                ? zh
                  ? '让每次学习留下成果'
                  : 'Turn learning into outcomes'
                : zh
                  ? '从想法到互动课堂'
                  : 'From idea to classroom'}
            </h2>
          </div>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/12">
            {learning ? <Target className="size-4.5" /> : <Sparkles className="size-4.5" />}
          </span>
        </div>

        <div className="relative mt-5 space-y-1">
          <span
            className="absolute bottom-5 left-[15px] top-5 w-px bg-white/15"
            aria-hidden="true"
          />
          <motion.span
            className="absolute left-[15px] top-5 w-px bg-white/75"
            aria-hidden="true"
            animate={{ height: firstStepReady ? 28 : 0 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          />
          {steps.map((step, index) => {
            const Icon = step.icon;
            const complete = index === 0 && firstStepReady;
            const active = focusedStep === index;
            const locked = index > 0;
            return (
              <motion.button
                key={step.title}
                type="button"
                onClick={() => handleStepClick(index)}
                onMouseEnter={() => setFocusedStep(index)}
                onFocus={() => setFocusedStep(index)}
                whileHover={{ x: 3 }}
                className={cn(
                  'relative flex w-full items-center gap-3 rounded-xl px-1.5 py-2 text-left transition-colors',
                  active ? 'bg-white/10' : 'hover:bg-white/[0.07]',
                )}
              >
                <span
                  className={cn(
                    'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors',
                    complete
                      ? 'border-white bg-white text-primary'
                      : active
                        ? 'border-white/60 bg-white/20 text-white'
                        : 'border-white/25 bg-primary text-white/75',
                  )}
                >
                  {complete ? <Check className="size-3.5" /> : <Icon className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-white">{step.title}</span>
                  {index === 0 ? (
                    <span className="mt-0.5 block text-[10px] text-primary-foreground/55">
                      {learning
                        ? `${learningFieldsCompleted} / 3`
                        : requirementReady
                          ? zh
                            ? '已填写'
                            : 'Ready'
                          : zh
                            ? '待填写'
                            : 'Not started'}
                    </span>
                  ) : null}
                </span>
                {locked ? (
                  <LockKeyhole className="size-3 text-primary-foreground/35" aria-hidden="true" />
                ) : (
                  <ArrowRight className="size-3.5 text-primary-foreground/55" aria-hidden="true" />
                )}
              </motion.button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[10px] text-primary-foreground/70">
            <CircleDot className="size-3" />
            {learning
              ? zh
                ? `${learningFieldsCompleted} / 3 项必填已完成`
                : `${learningFieldsCompleted} / 3 required`
              : requirementReady
                ? zh
                  ? '需求已填写'
                  : 'Brief ready'
                : zh
                  ? '等待课程需求'
                  : 'Waiting for brief'}
          </span>
          {materialCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[10px] text-primary-foreground/70">
              <FileText className="size-3" />
              {zh
                ? `${materialCount} 份学习材料`
                : `${materialCount} material${materialCount > 1 ? 's' : ''}`}
            </span>
          ) : null}
        </div>

        <AnimatePresence mode="wait">
          <motion.p
            key={`${focusedStep}-${lockedStep ?? 'open'}-${message}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.16 }}
            className="mt-3 min-h-9 rounded-xl border border-white/10 bg-black/10 px-3 py-2 text-[11px] leading-5 text-primary-foreground/65"
            aria-live="polite"
          >
            {message}
          </motion.p>
        </AnimatePresence>
      </div>
    </motion.aside>
  );
}
