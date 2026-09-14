'use client';

import { useEffect, useState, Suspense, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, Sparkles, AlertCircle, AlertTriangle, ArrowLeft, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { OutlinesEditor } from '@/components/generation/outlines-editor';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import {
  getEnabledProvidersWithVoices,
  resolveNarratorVoiceForGeneration,
} from '@/lib/audio/voice-resolver';
import { isQwenCloneVoice, resolveTTSModelForVoice } from '@/lib/audio/constants';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { useAllVoiceProfiles } from '@/lib/audio/voxcpm-voices';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  fetchSceneActions,
  fetchSceneContent,
  generateTTSForScene,
} from '@/lib/hooks/use-scene-generator';
import { isAbortError } from '@openmaic/generation';
import { FOREGROUND_SCENE_RETRY_OPTIONS } from './foreground-retry';
import {
  loadImageMapping,
  loadDocumentBlob,
  cleanupOldImages,
  storeImages,
} from '@/lib/utils/image-storage';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { resolveSessionDocumentSources } from '@/lib/document/session-sources';
import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import {
  MAX_DOCUMENT_BUNDLE_FILES,
  MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES,
  buildDocumentBundle,
  type ParsedDocumentPart,
} from '@/lib/document/bundle';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import { nanoid } from 'nanoid';
import type { GeneratedAgentConfig, Stage } from '@/lib/types/stage';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  SessionDocumentSource,
} from '@/lib/types/generation';
import { AgentRevealModal } from '@/components/agent/agent-reveal-modal';
import { createLogger } from '@/lib/logger';
import { useBrand } from '@/lib/brand/brand-context';
import { useTheme } from '@/lib/hooks/use-theme';
import {
  type GenerationSessionState,
  ALL_STEPS,
  getActiveSteps,
  getGenerationStepText,
} from './types';
import { StepVisualizer } from './components/visualizers';
import { resolveTaskEngineModeFromOutlineDoneEvent } from './vocational-mode';
import { LEARNING_TASK_DRAFT_SESSION_KEY, updateLearningTask } from '@/lib/learning/task-storage';

const log = createLogger('GenerationPreview');
const OUTLINE_REVIEW_AUTO_CONTINUE_MS = 2500;

type ParsedDocumentResponseImage = {
  id: string;
  src?: string;
  pageNumber?: number;
  description?: string;
  width?: number;
  height?: number;
};

function validateDocumentSources(
  sources: SessionDocumentSource[],
  t: (key: string, values?: Record<string, unknown>) => string,
) {
  if (sources.length > MAX_DOCUMENT_BUNDLE_FILES) {
    throw new Error(t('upload.courseMaterialCountLimit', { n: MAX_DOCUMENT_BUNDLE_FILES }));
  }

  const totalSize = sources.reduce((sum, source) => sum + source.size, 0);
  if (totalSize > MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES) {
    throw new Error(
      t('upload.courseMaterialTotalSizeLimit', {
        n: Math.floor(MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES / 1024 / 1024),
      }),
    );
  }
}

type SceneGenerationFailure = {
  error?: string;
  errorCode?: string;
  statusCode?: number;
};

function CoursePlanStepBar({ locale }: { locale: string }) {
  const steps =
    locale === 'zh-CN'
      ? ['课程内容', '课程计划', '互动课堂']
      : ['Course content', 'Course plan', 'Interactive classroom'];

  return (
    <nav
      aria-label={locale === 'zh-CN' ? '课程创建进度' : 'Course creation progress'}
      className="flex items-center gap-2 rounded-2xl border border-border/70 bg-card/65 px-3 py-2.5 text-xs backdrop-blur-sm sm:gap-3 sm:px-4"
    >
      {steps.map((step, index) => (
        <div key={step} className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
              index === 1
                ? 'border-primary bg-primary text-primary-foreground shadow-sm shadow-primary/25'
                : 'border-border bg-background/70 text-muted-foreground',
            )}
          >
            {index + 1}
          </span>
          <span
            className={cn(
              'truncate',
              index === 1 ? 'font-semibold text-primary' : 'text-muted-foreground',
            )}
          >
            {step}
          </span>
          {index < steps.length - 1 && <span className="hidden h-px flex-1 bg-border sm:block" />}
        </div>
      ))}
    </nav>
  );
}

