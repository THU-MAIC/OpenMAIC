'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Camera,
  CheckCircle2,
  Compass,
  Eraser,
  ImagePlus,
  Loader2,
  PencilLine,
  RotateCcw,
  Sparkles,
  Volume2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WhiteboardFrame, WHITEBOARD_SHELL_CLASS } from '@/components/whiteboard/whiteboard-frame';
import { LanguageSwitcher } from '@/components/language-switcher';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import {
  applyWhiteboardOps,
  buildWhiteboardFromSteps,
  renderSafeLatexHtml,
} from '@/lib/live-tutor/whiteboard-elements';
import type {
  HelpMeLearnPlan,
  LearningMode,
  PracticeProblem,
  WhiteboardOp,
  WhiteboardStepItem,
} from '@/lib/live-tutor/types';
import { LiveCameraPanel } from './live-camera-panel';

export function HelpMeLearnView() {
  const { t, locale } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [topicInput, setTopicInput] = useState('');
  const [mode, setMode] = useState<LearningMode>('theory-then-solve');
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [plan, setPlan] = useState<HelpMeLearnPlan | null>(null);
  const [activeStage, setActiveStage] = useState<'theory' | 'solve'>('theory');
  const [slideIndex, setSlideIndex] = useState(0);
  const [wbSteps, setWbSteps] = useState<WhiteboardStepItem[]>([]);

  const whiteboard = useMemo(() => buildWhiteboardFromSteps(wbSteps), [wbSteps]);

  const handleImagePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const rawUrl = typeof reader.result === 'string' ? reader.result : null;
      if (!rawUrl) return;
      // Downscale high-megapixel tablet/phone camera photos so uploads stay fast and reliable
      const img = new window.Image();
      img.onload = () => {
        const maxDim = 1280;
        const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setAttachedImage(rawUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        setAttachedImage(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => setAttachedImage(rawUrl);
      img.src = rawUrl;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const seedWhiteboardForProblem = useCallback((prob: PracticeProblem, title?: string) => {
    const initialOps: WhiteboardOp[] = [
      { op: 'clear' },
      { op: 'add_heading', content: prob.targetConcept || title || 'Guided Problem Solving' },
      { op: 'add_step', content: prob.statement },
    ];
    if (prob.formulaLatex) {
      initialOps.push({ op: 'add_formula', content: prob.formulaLatex });
    }
    setWbSteps(applyWhiteboardOps([], initialOps));
  }, []);

  const handleStartLearning = async () => {
    if (!topicInput.trim() && !attachedImage) return;
    setLoadingPlan(true);
    setPlanError(null);

    try {
      const resp = await fetch('/api/help-me-learn/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topicInput.trim(),
          mode,
          imageDataUrl: attachedImage ?? undefined,
          language: locale,
        }),
      });
      const json = (await resp.json()) as {
        data?: { plan?: HelpMeLearnPlan };
        plan?: HelpMeLearnPlan;
        error?: { message?: string };
      };
      if (!resp.ok) {
        throw new Error(json.error?.message || `HTTP ${resp.status}`);
      }
      const generated = (json.data ?? json).plan;
      if (!generated) throw new Error('Empty study plan');

      setPlan(generated);
      setSlideIndex(0);
      seedWhiteboardForProblem(generated.problem, generated.topic);
      setActiveStage(
        generated.mode === 'theory-then-solve' && generated.slides.length > 0 ? 'theory' : 'solve',
      );
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Failed to create study session');
    } finally {
      setLoadingPlan(false);
    }
  };

  const handleWhiteboardOps = useCallback((ops: WhiteboardOp[]) => {
    setWbSteps((prev) => applyWhiteboardOps(prev, ops));
  }, []);

  const handleProblemAssigned = useCallback(
    (nextProblem: PracticeProblem) => {
      setPlan((prev) => (prev ? { ...prev, problem: nextProblem } : prev));
      seedWhiteboardForProblem(nextProblem, plan?.topic);
    },
    [plan?.topic, seedWhiteboardForProblem],
  );

  const speakSlide = (title: string, summary: string, points: string[]) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const text = [title, summary, ...points].filter(Boolean).join('. ');
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  };

  const resetToTopicPicker = () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setPlan(null);
    setWbSteps([]);
    setPlanError(null);
  };

  const currentSlide = plan?.slides[slideIndex] ?? null;

  const theorySummaryContext = useMemo(() => {
    if (!plan) return '';
    return plan.slides
      .map((s, i) => `Slide ${i + 1} (${s.title}): ${s.summary} ${s.keyPoints.join('; ')}`)
      .join('\n');
  }, [plan]);

  return (
    <div className="min-h-dvh flex flex-col bg-gradient-to-br from-slate-50 via-white to-violet-50/40 dark:from-gray-950 dark:via-gray-900 dark:to-violet-950/20">
      {/* Top Bar */}
      <header className="h-16 px-4 sm:px-6 border-b border-gray-200/70 dark:border-gray-800/80 bg-white/80 dark:bg-gray-950/80 backdrop-blur-xl flex items-center justify-between gap-3 shrink-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/"
            className="p-2 rounded-xl text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0"
            title={t('helpMeLearn.backHome')}
          >
            <ArrowLeft className="size-5" />
          </Link>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="size-9 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white flex items-center justify-center shadow-sm shrink-0">
              <Compass className="size-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold text-gray-900 dark:text-gray-100 truncate">
                {plan ? plan.topic : t('helpMeLearn.title')}
              </h1>
              <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate hidden sm:block">
                {t('helpMeLearn.subtitle')}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {plan && plan.slides.length > 0 && (
            <div className="inline-flex rounded-xl bg-gray-100 dark:bg-gray-800 p-1">
              <button
                type="button"
                onClick={() => setActiveStage('theory')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5',
                  activeStage === 'theory'
                    ? 'bg-white dark:bg-gray-900 text-violet-700 dark:text-violet-300 shadow-xs'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200',
                )}
              >
                <BookOpen className="size-3.5" />
                {t('helpMeLearn.theoryTab')}
              </button>
              <button
                type="button"
                onClick={() => setActiveStage('solve')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5',
                  activeStage === 'solve'
                    ? 'bg-white dark:bg-gray-900 text-violet-700 dark:text-violet-300 shadow-xs'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200',
                )}
              >
                <PencilLine className="size-3.5" />
                {t('helpMeLearn.solveTab')}
              </button>
            </div>
          )}

          {plan && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resetToTopicPicker}
              className="rounded-xl gap-1.5 text-xs h-9"
            >
              <RotateCcw className="size-3.5" />
              <span className="hidden sm:inline">{t('helpMeLearn.newTopic')}</span>
            </Button>
          )}
          <LanguageSwitcher />
        </div>
      </header>

      {/* Step 1: Topic + Learning Mode Configuration */}
      {!plan ? (
        <main className="flex-1 flex items-center justify-center p-4 sm:p-8">
          <div className="w-full max-w-2xl rounded-3xl border border-gray-200/80 dark:border-gray-800 bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl shadow-xl p-6 sm:p-8 space-y-6">
            <div className="space-y-1.5">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-100 dark:bg-violet-900/40 px-3 py-1 text-xs font-semibold text-violet-700 dark:text-violet-300">
                <Sparkles className="size-3.5" />
                {t('helpMeLearn.badge')}
              </span>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">
                {t('helpMeLearn.heading')}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('helpMeLearn.description')}
              </p>
            </div>

            {/* Configurable Learning Mode Selector */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t('helpMeLearn.chooseModeLabel')}
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  data-testid="mode-theory-then-solve"
                  onClick={() => setMode('theory-then-solve')}
                  className={cn(
                    'text-left rounded-2xl border-2 p-4 transition-all',
                    mode === 'theory-then-solve'
                      ? 'border-violet-600 bg-violet-50/70 dark:bg-violet-950/35 dark:border-violet-400'
                      : 'border-gray-200 dark:border-gray-800 hover:border-violet-300 dark:hover:border-violet-700',
                  )}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="inline-flex items-center gap-2 font-bold text-sm text-gray-900 dark:text-gray-100">
                      <BookOpen className="size-4 text-violet-600 dark:text-violet-400" />
                      {t('helpMeLearn.modeTheoryTitle')}
                    </span>
                    {mode === 'theory-then-solve' && (
                      <CheckCircle2 className="size-4 text-violet-600 dark:text-violet-400" />
                    )}
                  </div>
                  <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
                    {t('helpMeLearn.modeTheoryDesc')}
                  </p>
                </button>

                <button
                  type="button"
                  data-testid="mode-solve-only"
                  onClick={() => setMode('solve-only')}
                  className={cn(
                    'text-left rounded-2xl border-2 p-4 transition-all',
                    mode === 'solve-only'
                      ? 'border-violet-600 bg-violet-50/70 dark:bg-violet-950/35 dark:border-violet-400'
                      : 'border-gray-200 dark:border-gray-800 hover:border-violet-300 dark:hover:border-violet-700',
                  )}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="inline-flex items-center gap-2 font-bold text-sm text-gray-900 dark:text-gray-100">
                      <Camera className="size-4 text-emerald-600 dark:text-emerald-400" />
                      {t('helpMeLearn.modeSolveOnlyTitle')}
                    </span>
                    {mode === 'solve-only' && (
                      <CheckCircle2 className="size-4 text-violet-600 dark:text-violet-400" />
                    )}
                  </div>
                  <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
                    {t('helpMeLearn.modeSolveOnlyDesc')}
                  </p>
                </button>
              </div>
            </div>

            {/* Topic / Problem Input + Photo Upload */}
            <div className="space-y-3">
              <textarea
                value={topicInput}
                onChange={(e) => setTopicInput(e.target.value)}
                rows={3}
                placeholder={t('helpMeLearn.inputPlaceholder')}
                className="w-full rounded-2xl border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-950/60 p-4 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500/50 resize-none"
              />

              {attachedImage && (
                <div className="relative inline-flex items-center gap-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/70 p-2 pr-3">
                  <img
                    src={attachedImage}
                    alt="Problem snapshot"
                    className="size-12 rounded-lg object-cover"
                  />
                  <span className="text-xs text-gray-600 dark:text-gray-300">
                    {t('helpMeLearn.photoAttached')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAttachedImage(null)}
                    className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500"
                    aria-label={t('common.close')}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleImagePick}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-xl h-11 gap-2"
                >
                  <ImagePlus className="size-4" />
                  {t('helpMeLearn.attachPhoto')}
                </Button>

                <Button
                  type="button"
                  disabled={loadingPlan || (!topicInput.trim() && !attachedImage)}
                  onClick={() => void handleStartLearning()}
                  className="rounded-xl h-11 px-6 bg-violet-600 hover:bg-violet-700 text-white gap-2 font-semibold"
                >
                  {loadingPlan ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  {loadingPlan ? t('helpMeLearn.preparing') : t('helpMeLearn.startButton')}
                </Button>
              </div>

              {planError && <p className="text-xs text-red-600 dark:text-red-400">{planError}</p>}
            </div>
          </div>
        </main>
      ) : (
        /* Step 2: Active Study Session (Theory Slides + Guided Whiteboard & Camera) */
        <main className="flex-1 min-h-0 flex flex-col p-3 sm:p-5">
          {/* Theory Slides View */}
          {activeStage === 'theory' && currentSlide && (
            <div className="flex-1 flex flex-col items-center justify-center max-w-4xl w-full mx-auto gap-4">
              <div className="w-full rounded-3xl border border-violet-200/70 dark:border-violet-800/60 bg-white dark:bg-gray-900 shadow-xl p-6 sm:p-10 space-y-6">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-bold uppercase tracking-widest text-violet-600 dark:text-violet-400">
                    {t('helpMeLearn.slideCounter', {
                      current: slideIndex + 1,
                      total: plan.slides.length,
                    })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      speakSlide(currentSlide.title, currentSlide.summary, currentSlide.keyPoints)
                    }
                    className="h-8 gap-1.5 text-xs rounded-xl"
                  >
                    <Volume2 className="size-4" />
                    {t('helpMeLearn.readAloud')}
                  </Button>
                </div>

                <div className="space-y-2">
                  <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-gray-100">
                    {currentSlide.title}
                  </h2>
                  <p className="text-base text-gray-600 dark:text-gray-300 leading-relaxed">
                    {currentSlide.summary}
                  </p>
                </div>

                {currentSlide.formulaLatex && (
                  <div
                    className="rounded-2xl bg-violet-50/70 dark:bg-violet-950/30 border border-violet-200/60 dark:border-violet-800/50 px-5 py-4 overflow-x-auto"
                    dangerouslySetInnerHTML={{
                      __html: renderSafeLatexHtml(currentSlide.formulaLatex, true),
                    }}
                  />
                )}

                {currentSlide.keyPoints.length > 0 && (
                  <ul className="space-y-2.5">
                    {currentSlide.keyPoints.map((pt, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2.5 text-sm text-gray-800 dark:text-gray-200"
                      >
                        <span className="mt-0.5 size-5 rounded-full bg-violet-100 dark:bg-violet-900/50 text-violet-700 dark:text-violet-300 text-xs font-bold flex items-center justify-center shrink-0">
                          {i + 1}
                        </span>
                        <span className="leading-relaxed">{pt}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {currentSlide.workedExample && (
                  <div className="rounded-2xl bg-emerald-50/70 dark:bg-emerald-950/25 border border-emerald-200/70 dark:border-emerald-800/50 p-4 space-y-2">
                    <div className="text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                      {t('helpMeLearn.workedExample')}
                    </div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {currentSlide.workedExample.problem}
                    </p>
                    <ol className="list-decimal list-inside space-y-1 text-xs sm:text-sm text-gray-700 dark:text-gray-300">
                      {currentSlide.workedExample.steps.map((st, idx) => (
                        <li key={idx}>{st}</li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>

              {/* Slide Navigation Footer */}
              <div className="w-full flex items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={slideIndex === 0}
                  onClick={() => setSlideIndex((i) => Math.max(0, i - 1))}
                  className="rounded-xl h-11 gap-1.5"
                >
                  <ArrowLeft className="size-4" />
                  {t('helpMeLearn.prevSlide')}
                </Button>

                {slideIndex < plan.slides.length - 1 ? (
                  <Button
                    type="button"
                    onClick={() => setSlideIndex((i) => Math.min(plan.slides.length - 1, i + 1))}
                    className="rounded-xl h-11 px-6 bg-violet-600 hover:bg-violet-700 text-white gap-1.5"
                  >
                    {t('helpMeLearn.nextSlide')}
                    <ArrowRight className="size-4" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={() => setActiveStage('solve')}
                    className="rounded-xl h-11 px-6 bg-emerald-600 hover:bg-emerald-700 text-white gap-2 font-semibold"
                  >
                    <PencilLine className="size-4" />
                    {t('helpMeLearn.proceedToSolve')}
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Guided Problem Solving Studio (Whiteboard + Live Camera kept mounted once reached) */}
          <div
            className={cn(
              'flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-4',
              activeStage !== 'solve' && 'hidden',
            )}
          >
            {/* Left: Native OpenMAIC Interactive Whiteboard */}
            <div className={cn(WHITEBOARD_SHELL_CLASS, 'lg:col-span-7 min-h-[380px] lg:min-h-0')}>
              <SceneProvider>
                <WhiteboardFrame
                  title={t('helpMeLearn.whiteboardTitle')}
                  whiteboard={whiteboard}
                  onClose={() => {
                    if (plan.slides.length > 0) setActiveStage('theory');
                  }}
                  actions={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setWbSteps([])}
                      className="h-8 px-2.5 text-xs gap-1 text-gray-500 hover:text-red-600"
                      title={t('helpMeLearn.clearBoard')}
                    >
                      <Eraser className="size-3.5" />
                      <span className="hidden sm:inline">{t('helpMeLearn.clearBoard')}</span>
                    </Button>
                  }
                />
              </SceneProvider>
            </div>

            {/* Right: Live Notebook Camera & Voice Tutor */}
            <div className="lg:col-span-5 rounded-3xl border border-gray-200/80 dark:border-gray-800 bg-white/95 dark:bg-gray-900/95 p-4 shadow-lg flex flex-col min-h-[420px] lg:min-h-0">
              <LiveCameraPanel
                topic={plan.topic}
                problem={plan.problem}
                sceneContext={theorySummaryContext}
                whiteboardStepsText={wbSteps.map((s) => s.content)}
                onWhiteboardOps={handleWhiteboardOps}
                onProblemAssigned={handleProblemAssigned}
              />
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