function CoursePlanOverview({
  locale,
  title,
  outlines,
  materialCount,
}: {
  locale: string;
  title?: string;
  outlines: SceneOutline[];
  materialCount: number;
}) {
  const labels =
    locale === 'zh-CN'
      ? { overview: '课程概览', scenes: '教学环节', materials: '参考资料', empty: '待生成' }
      : {
          overview: 'Course overview',
          scenes: 'Teaching sections',
          materials: 'Materials',
          empty: 'Pending',
        };
  const typeCounts = outlines.reduce<Record<string, number>>((counts, outline) => {
    counts[outline.type] = (counts[outline.type] ?? 0) + 1;
    return counts;
  }, {});
  const typeLabels: Record<string, string> =
    locale === 'zh-CN'
      ? { slide: '课程讲解', quiz: '理解检测', interactive: '互动探索', pbl: '项目实践' }
      : { slide: 'Lesson', quiz: 'Check', interactive: 'Interactive', pbl: 'Project' };

  return (
    <section className="rounded-2xl border border-border/70 bg-card/55 px-4 py-3.5 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
            {labels.overview}
          </p>
          <p className="mt-1 truncate text-sm font-semibold text-foreground">
            {title || labels.empty}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full bg-primary/10 px-2 py-1 font-medium text-primary">
            {outlines.length} {labels.scenes}
          </span>
          <span className="rounded-full bg-muted/70 px-2 py-1">
            {materialCount} {labels.materials}
          </span>
        </div>
      </div>
      {outlines.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/50 pt-3">
          {Object.entries(typeCounts).map(([type, count]) => (
            <span
              key={type}
              className="rounded-md border border-border/60 bg-background/60 px-2 py-1 text-[11px] text-muted-foreground"
            >
              {typeLabels[type] ?? type}: {count}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function GenerationPreviewContent() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const brand = useBrand();
  const { resolvedTheme } = useTheme();
  const hasStartedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const outlineReviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outlineReviewResolveRef = useRef<((outlines: SceneOutline[]) => void) | null>(null);
  // Sticky flag: true once the user signals review intent (either by clicking the
  // streaming card mid-stream, or by restoring a session that was already in review).
  // Combined with `reviewOutlineEnabled` to decide whether the post-stream timer fires.
  const outlineReviewIntentRef = useRef(false);
  const { profiles: voiceProfiles } = useAllVoiceProfiles();

  const [session, setSession] = useState<GenerationSessionState | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isComplete] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [streamingOutlines, setStreamingOutlines] = useState<SceneOutline[] | null>(null);
  const [isOutlineStreaming, setIsOutlineStreaming] = useState(false);
  const [truncationWarnings, setTruncationWarnings] = useState<string[]>([]);
  const [webSearchSources, setWebSearchSources] = useState<Array<{ title: string; url: string }>>(
    [],
  );
  const [showAgentReveal, setShowAgentReveal] = useState(false);
  const [isConfirmingOutlines, setIsConfirmingOutlines] = useState(false);
  const [generatedAgents, setGeneratedAgents] = useState<
    Array<{
      id: string;
      name: string;
      role: string;
      persona: string;
      avatar: string;
      color: string;
      priority: number;
    }>
  >([]);
  const agentRevealResolveRef = useRef<(() => void) | null>(null);
  const reviewOutlineEnabled = useSettingsStore((s) => s.reviewOutlineEnabled);
  const setReviewOutlineEnabled = useSettingsStore((s) => s.setReviewOutlineEnabled);

  // Compute active steps based on session state
  const activeSteps = getActiveSteps(session);
  const isOutlineReady = session?.previewPhase === 'outline-ready';
  const isReviewingOutlines = session?.previewPhase === 'review';

  const sceneGenerationErrorMessage = (failure: SceneGenerationFailure): string => {
    if (
      failure.errorCode === 'MISSING_API_KEY' ||
      failure.statusCode === 401 ||
      failure.statusCode === 403
    ) {
      return t('generation.sceneGenerateAuthFailed');
    }

    if (failure.errorCode === 'RATE_LIMITED' || failure.statusCode === 429) {
      return t('generation.sceneGenerateRateLimited');
    }

    if (failure.errorCode === 'UPSTREAM_ERROR' && failure.statusCode && failure.statusCode >= 500) {
      return t('generation.sceneGenerateProviderUnavailable');
    }

    if (failure.errorCode === 'INTERNAL_ERROR') {
      return t('generation.sceneGenerateFailed');
    }

    if (failure.errorCode === 'GENERATION_FAILED') {
      return t('generation.sceneGenerateInvalidResponse');
    }

    return failure.error || t('generation.sceneGenerateFailed');
  };

  const persistSession = (nextSession: GenerationSessionState) => {
    setSession(nextSession);
    sessionStorage.setItem('generationSession', JSON.stringify(nextSession));
  };

  const clearOutlineReviewTimer = () => {
    if (outlineReviewTimerRef.current) {
      clearTimeout(outlineReviewTimerRef.current);
      outlineReviewTimerRef.current = null;
    }
  };

  const waitForOutlineReviewChoice = (
    outlines: SceneOutline[],
    shouldReview: boolean,
    signal: AbortSignal,
  ): Promise<SceneOutline[]> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      outlineReviewResolveRef.current = resolve;
      // Reject on abort so navigating away (`goBackToHome`) or unmounting
      // settles this promise instead of leaking the awaiting startGeneration
      // closure. The catch at the bottom of startGeneration already swallows
      // AbortError silently.
      const onAbort = () => {
        clearOutlineReviewTimer();
        outlineReviewResolveRef.current = null;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (!shouldReview) {
        outlineReviewTimerRef.current = setTimeout(() => {
          outlineReviewTimerRef.current = null;
          outlineReviewResolveRef.current = null;
          signal.removeEventListener('abort', onAbort);
          resolve(outlines);
        }, OUTLINE_REVIEW_AUTO_CONTINUE_MS);
      }
    });

  // Load session from sessionStorage
  useEffect(() => {
    cleanupOldImages(24).catch((e) => log.error(e));

    const saved = sessionStorage.getItem('generationSession');
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as GenerationSessionState;
        if (!parsed.previewPhase) {
          parsed.previewPhase = parsed.sceneOutlines?.length ? 'outline-ready' : 'preparing';
        }
        // Restore review intent: a saved 'review' phase without outlines means the user
        // had opened the editor mid-stream before the refresh — preserve that intent so
        // the post-stream auto-continue timer doesn't fire after SSE restart.
        if (parsed.previewPhase === 'review' && !parsed.sceneOutlines?.length) {
          outlineReviewIntentRef.current = true;
        }
        parsed.taskEngineMode = parsed.taskEngineMode === true;
        setSession(parsed);
      } catch (e) {
        log.error('Failed to parse generation session:', e);
      }
    }
    setSessionLoaded(true);
  }, []);

  // Abort all in-flight requests on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      clearOutlineReviewTimer();
    };
  }, []);

  // Get API credentials from localStorage
  const getApiHeaders = () => {
    const modelConfig = getCurrentModelConfig();
    const settings = useSettingsStore.getState();
    const imageProviderConfig = settings.imageProvidersConfig?.[settings.imageProviderId];
    const videoProviderConfig = settings.videoProvidersConfig?.[settings.videoProviderId];
    return {
      'Content-Type': 'application/json',
      'x-model': modelConfig.modelString,
      'x-api-key': modelConfig.apiKey,
      'x-base-url': modelConfig.baseUrl,
      'x-provider-type': modelConfig.providerType || '',
      // Image generation provider
      'x-image-provider': settings.imageProviderId || '',
      'x-image-model': settings.imageModelId || '',
      'x-image-api-key': imageProviderConfig?.apiKey || '',
      'x-image-base-url': imageProviderConfig?.baseUrl || '',
      // Video generation provider
      'x-video-provider': settings.videoProviderId || '',
      'x-video-model': settings.videoModelId || '',
      'x-video-api-key': videoProviderConfig?.apiKey || '',
      'x-video-base-url': videoProviderConfig?.baseUrl || '',
      // Media generation toggles
      'x-image-generation-enabled': String(settings.imageGenerationEnabled ?? false),
      'x-video-generation-enabled': String(settings.videoGenerationEnabled ?? false),
    };
  };

  const withThinkingConfig = <T extends Record<string, unknown>>(body: T) => {
    const { thinkingConfig } = getCurrentModelConfig();
    return thinkingConfig ? { ...body, thinkingConfig } : body;
  };

  // Auto-start generation when session is loaded
  useEffect(() => {
    if (!session || hasStartedRef.current) return;
    const needsOutlines = !session.sceneOutlines || session.sceneOutlines.length === 0;
    const phase = session.previewPhase;
    const shouldAutoStart =
      !phase ||
      phase === 'preparing' ||
      phase === 'generating-content' ||
      // Refresh during early-review: editor is shown but outlines weren't persisted,
      // so kick off SSE again — the editor will receive streaming outlines.
      (phase === 'review' && needsOutlines);
    if (shouldAutoStart) {
      hasStartedRef.current = true;
      startGeneration();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Main generation flow
  const startGeneration = async (sessionOverride?: GenerationSessionState) => {
    const generationSession = sessionOverride ?? session;
    if (!generationSession) return;

    // Create AbortController for this generation run
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    // Use a local mutable copy so we can update it after document extraction
    let currentSession = generationSession;

    setError(null);
    setCurrentStepIndex(0);

    try {
      // Compute active steps for this session (recomputed after session mutations)
      let activeSteps = getActiveSteps(currentSession);

      // Determine if we need the document analysis step
      const documentSources = resolveSessionDocumentSources(currentSession);
      const hasPdfToAnalyze = documentSources.length > 0 && !currentSession.pdfText;
      // If no document to analyze, skip to the next available step
      if (!hasPdfToAnalyze) {
        const firstNonPdfIdx = activeSteps.findIndex((s) => s.id !== 'pdf-analysis');
        setCurrentStepIndex(Math.max(0, firstNonPdfIdx));
      }

      // Step 0: Extract uploaded course material if needed
      if (hasPdfToAnalyze) {
        log.debug('=== Generation Preview: Extracting course material bundle ===');
        validateDocumentSources(documentSources, t);
        const sortedDocumentSources = [...documentSources].sort((a, b) => a.order - b.order);
        const parsedParts = await Promise.all(
          sortedDocumentSources.map(async (source): Promise<ParsedDocumentPart> => {
            const providerId = source.providerId || currentSession.pdfProviderId;
            const legacySourceConfig = (
              source as SessionDocumentSource & {
                providerConfig?: {
                  apiKey?: string;
                  baseUrl?: string;
                  accessKeyId?: string;
                  accessKeySecret?: string;
                };
              }
            ).providerConfig;
            const providerConfig = currentSession.pdfProviderConfig || legacySourceConfig;
            const documentBlob = await loadDocumentBlob(source.storageKey);
            if (!(documentBlob instanceof Blob) || documentBlob.size === 0) {
              throw new Error(t('generation.courseMaterialLoadFailed'));
            }
            const documentFile = new File([documentBlob], source.name || 'document.pdf', {
              type: source.mimeType || documentBlob.type || 'application/pdf',
            });
            const parseFormData = new FormData();
            parseFormData.append('file', documentFile);
            if (providerId) parseFormData.append('providerId', providerId);
            if (providerConfig?.apiKey?.trim())
              parseFormData.append('apiKey', providerConfig.apiKey);
            if (providerConfig?.baseUrl?.trim())
              parseFormData.append('baseUrl', providerConfig.baseUrl);
            if (providerConfig?.accessKeyId?.trim()) {
              parseFormData.append('accessKeyId', providerConfig.accessKeyId);
            }
            if (providerConfig?.accessKeySecret?.trim()) {
              parseFormData.append('accessKeySecret', providerConfig.accessKeySecret);
            }
            const parseResponse = await fetch('/api/extract-document', {
              method: 'POST',
              body: parseFormData,
              signal,
            });
            if (!parseResponse.ok) throw new Error(t('generation.courseMaterialParseFailed'));
            const parseResult = await parseResponse.json();
            if (!parseResult.success || !parseResult.data) {
              throw new Error(t('generation.courseMaterialParseFailed'));
            }
            const parseData = parseResult.data;
            const rawImages = parseData.metadata?.pdfImages;
            const images = rawImages
              ? rawImages.map((img: ParsedDocumentResponseImage) => ({
                  id: img.id,
                  src: img.src || '',
                  pageNumber: img.pageNumber ?? 1,
                  description: img.description,
                  width: img.width,
                  height: img.height,
                }))
              : ((parseData.images as string[] | undefined) ?? []).map((src, i) => ({
                  id: `img_${i + 1}`,
                  src,
                  pageNumber: 1,
                }));

            return {
              source: {
                id: source.id,
                name: source.name,
                size: source.size,
                lastModified: source.lastModified,
                mimeType: source.mimeType,
                order: source.order,
                providerId,
              },
              text: parseData.text as string,
              rawTextLength: (parseData.text as string).length,
              pageCount: parseData.metadata?.pageCount,
              images,
            };
          }),
        );

        const bundle = buildDocumentBundle(parsedParts);
        const imageStorageIds = await storeImages(bundle.images);

        const pdfImages: PdfImage[] = bundle.images.map((img, i) => ({
          id: img.id,
          src: '',
          pageNumber: img.pageNumber,
          description: img.description,
          width: img.width,
          height: img.height,
          originalId: img.originalId,
          sourceDocumentId: img.sourceDocumentId,
          sourceDocumentName: img.sourceDocumentName,
          sourceDocumentOrder: img.sourceDocumentOrder,
          visionPriority: img.visionPriority,
          storageId: imageStorageIds[i],
        }));

        // Update session with extracted document data
        const updatedSession = {
          ...currentSession,
          documentSources,
          pdfText: bundle.text,
          pdfImages,
          imageStorageIds,
          pdfStorageKey: undefined, // Clear so we don't re-parse
        };
        setSession(updatedSession);
        sessionStorage.setItem('generationSession', JSON.stringify(updatedSession));

        // Truncation warnings
        const warnings: string[] = [];
        if (bundle.totalRawTextLength > bundle.textContentBudget) {
          warnings.push(t('generation.textTruncated', { n: bundle.textContentBudget }));
        }
        if (bundle.totalImageCount > MAX_VISION_IMAGES) {
          warnings.push(
            t('generation.imageTruncated', {
              total: bundle.totalImageCount,
              max: MAX_VISION_IMAGES,
            }),
          );
        }
        if (warnings.length > 0) {
          setTruncationWarnings(warnings);
        }

        // Reassign local reference for subsequent steps
        currentSession = updatedSession;
        activeSteps = getActiveSteps(currentSession);
      }

      // Step: Web Search (if enabled)
      const webSearchStepIdx = activeSteps.findIndex((s) => s.id === 'web-search');
      if (currentSession.requirements.webSearch && webSearchStepIdx >= 0) {
        setCurrentStepIndex(webSearchStepIdx);
        setWebSearchSources([]);

        const wsSettings = useSettingsStore.getState();
        const wsProviderId = wsSettings.webSearchProviderId;
        const wsConfig = wsSettings.webSearchProvidersConfig?.[wsProviderId];
        const res = await fetch('/api/web-search', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(
            withThinkingConfig({
              query: currentSession.requirements.requirement,
              pdfText: currentSession.pdfText || undefined,
              providerId: wsProviderId,
              apiKey: wsConfig?.apiKey || undefined,
              baseUrl: wsProviderId === 'searxng' ? undefined : wsConfig?.baseUrl || undefined,
              baiduSubSources: wsProviderId === 'baidu' ? wsSettings.baiduSubSources : undefined,
              claudeModelId: wsProviderId === 'claude' ? wsConfig?.modelId || undefined : undefined,
            }),
          ),
          signal,
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: 'Web search failed' }));
          throw new Error(data.error || t('generation.webSearchFailed'));
        }

        const searchData = await res.json();
        const sources = (searchData.sources || []).map((s: { title: string; url: string }) => ({
          title: s.title,
          url: s.url,
        }));
        setWebSearchSources(sources);

        const updatedSessionWithSearch = {
          ...currentSession,
          researchContext: searchData.context || '',
          researchSources: sources,
        };
        setSession(updatedSessionWithSearch);
        sessionStorage.setItem('generationSession', JSON.stringify(updatedSessionWithSearch));
        currentSession = updatedSessionWithSearch;
        activeSteps = getActiveSteps(currentSession);
      }

      // Load imageMapping early (needed for both outline and scene generation).
      let imageMapping: ImageMapping = {};
      if (currentSession.imageStorageIds && currentSession.imageStorageIds.length > 0) {
        log.debug('Loading images from IndexedDB');
        imageMapping = await loadImageMapping(currentSession.imageStorageIds);
      } else if (
        currentSession.imageMapping &&
        Object.keys(currentSession.imageMapping).length > 0
      ) {
        log.debug('Using imageMapping from session (old format)');
        imageMapping = currentSession.imageMapping;
      }

      // Create stage client-side
      const stageId = nanoid(10);
      const stage: Stage = {
        id: stageId,
        name: extractTopicFromRequirement(currentSession.requirements.requirement),
        description: '',
        style: 'professional',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        interactiveMode: !!currentSession.requirements.interactiveMode,
        taskEngineMode: currentSession.taskEngineMode === true,
      };

      // ── Generate outlines first (infers languageDirective) ──
      let outlines = currentSession.sceneOutlines;
      let languageDirective = currentSession.languageDirective;
      let courseTitle = currentSession.courseTitle;

      const outlineStepIdx = activeSteps.findIndex((s) => s.id === 'outline');
      setCurrentStepIndex(outlineStepIdx >= 0 ? outlineStepIdx : 0);
      if (!outlines || outlines.length === 0) {
        log.debug('=== Generating outlines (SSE) ===');
        setStreamingOutlines([]);
        setIsOutlineStreaming(true);

        const outlineResult = await new Promise<{
          outlines: SceneOutline[];
          languageDirective: string;
          courseTitle?: string;
          taskEngineMode: boolean;
        }>((resolve, reject) => {
          const collected: SceneOutline[] = [];
          let directive: string | undefined;
          let title: string | undefined;

          fetch('/api/generate/scene-outlines-stream', {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify(
              withThinkingConfig({
                requirements: currentSession.requirements,
                pdfText: currentSession.pdfText,
                pdfImages: currentSession.pdfImages,
                imageMapping,
                researchContext: currentSession.researchContext,
              }),
            ),
            signal,
          })
            .then((res) => {
              if (!res.ok) {
                return res.json().then((d) => {
                  reject(new Error(d.error || t('generation.outlineGenerateFailed')));
                });
              }

              const reader = res.body?.getReader();
              if (!reader) {
                reject(new Error(t('generation.streamNotReadable')));
                return;
              }

              const decoder = new TextDecoder();
              let sseBuffer = '';

              const pump = (): Promise<void> =>
                reader.read().then(({ done, value }) => {
                  if (value) {
                    sseBuffer += decoder.decode(value, { stream: !done });
                    const lines = sseBuffer.split('\n');
                    sseBuffer = lines.pop() || '';

                    for (const line of lines) {
                      if (!line.startsWith('data: ')) continue;
                      try {
                        const evt = JSON.parse(line.slice(6));
                        if (evt.type === 'languageDirective') {
                          directive = evt.data;
                        } else if (evt.type === 'courseTitle') {
                          title = evt.data;
                        } else if (evt.type === 'outline') {
                          collected.push(evt.data);
                          setStreamingOutlines([...collected]);
                        } else if (evt.type === 'retry') {
                          collected.length = 0;
                          // Drop any directive/title latched from the failed
                          // attempt — the server resets these per attempt, so a
                          // succeeding attempt that omits them must fall back, not
                          // inherit the previous attempt's stale values.
                          directive = undefined;
                          title = undefined;
                          setStreamingOutlines([]);
                          setStatusMessage(t('generation.outlineRetrying'));
                        } else if (evt.type === 'done') {
                          directive = evt.languageDirective || directive;
                          resolve({
                            outlines: evt.outlines || collected,
                            languageDirective:
                              directive ||
                              'Teach in the language that matches the user requirement.',
                            courseTitle: evt.courseTitle || title,
                            taskEngineMode: resolveTaskEngineModeFromOutlineDoneEvent(evt),
                          });
                          return;
                        } else if (evt.type === 'error') {
                          reject(new Error(evt.error));
                          return;
                        }
                      } catch (e) {
                        log.error('Failed to parse outline SSE:', line, e);
                      }
                    }
                  }
                  if (done) {
                    if (collected.length > 0) {
                      resolve({
                        outlines: collected,
                        languageDirective:
                          directive || 'Teach in the language that matches the user requirement.',
                        // Carry any title latched from a streaming `courseTitle`
                        // event here too — symmetric with languageDirective — so
                        // a stream that ends without an explicit `done` event
                        // does not silently drop a valid inferred title.
                        courseTitle: title,
                        taskEngineMode: false,
                      });
                    } else {
                      reject(new Error(t('generation.outlineEmptyResponse')));
                    }
                    return;
                  }
                  return pump();
                });

              pump().catch(reject);
            })
            .catch(reject);
        });

        outlines = outlineResult.outlines;
        languageDirective = outlineResult.languageDirective;
        courseTitle = outlineResult.courseTitle;
        const effectiveTaskEngineMode = outlineResult.taskEngineMode;
        setIsOutlineStreaming(false);

        // Mid-stream review intent (sticky ref) overrides the auto-continue timer.
        const userOpenedReviewEarly = outlineReviewIntentRef.current;
        const shouldReviewOutlines =
          useSettingsStore.getState().reviewOutlineEnabled || userOpenedReviewEarly;
        const updatedSession: GenerationSessionState = {
          ...currentSession,
          sceneOutlines: outlines,
          languageDirective,
          courseTitle,
          taskEngineMode: effectiveTaskEngineMode,
          previewPhase: shouldReviewOutlines ? 'review' : 'outline-ready',
        };
        persistSession(updatedSession);
        currentSession = updatedSession;
        setStreamingOutlines(outlines);

        setStatusMessage(shouldReviewOutlines ? '' : t('generation.reviewOutlineAutoContinue'));
        setIsConfirmingOutlines(false);
        outlines = await waitForOutlineReviewChoice(outlines, shouldReviewOutlines, signal);
        clearOutlineReviewTimer();
        currentSession = {
          ...currentSession,
          sceneOutlines: outlines,
          taskEngineMode: effectiveTaskEngineMode,
          previewPhase: 'generating-content',
        };
        persistSession(currentSession);

        // User has committed to course generation (either by confirming the
        // outline review or by letting the auto-continue timer fire). Now it's
        // safe to wipe the homepage draft cache; before this point, "back to
        // requirements" must restore the user's original input.
        try {
          localStorage.removeItem('requirementDraft');
        } catch {
          /* ignore */
        }
      }

      // Move to next step
      setStatusMessage('');
      if (!outlines || outlines.length === 0) {
        throw new Error(t('generation.outlineEmptyResponse'));
      }
      stage.taskEngineMode = currentSession.taskEngineMode === true;

      // Store languageDirective on the stage
      if (languageDirective) {
        stage.languageDirective = languageDirective;
      }

      // Adopt the LLM-inferred course title as the stage name when available,
      // replacing the raw-requirement placeholder set at stage creation time.
      if (courseTitle) {
        stage.name = courseTitle;
      }

      // ── Agent generation (after outlines — uses languageDirective + outlines) ──
      const settings = useSettingsStore.getState();
      let agents: Array<{
        id: string;
        name: string;
        role: string;
        persona?: string;
      }> = [];

      if (settings.agentMode === 'auto') {
        const agentStepIdx = activeSteps.findIndex((s) => s.id === 'agent-generation');
        if (agentStepIdx >= 0) setCurrentStepIndex(agentStepIdx);

        try {
          const allAvatars = [
            {
              path: '/avatars/teacher.png',
              desc: 'Male teacher with glasses, holding a book, green background',
            },
            {
              path: '/avatars/teacher-2.png',
              desc: 'Female teacher with long dark hair, blue traditional outfit, gentle expression',
            },
            {
              path: '/avatars/assist.png',
              desc: 'Young female assistant with glasses, pink background, friendly smile',
            },
            {
              path: '/avatars/assist-2.png',
              desc: 'Young female in orange top and purple overalls, cheerful and approachable',
            },
            {
              path: '/avatars/clown.png',
              desc: 'Energetic girl with glasses pointing up, green shirt, lively and fun',
            },
            {
              path: '/avatars/clown-2.png',
              desc: 'Playful girl with curly hair doing rock gesture, blue shirt, humorous vibe',
            },
            {
              path: '/avatars/curious.png',
              desc: 'Surprised boy with glasses, hand on cheek, curious expression',
            },
            {
              path: '/avatars/curious-2.png',
              desc: 'Boy with backpack holding a book and question mark bubble, inquisitive',
            },
            {
              path: '/avatars/note-taker.png',
              desc: 'Studious boy with glasses, blue shirt, calm and organized',
            },
            {
              path: '/avatars/note-taker-2.png',
              desc: 'Active boy with yellow backpack waving, blue outfit, enthusiastic learner',
            },
            {
              path: '/avatars/thinker.png',
              desc: 'Thoughtful girl with hand on chin, purple background, contemplative',
            },
            {
              path: '/avatars/thinker-2.png',
              desc: 'Girl reading a book intently, long dark hair, intellectual and focused',
            },
          ];

          const getAvailableVoicesForGeneration = () => {
            const providers = getEnabledProvidersWithVoices(
              settings.ttsProvidersConfig,
              voiceProfiles,
            );
            return providers.flatMap((p) =>
              p.voices.map((v) => {
                const cloneModelGroup =
                  p.providerId === 'qwen-tts' && isQwenCloneVoice(v.id)
                    ? p.modelGroups.find((group) =>
                        group.voices.some((groupVoice) => groupVoice.id === v.id),
                      )
                    : undefined;
                const modelId = cloneModelGroup
                  ? resolveTTSModelForVoice(p.providerId, v.id, cloneModelGroup.modelId)
                  : undefined;
                return {
                  providerId: p.providerId,
                  ...(modelId ? { modelId } : {}),
                  voiceId: v.id,
                  voiceName: v.name,
                  voiceLanguage: v.language,
                };
              }),
            );
          };

          // The user's global TTS voice is the narrator voice. Pass it along so
          // the server pins the teacher agent to it instead of letting the LLM
          // pick a different voice. Reuse the same resolution helpers as the
          // advertised list: the model follows the voice, and only clones carry
          // a model on the wire. An unusable global voice (disabled/unconfigured
          // provider) is NOT pinned — the LLM then picks a working advertised
          // voice and the narration fallback machinery stays alive.
          const getNarratorVoiceForGeneration = () =>
            resolveNarratorVoiceForGeneration(
              settings.ttsProviderId,
              settings.ttsVoice,
              settings.ttsProvidersConfig[settings.ttsProviderId],
            );

          const agentResp = await fetch('/api/generate/agent-profiles', {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify(
              withThinkingConfig({
                stageInfo: { name: stage.name, description: stage.description },
                sceneOutlines: outlines.map((o) => ({
                  title: o.title,
                  description: o.description,
                })),
                languageDirective,
                availableAvatars: allAvatars.map((a) => a.path),
                avatarDescriptions: allAvatars.map((a) => ({ path: a.path, desc: a.desc })),
                availableVoices: getAvailableVoicesForGeneration(),
                narratorVoice: getNarratorVoiceForGeneration(),
              }),
            ),
            signal,
          });

          if (!agentResp.ok) throw new Error('Agent generation failed');
          const agentData = await agentResp.json();
          if (!agentData.success) throw new Error(agentData.error || 'Agent generation failed');

          // Embed the roster (including its voice binding) on the stage — it
          // persists with the stage document via saveToStorage below — and
          // mirror it into the in-memory registry. The agent-profile LLM has
          // already bound each agent's voice (from availableVoices); the
          // fallback for an invalid/unavailable voice is applied later at the
          // live TTS call.
          const generatedConfigs = agentData.agents as GeneratedAgentConfig[];
          stage.generatedAgentConfigs = generatedConfigs;
          const { applyGeneratedAgentsToRegistry } =
            await import('@/lib/orchestration/registry/store');
          const savedIds = applyGeneratedAgentsToRegistry(stage.id, generatedConfigs);
          settings.setSelectedAgentIds(savedIds);
          // Stage-derived, not a user choice — must not carry across classrooms.
          settings.setAgentSelectionIsUserSet(false);
          stage.agentIds = savedIds;

          // Show card-reveal modal, continue generation once all cards are revealed
          setGeneratedAgents(agentData.agents);
          setShowAgentReveal(true);
          await new Promise<void>((resolve) => {
            agentRevealResolveRef.current = resolve;
          });

          agents = savedIds
            .map((id) => useAgentRegistry.getState().getAgent(id))
            .filter(Boolean)
            .map((a) => ({
              id: a!.id,
              name: a!.name,
              role: a!.role,
              persona: a!.persona,
            }));
        } catch (err: unknown) {
          log.warn('[Generation] Agent generation failed, falling back to presets:', err);
          const registry = useAgentRegistry.getState();
          const fallbackIds = settings.selectedAgentIds.filter((id) => {
            const a = registry.getAgent(id);
            return a && !a.isGenerated;
          });
          agents = fallbackIds
            .map((id) => registry.getAgent(id))
            .filter(Boolean)
            .map((a) => ({
              id: a!.id,
              name: a!.name,
              role: a!.role,
              persona: a!.persona,
            }));
          stage.agentIds = fallbackIds;
        }
      } else {
        // Preset mode — use selected agents (include persona)
        // Filter out stale generated agent IDs that may linger in settings
        const registry = useAgentRegistry.getState();
        const presetAgentIds = settings.selectedAgentIds.filter((id) => {
          const a = registry.getAgent(id);
          return a && !a.isGenerated;
        });
        agents = presetAgentIds
          .map((id) => registry.getAgent(id))
          .filter(Boolean)
          .map((a) => ({
            id: a!.id,
            name: a!.name,
            role: a!.role,
            persona: a!.persona,
          }));
        stage.agentIds = presetAgentIds;
      }

      // Move to scene generation step
      setStatusMessage('');
      if (!outlines || outlines.length === 0) {
        throw new Error(t('generation.outlineEmptyResponse'));
      }

      // Store stage and outlines
      const store = useStageStore.getState();
      stage.videoManifest = buildVideoManifestFromOutlines(outlines);
      store.setStage(stage);
      store.setOutlines(outlines);

      // Advance to slide-content step
      const contentStepIdx = activeSteps.findIndex((s) => s.id === 'slide-content');
      if (contentStepIdx >= 0) setCurrentStepIndex(contentStepIdx);

      // Build stageInfo and userProfile for API call
      const stageInfo = {
        name: stage.name,
        description: stage.description,
        style: stage.style,
      };

      const userProfile =
        currentSession.requirements.userNickname || currentSession.requirements.userBio
          ? `Student: ${currentSession.requirements.userNickname || 'Unknown'}${currentSession.requirements.userBio ? ` — ${currentSession.requirements.userBio}` : ''}`
          : undefined;

      // Generate ONLY the first scene
      store.setGeneratingOutlines(outlines);

      const firstOutline = outlines[0];

      // Step 2: Generate content (currentStepIndex is already 2)
      const contentData = await fetchSceneContent(
        {
          outline: firstOutline,
          allOutlines: outlines,
          pdfImages: currentSession.pdfImages,
          imageMapping,
          stageInfo,
          stageId: stage.id,
          agents,
          languageDirective,
          requirements: currentSession.requirements,
        },
        signal,
        FOREGROUND_SCENE_RETRY_OPTIONS,
      );

      if (!contentData.success || !contentData.content) {
        throw new Error(sceneGenerationErrorMessage(contentData));
      }

      // Generate actions (activate actions step indicator)
      const actionsStepIdx = activeSteps.findIndex((s) => s.id === 'actions');
      setCurrentStepIndex(actionsStepIdx >= 0 ? actionsStepIdx : currentStepIndex + 1);

      const data = await fetchSceneActions(
        {
          outline: contentData.effectiveOutline || firstOutline,
          allOutlines: outlines,
          content: contentData.content,
          stageId: stage.id,
          agents,
          previousSpeeches: [],
          userProfile,
          languageDirective,
        },
        signal,
        FOREGROUND_SCENE_RETRY_OPTIONS,
      );

      if (!data.success || !data.scene) {
        throw new Error(sceneGenerationErrorMessage(data));
      }
      const firstScene = data.scene;

      // Generate TTS for first scene (part of actions step — blocking)
      if (
        settings.ttsEnabled &&
        settings.ttsProviderId !== 'browser-native-tts' &&
        isTTSProviderEnabled(
          settings.ttsProviderId,
          settings.ttsProvidersConfig?.[settings.ttsProviderId],
        )
      ) {
        const ttsResult = await generateTTSForScene(
          firstScene,
          languageDirective,
          signal,
          FOREGROUND_SCENE_RETRY_OPTIONS,
        );
        if (!ttsResult.success) throw new Error(t('generation.speechFailed'));
      }

      // Add scene to store and navigate
      store.addScene(firstScene);
      store.setCurrentSceneId(firstScene.id);

      // Set remaining outlines as skeleton placeholders
      const remaining = outlines.filter((o) => o.order !== firstScene.order);
      store.setGeneratingOutlines(remaining);

      // Store generation params for classroom to continue generation
      sessionStorage.setItem(
        'generationParams',
        JSON.stringify({
          pdfImages: currentSession.pdfImages,
          agents,
          userProfile,
          languageDirective,
        }),
      );

      sessionStorage.removeItem('generationSession');
      const savedToStorage = await store.saveToStorage();
      if (currentSession.learningTaskId) {
        const linkedTask = updateLearningTask(currentSession.learningTaskId, {
          status: savedToStorage ? 'ready' : 'draft',
          ...(savedToStorage ? { classroomId: stage.id } : {}),
        });
        if (!linkedTask) {
          log.warn('[GenerationPreview] Unable to persist learning task link');
        }
      }
      router.push(`/classroom/${stage.id}`);
    } catch (err) {
      setIsOutlineStreaming(false);
      if (currentSession.learningTaskId) {
        updateLearningTask(currentSession.learningTaskId, { status: 'draft' });
      }
      // AbortError is expected when navigating away — don't show as error
      if (isAbortError(err)) {
        log.info('[GenerationPreview] Generation aborted');
        return;
      }
      sessionStorage.removeItem('generationSession');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const extractTopicFromRequirement = (requirement: string): string => {
    const trimmed = requirement.trim();
    if (trimmed.length <= 500) {
      return trimmed;
    }
    return trimmed.substring(0, 500).trim() + '...';
  };

  const goBackToHome = () => {
    abortControllerRef.current?.abort();
    clearOutlineReviewTimer();
    outlineReviewIntentRef.current = false;
    sessionStorage.removeItem('generationSession');
    if (session?.learningTaskId) {
      updateLearningTask(session.learningTaskId, { status: 'draft' });
      sessionStorage.setItem(LEARNING_TASK_DRAFT_SESSION_KEY, session.learningTaskId);
      router.push('/learn/new');
      return;
    }
    router.push('/');
  };

  // Triggered when the user clicks the streaming outline card mid-stream.
  // SSE keeps running; only the surface morph + intent flag change.
  const handleExpandStreamingOutline = () => {
    if (!session) return;
    clearOutlineReviewTimer();
    setStatusMessage('');
    outlineReviewIntentRef.current = true;
    persistSession({
      ...session,
      previewPhase: 'review',
    });
  };

  // Inverse of expand. Mid-stream: shrink back to the streaming preview card so
  // the user can keep watching while SSE fills in the rest. Post-stream: shrink
  // back to the small card too, then re-arm the 2.5s auto-continue timer — same
  // pacing as the no-review path so the user has a beat to see the card before
  // the page advances. Jumping straight to content gen feels too abrupt.
  const handleCollapseEditor = () => {
    if (!session) return;
    if (isOutlineStreaming) {
      // Intentionally drop the review-intent flag: collapsing mid-stream is the
      // user saying "actually, never mind". When SSE finishes, the no-early-open
      // path runs and the standard `reviewOutlineEnabled` / auto-continue rules
      // decide what happens next. There is no parked promise to settle yet —
      // the promise is created only after SSE completes (see line 583).
      outlineReviewIntentRef.current = false;
      persistSession({ ...session, previewPhase: 'preparing' });
      setStatusMessage('');
      return;
    }
    const collapsedOutlines = session.sceneOutlines ?? streamingOutlines;
    if (!collapsedOutlines || collapsedOutlines.length === 0) return;
    outlineReviewIntentRef.current = false;
    persistSession({
      ...session,
      sceneOutlines: collapsedOutlines,
      previewPhase: 'outline-ready',
    });
    setStatusMessage(t('generation.reviewOutlineAutoContinue'));

    // Re-arm the auto-continue timer. The SSE-completion flow is parked inside
    // `waitForOutlineReviewChoice` (because `shouldReview` was true when the
    // user opened the editor) — fire its resolve via a fresh timeout to match
    // the no-review path's pacing.
    clearOutlineReviewTimer();
    outlineReviewTimerRef.current = setTimeout(() => {
      outlineReviewTimerRef.current = null;
      const resolve = outlineReviewResolveRef.current;
      outlineReviewResolveRef.current = null;
      if (resolve) {
        resolve(collapsedOutlines);
        return;
      }
      // No parked promise (e.g. session was restored from a refresh into
      // 'review' state). Drive the transition ourselves.
      const confirmedSession: GenerationSessionState = {
        ...session,
        sceneOutlines: collapsedOutlines,
        previewPhase: 'generating-content',
      };
      persistSession(confirmedSession);
      hasStartedRef.current = true;
      void startGeneration(confirmedSession);
    }, OUTLINE_REVIEW_AUTO_CONTINUE_MS);
  };

  const handleOutlinesChange = (outlines: SceneOutline[]) => {
    if (!session) return;
    // Streaming SSE owns `streamingOutlines` while it's running; ignore editor
    // changes until the stream completes (the editor is read-only in that state
    // anyway, but guard defensively against any racy event).
    if (isOutlineStreaming) return;
    persistSession({
      ...session,
      sceneOutlines: outlines,
      previewPhase: 'review',
    });
  };

  const handleConfirmOutlines = () => {
    const finalOutlines = session?.sceneOutlines ?? streamingOutlines;
    if (!finalOutlines || finalOutlines.length === 0) return;
    setIsConfirmingOutlines(true);
    clearOutlineReviewTimer();
    outlineReviewIntentRef.current = false;

    if (outlineReviewResolveRef.current) {
      const resolve = outlineReviewResolveRef.current;
      outlineReviewResolveRef.current = null;
      resolve(finalOutlines);
      return;
    }

    // Fallback: no parked promise (session restored mid-review). The button's
    // loading state was set above to give the click immediate feedback, but the
    // editor is about to unmount anyway as we drive the next phase ourselves.
    // Reset the flag so the state doesn't linger if `startGeneration` later
    // re-renders the editor for any reason.
    setIsConfirmingOutlines(false);
    const confirmedSession: GenerationSessionState = {
      ...(session as GenerationSessionState),
      sceneOutlines: finalOutlines,
      previewPhase: 'generating-content',
    };
    persistSession(confirmedSession);
    hasStartedRef.current = true;
    void startGeneration(confirmedSession);
  };

  // Still loading session from sessionStorage
  if (!sessionLoaded) {
    return (
      <div
        className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-hidden bg-background p-4"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,color-mix(in_oklab,var(--primary)_12%,transparent),transparent_42%)]" />
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative flex w-full max-w-sm flex-col items-center rounded-[28px] border border-border/70 bg-card/85 px-8 py-10 text-center shadow-[0_28px_80px_-48px_rgba(16,42,67,0.65)] backdrop-blur-xl"
        >
          <img
            src={resolvedTheme === 'dark' ? brand.darkLogoSrc : brand.logoSrc}
            alt={brand.productName}
            className="h-9 w-auto"
          />
          <div className="relative mt-8 flex size-16 items-center justify-center">
            <div className="absolute inset-0 animate-ping rounded-2xl bg-primary/10" />
            <div className="relative flex size-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
              <Sparkles className="size-6 animate-pulse" aria-hidden="true" />
            </div>
          </div>
          <p className="mt-6 text-base font-semibold text-foreground">{t('common.loading')}</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {locale === 'zh-CN'
              ? '正在恢复课程方案，请稍候'
              : 'Restoring your course plan. This will only take a moment.'}
          </p>
          <div className="mt-7 flex items-center gap-2" aria-hidden="true">
            {[0, 1, 2].map((item) => (
              <motion.span
                key={item}
                animate={{ opacity: [0.25, 1, 0.25], scale: [0.85, 1, 0.85] }}
                transition={{ duration: 1.2, repeat: Infinity, delay: item * 0.16 }}
                className="size-1.5 rounded-full bg-primary"
              />
            ))}
          </div>
        </motion.div>
      </div>
    );
  }

  // No session found
  if (!session) {
    return (
      <div className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-hidden bg-background p-4">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,color-mix(in_oklab,var(--primary)_10%,transparent),transparent_42%)]" />
        <Card className="relative w-full max-w-md rounded-[28px] border-border/70 bg-card/90 p-8 shadow-[0_28px_80px_-48px_rgba(16,42,67,0.65)] backdrop-blur-xl">
          <div className="flex flex-col items-center text-center">
            <img
              src={resolvedTheme === 'dark' ? brand.darkLogoSrc : brand.logoSrc}
              alt={brand.productName}
              className="h-8 w-auto"
            />
            <span className="mt-8 flex size-16 items-center justify-center rounded-2xl border border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <AlertCircle className="size-7" aria-hidden="true" />
            </span>
            <h2 className="mt-5 text-xl font-semibold">{t('generation.sessionNotFound')}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t('generation.sessionNotFoundDesc')}
            </p>
            <Button onClick={() => router.push('/')} className="mt-7 w-full">
              <ArrowLeft className="mr-2 size-4" />
              {t('generation.backToHome')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const activeStep =
    activeSteps.length > 0
      ? activeSteps[Math.min(currentStepIndex, activeSteps.length - 1)]
      : ALL_STEPS[0];
  const activeStepText = getGenerationStepText(activeStep, session);

  if (isReviewingOutlines) {
    // Editor source-of-truth: prefer the persisted final list; fall back to the
    // live streaming buffer so the editor can render mid-stream after expansion.
    const editorOutlines = session.sceneOutlines ?? streamingOutlines ?? [];

    return (
      <div className="relative flex min-h-[100dvh] w-full flex-col items-center overflow-x-hidden bg-background">
        <header className="sticky top-0 z-30 w-full border-b border-border/70 bg-background/90 backdrop-blur-xl">
          <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 md:px-8">
            <img
              src={resolvedTheme === 'dark' ? brand.darkLogoSrc : brand.logoSrc}
              alt={brand.productName}
              className="h-8 w-auto"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={goBackToHome}
              disabled={isConfirmingOutlines}
            >
              <ArrowLeft className="mr-2 size-4" />
              {t('generation.backToHome')}
            </Button>
          </div>
        </header>

        <div className="z-10 w-full max-w-4xl px-4 pb-10 pt-10 md:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            <div className="max-w-2xl space-y-2">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                {locale === 'zh-CN' ? '课程方案 · 第二步' : 'Course plan · Step 2'}
              </div>
              <h1 className="text-3xl font-semibold tracking-tight">
                {t('generation.reviewOutlineTitle')}
              </h1>
              <p className="text-muted-foreground text-sm md:text-base">
                {isOutlineStreaming
                  ? t('generation.reviewOutlineStreamingDesc')
                  : t('generation.reviewOutlineDesc')}
              </p>
            </div>

            <CoursePlanStepBar locale={locale} />

            <CoursePlanOverview
              locale={locale}
              title={session.courseTitle}
              outlines={editorOutlines}
              materialCount={session.documentSources?.length ?? 0}
            />

            {error && (
              <div className="mx-auto max-w-2xl rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <OutlinesEditor
              outlines={editorOutlines}
              onChange={handleOutlinesChange}
              onConfirm={handleConfirmOutlines}
              onBack={goBackToHome}
              alwaysReview={reviewOutlineEnabled}
              onAlwaysReviewChange={setReviewOutlineEnabled}
              isLoading={isConfirmingOutlines}
              isStreaming={isOutlineStreaming}
              onCollapse={handleCollapseEditor}
            />
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-[100dvh] w-full flex-col items-center overflow-x-hidden bg-background">
      <div className="pointer-events-none absolute inset-x-0 top-16 h-[440px] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--primary)_7%,var(--background))_0%,var(--background)_100%)]">
        <div className="absolute inset-0 opacity-[0.035] [background-image:linear-gradient(to_right,currentColor_1px,transparent_1px),linear-gradient(to_bottom,currentColor_1px,transparent_1px)] [background-size:32px_32px]" />
      </div>

      <header className="sticky top-0 z-30 w-full border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 md:px-8">
          <img
            src={resolvedTheme === 'dark' ? brand.darkLogoSrc : brand.logoSrc}
            alt={brand.productName}
            className="h-8 w-auto"
          />
          <Button variant="ghost" size="sm" onClick={goBackToHome}>
            <ArrowLeft className="mr-2 size-4" />
            {t('generation.backToHome')}
          </Button>
        </div>
      </header>

      <main className="relative z-10 grid w-full max-w-6xl grid-cols-1 gap-6 px-4 pb-12 pt-10 md:px-8 lg:grid-cols-12">
        <motion.aside
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.45 }}
          className="lg:col-span-4"
        >
          <div className="rounded-[28px] border border-border/70 bg-card/75 p-5 shadow-[0_22px_60px_-48px_color-mix(in_srgb,var(--primary)_48%,transparent)] backdrop-blur-sm lg:sticky lg:top-24">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
              {locale === 'zh-CN' ? '课程方案生成' : 'Course plan generation'}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-foreground">
              {session.courseTitle ||
                (locale === 'zh-CN' ? '正在构建你的互动课程' : 'Building your interactive course')}
            </h1>
            <div className="mt-5 rounded-2xl border border-primary/10 bg-background/65 p-4">
              <p className="text-xs font-medium text-muted-foreground">
                {locale === 'zh-CN' ? '课程需求' : 'Course request'}
              </p>
              <p className="mt-2 line-clamp-4 text-sm leading-6 text-foreground/80">
                {session.requirements.requirement}
              </p>
            </div>

            <div className="mt-7 border-t border-border/60 pt-5">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">
                  {locale === 'zh-CN' ? '构建路径' : 'Build path'}
                </span>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-primary">
                  {Math.min(currentStepIndex + 1, activeSteps.length)}/{activeSteps.length}
                </span>
              </div>
              <ol className="space-y-1.5">
                {activeSteps.map((step, idx) => {
                  const StepIcon = step.icon;
                  const completed = idx < currentStepIndex;
                  const active = idx === currentStepIndex;
                  const stepText = getGenerationStepText(step, session);
                  return (
                    <li
                      key={step.id}
                      className={cn(
                        'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-all',
                        active && 'border-primary/20 bg-primary/10 text-primary shadow-sm',
                        completed && 'border-transparent bg-accent/45 text-foreground',
                        !active && !completed && 'border-transparent text-muted-foreground',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-8 shrink-0 items-center justify-center rounded-lg border',
                          completed && 'border-primary/15 bg-primary text-primary-foreground',
                          active && 'border-primary/25 bg-card text-primary shadow-sm',
                          !active && !completed && 'border-border bg-background/70',
                        )}
                      >
                        {completed ? (
                          <CheckCircle2 className="size-4" />
                        ) : (
                          <StepIcon className="size-4" />
                        )}
                      </span>
                      <span className={cn(active && 'font-semibold')}>
                        {t(stepText.title, stepText.titleValues)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        </motion.aside>

        <section className="flex min-w-0 flex-col items-center lg:col-span-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="w-full"
          >
            <Card className="relative flex min-h-[520px] flex-col items-center justify-center overflow-hidden rounded-[28px] border-primary/15 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--card)_96%,var(--primary)_4%),var(--card))] p-8 text-center shadow-[0_28px_76px_-46px_color-mix(in_srgb,var(--primary)_46%,transparent)] md:p-12">
              <div className="absolute left-6 top-6 rounded-full border border-primary/15 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary">
                {locale === 'zh-CN' ? '方案构建进度' : 'Plan progress'} ·{' '}
                {Math.min(currentStepIndex + 1, activeSteps.length)}/{activeSteps.length}
              </div>

              {/* Central Content */}
              <div className="flex-1 flex flex-col items-center justify-center w-full space-y-8 mt-4">
                {/* Icon / Visualizer Container */}
                <div className="relative size-48 flex items-center justify-center">
                  <AnimatePresence mode="popLayout">
                    {error ? (
                      <motion.div
                        key="error"
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="size-32 rounded-full bg-red-500/10 flex items-center justify-center border-2 border-red-500/20"
                      >
                        <AlertCircle className="size-16 text-red-500" />
                      </motion.div>
                    ) : isComplete ? (
                      <motion.div
                        key="complete"
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="size-32 rounded-full bg-green-500/10 flex items-center justify-center border-2 border-green-500/20"
                      >
                        <CheckCircle2 className="size-16 text-green-500" />
                      </motion.div>
                    ) : (
                      <motion.div
                        key={activeStep.id}
                        initial={{ scale: 0.8, opacity: 0, filter: 'blur(10px)' }}
                        animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                        exit={{ scale: 1.2, opacity: 0, filter: 'blur(10px)' }}
                        transition={{ duration: 0.4 }}
                        className="absolute inset-0 flex items-center justify-center"
                      >
                        <StepVisualizer
                          stepId={activeStep.id}
                          outlines={session.sceneOutlines ?? streamingOutlines}
                          webSearchSources={webSearchSources}
                          onExpandOutline={
                            activeStep.id === 'outline' ? handleExpandStreamingOutline : undefined
                          }
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Text Content */}
                <div className="space-y-3 max-w-sm mx-auto">
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={error ? 'error' : isComplete ? 'done' : activeStep.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="space-y-2"
                    >
                      <h2 className="text-2xl font-bold tracking-tight">
                        {error
                          ? t('generation.generationFailed')
                          : isComplete
                            ? t('generation.generationComplete')
                            : t(activeStepText.title, activeStepText.titleValues)}
                      </h2>
                      <p className="text-muted-foreground text-base">
                        {error
                          ? error
                          : isComplete
                            ? t('generation.classroomReady')
                            : statusMessage || t(activeStepText.description)}
                      </p>
                    </motion.div>
                  </AnimatePresence>

                  {/* Truncation warning indicator */}
                  <AnimatePresence>
                    {truncationWarnings.length > 0 && !error && !isComplete && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0 }}
                        transition={{
                          type: 'spring',
                          stiffness: 500,
                          damping: 30,
                        }}
                        className="flex justify-center"
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <motion.button
                              type="button"
                              animate={{
                                boxShadow: [
                                  '0 0 0 0 rgba(251, 191, 36, 0), 0 0 0 0 rgba(251, 191, 36, 0)',
                                  '0 0 16px 4px rgba(251, 191, 36, 0.12), 0 0 4px 1px rgba(251, 191, 36, 0.08)',
                                  '0 0 0 0 rgba(251, 191, 36, 0), 0 0 0 0 rgba(251, 191, 36, 0)',
                                ],
                              }}
                              transition={{
                                duration: 3,
                                repeat: Infinity,
                                ease: 'easeInOut',
                              }}
                              className="relative size-7 rounded-full flex items-center justify-center cursor-default
                                       bg-gradient-to-br from-amber-400/15 to-orange-400/10
                                       border border-amber-400/25 hover:border-amber-400/40
                                       hover:from-amber-400/20 hover:to-orange-400/15
                                       transition-colors duration-300
                                       focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/30"
                            >
                              <AlertTriangle
                                className="size-3.5 text-amber-500 dark:text-amber-400"
                                strokeWidth={2.5}
                              />
                            </motion.button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            <div className="space-y-1 py-0.5">
                              {truncationWarnings.map((w, i) => (
                                <p key={i} className="text-xs leading-relaxed">
                                  {w}
                                </p>
                              ))}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </Card>
          </motion.div>

          {/* Footer Action */}
          <div className="flex h-16 w-full items-center justify-center">
            <AnimatePresence>
              {error ? (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="w-full max-w-xs"
                >
                  <Button
                    size="lg"
                    variant="outline"
                    className="w-full h-12"
                    onClick={goBackToHome}
                  >
                    {t('generation.goBackAndRetry')}
                  </Button>
                </motion.div>
              ) : isOutlineReady ? null : !isComplete ? (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-center gap-3 text-sm text-muted-foreground/50 font-medium uppercase tracking-widest"
                >
                  <Sparkles className="size-3 animate-pulse" />
                  {t('generation.aiWorking')}
                  {generatedAgents.length > 0 && !showAgentReveal && (
                    <button
                      onClick={() => setShowAgentReveal(true)}
                      className="ml-2 flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-medium normal-case tracking-normal text-accent transition-colors hover:bg-accent/20"
                    >
                      <Bot className="size-3" />
                      {t('generation.viewAgents')}
                    </button>
                  )}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </section>
      </main>

      {/* Agent Reveal Modal */}
      <AgentRevealModal
        agents={generatedAgents}
        open={showAgentReveal}
        onClose={() => setShowAgentReveal(false)}
        onAllRevealed={() => {
          agentRevealResolveRef.current?.();
          agentRevealResolveRef.current = null;
        }}
      />
    </div>
  );
}

export default function GenerationPreviewPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[100dvh] w-full items-center justify-center bg-background">
          <div className="animate-pulse space-y-4 text-center">
            <div className="h-8 w-48 bg-muted rounded mx-auto" />
            <div className="h-4 w-64 bg-muted rounded mx-auto" />
          </div>
        </div>
      }
    >
      <GenerationPreviewContent />
    </Suspense>
  );
}
