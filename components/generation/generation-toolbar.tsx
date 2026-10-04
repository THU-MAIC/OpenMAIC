'use client';

import { useState, useRef, useMemo, useEffect } from 'react';
import {
  AlertCircle,
  Bot,
  Check,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Loader2,
  Paperclip,
  Presentation,
  RotateCw,
  X,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { SettingsSection } from '@/lib/types/settings';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { toast } from 'sonner';
import { findSlot, type ModelSettingsChange } from '@/lib/model-settings/client';
import {
  courseGenerationUsable,
  effectiveTarget,
  modelCapabilities,
} from '@/lib/model-settings/capabilities';
import { assignmentRefs, modelChange, modelRef, providerLabel } from '@/lib/model-settings/edit';
import { serviceEntries, slotThinking, thinkingChange } from '@/lib/model-settings/services';
import { canChangeDefaultModel, settingsSections, slotEditable } from '@/lib/model-settings/shape';
import { useModelSettingsView } from '@/lib/model-settings/use-model-settings';
import { modelSettingsClient } from '@/lib/model-settings/client';
import {
  getAcceptStringForProviders,
  getFormatLabelsForProviders,
  isMimeSupportedByProviders,
} from '@/lib/document/mime';
import { MAX_DOCUMENT_BUNDLE_FILES } from '@/lib/document/bundle';
import {
  combinedTruncation,
  type CourseMaterialEntry,
  type CourseMaterialMessage,
} from '@/lib/generation-run-client/use-course-materials';
import { ModelPicker } from '@/components/settings/model-picker';
import { useLLMPickerGroups } from '@/components/settings/use-llm-picker-groups';

// ─── Constants ───────────────────────────────────────────────
const MAX_COURSE_MATERIAL_SIZE_MB = 50;

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The formats the active extractors accept, as a localized list ("PDF, TXT,
 * MD"). The format labels are file-type names shared by every locale; only
 * the separator is localized.
 */
export function courseMaterialFormatList(t: Translate, providerIds: readonly string[]): string {
  return getFormatLabelsForProviders(providerIds).join(t('upload.formatListSeparator'));
}

/** The "this file type is unsupported" message, naming the extractor and what it accepts. */
export function unsupportedCourseMaterialMessage(
  t: Translate,
  extractorName: string,
  providerIds: readonly string[],
): string {
  return t('upload.unsupportedCourseMaterial', {
    parser: extractorName,
    formats: courseMaterialFormatList(t, providerIds),
  });
}

// ─── Types ───────────────────────────────────────────────────
export interface GenerationToolbarProps {
  /** The attached materials, each uploading, extracting, ready or failed. */
  courseMaterials: CourseMaterialEntry[];
  /** Attach files (the parent checks them against the server's policy and uploads them). */
  onCourseMaterialsAdd: (files: File[]) => void;
  onCourseMaterialRemove: (id: string) => void;
  /** Upload or extract a failed material again. */
  onCourseMaterialRetry?: (id: string) => void;
  onPdfError: (error: string | null) => void;
  /**
   * When set, the course-material add/remove/Retry affordances and the
   * extractor Select are all disabled (the parent freezes the material set
   * while it starts a run). The parent's handlers are inert under the same
   * flag; this only mirrors it in the UI.
   */
  materialsLocked?: boolean;
  /**
   * Open the settings dialog at a section. Backs the "Set up model" CTA shown
   * when no usable LLM provider exists (#580: the homepage must never dead-end).
   */
  onSettingsOpen?: (section: SettingsSection) => void;
}

// ─── Component ───────────────────────────────────────────────
export function GenerationToolbar({
  courseMaterials,
  onCourseMaterialsAdd,
  onCourseMaterialRemove,
  onCourseMaterialRetry,
  onPdfError,
  materialsLocked = false,
  onSettingsOpen,
}: GenerationToolbarProps) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // The workspace's model settings (the server's view): the llm root is the
  // course model, the document slot the extractor.
  const view = useModelSettingsView();
  const llmSlot = view ? findSlot(view, 'llm') : undefined;
  const llm = effectiveTarget(view, 'llm');
  const providerId = llm?.providerId ?? '';
  const modelId = llm?.modelId ?? '';
  const llmPickerGroups = useLLMPickerGroups(view);
  const currentProviderName = view && providerId ? providerLabel(view, providerId) : providerId;
  // A shortcut for the default model: not rendered at all where it cannot change it.
  const llmEditable = !!view && canChangeDefaultModel(view);
  // Where the settings can still set up a language model, if anywhere.
  const sections = view ? settingsSections(view) : null;
  const setupSection: SettingsSection | undefined = !sections
    ? undefined
    : sections.modelServices.includes('chat')
      ? 'model-services'
      : slotEditable(llmSlot)
        ? 'course-models'
        : undefined;
  const applyChange = async (change: ModelSettingsChange | undefined) => {
    if (!change) return;
    const result = await modelSettingsClient.apply(change);
    if (!result.ok) toast.error(t('toolbar.modelChangeFailed', { message: result.message }));
  };
  const selectModel = (pid: string, mid: string) =>
    llmSlot && applyChange(modelChange(llmSlot, modelRef(pid, mid)));

  // The extractor is the document slot: the workspace's document services
  // (and the built-in ones, which need no key) are offered.
  const documentSlot = view ? findSlot(view, 'document') : undefined;
  const documentTarget = effectiveTarget(view, 'document');
  const documentProviderId = (documentTarget?.registryId ?? 'unpdf') as PDFProviderId;
  const documentEntries = useMemo(
    () =>
      view
        ? serviceEntries(view, 'document', Object.keys(PDF_PROVIDERS)).filter(
            (entry) =>
              entry.state === 'deployment' ||
              entry.state === 'workspace' ||
              (entry.state === 'available' &&
                !PDF_PROVIDERS[entry.registryId as PDFProviderId]?.requiresApiKey),
          )
        : [],
    [view],
  );
  const selectExtractor = async (entryId: string) => {
    const entry = documentEntries.find((item) => item.id === entryId);
    if (!entry || !view) return;
    let current = view;
    if (!entry.provider && entry.preset) {
      const added = await modelSettingsClient.apply(
        { kind: 'provider', id: entry.id, preset: entry.preset.id },
        view,
      );
      if (!added.ok) {
        toast.error(t('toolbar.modelChangeFailed', { message: added.message }));
        return;
      }
      current = added.view;
    }
    const slot = findSlot(current, 'document');
    if (slot) {
      const result = await modelSettingsClient.apply(modelChange(slot, entry.id), current);
      if (!result.ok) toast.error(t('toolbar.modelChangeFailed', { message: result.message }));
    }
  };

  // Course material handler. `plain-text` is always active alongside the
  // workspace's extractor so txt/md files remain uploadable without
  // configuring an external service.
  const activeDocumentProviderIds = useMemo(
    () => [documentProviderId, 'plain-text'] as const,
    [documentProviderId],
  );
  const acceptForCurrentProvider = useMemo(
    () => getAcceptStringForProviders(activeDocumentProviderIds),
    [activeDocumentProviderIds],
  );
  const extractorName = PDF_PROVIDERS[documentProviderId]?.name ?? documentProviderId;
  const unsupportedMessage = () =>
    unsupportedCourseMaterialMessage(t, extractorName, activeDocumentProviderIds);

  // If the user switches to a provider that doesn't support already attached
  // materials, drop only the incompatible files so the eventual extraction
  // request matches the current provider capability.
  useEffect(() => {
    const unsupportedMaterials = courseMaterials.filter(
      (file) =>
        !isMimeSupportedByProviders(
          { mimeType: file.type, fileName: file.name },
          activeDocumentProviderIds,
        ),
    );
    if (unsupportedMaterials.length === 0) return;

    for (const file of unsupportedMaterials) {
      onCourseMaterialRemove(file.id);
    }
    onPdfError(unsupportedMessage());
    // Intentionally omit callbacks/t from deps: adding them would re-run this
    // provider capability cleanup on unrelated parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocumentProviderIds, courseMaterials]);

  const handleFilesSelect = (incomingFiles: File[]) => {
    // Belt-and-braces mirror of the parent's freeze guard: while generate-prep
    // is running the material set must not change, whatever the UI state says.
    if (materialsLocked) return;
    const supportedFiles = incomingFiles.filter((file) =>
      isMimeSupportedByProviders(
        { mimeType: file.type, fileName: file.name },
        activeDocumentProviderIds,
      ),
    );
    if (supportedFiles.length !== incomingFiles.length) {
      onPdfError(unsupportedMessage());
      return;
    }
    // The size and count limits are the server's, checked as they are attached.
    onPdfError(null);
    onCourseMaterialsAdd(supportedFiles);
  };

  // What the ready materials leave out together, beyond what each does alone.
  const combined = useMemo(
    () => combinedTruncation([...courseMaterials].sort((a, b) => a.order - b.order)),
    [courseMaterials],
  );

  // ─── Pill button helper ─────────────────────────────
  const pillCls =
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all cursor-pointer select-none whitespace-nowrap border';
  const pillMuted = `${pillCls} border-border/50 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60`;
  const pillActive = `${pillCls} border-violet-200/60 dark:border-violet-700/50 bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300`;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {/* ── Course model: pill (picker popover), or Set-up CTA (#580) ── */}
      {llmEditable ? (
        // Editable: the picker, with nothing selected while `llm` resolves to
        // nothing (no default model); picking a model sets the llm slot, which
        // every slot that follows it (the course stages, the classroom, the
        // agents) then uses.
        <ModelPicker
          note={t('toolbar.defaultModelNote')}
          groups={llmPickerGroups}
          value={providerId && modelId ? { providerId, modelId } : null}
          onSelect={(pid, mid) => void selectModel(pid, mid)}
          thinkingConfig={slotThinking(llmSlot)}
          onThinkingChange={
            llmSlot && assignmentRefs(llmSlot.assignment).model
              ? (config) => void applyChange(thinkingChange(llmSlot, config))
              : undefined
          }
          placeholder={t('toolbar.pickModel')}
          ariaLabel={llm ? `${currentProviderName} / ${modelId}` : t('toolbar.pickModel')}
          className="h-8 w-auto max-w-[260px] gap-1.5 rounded-full px-2.5 text-xs"
          t={t}
        />
      ) : (
        view &&
        !courseGenerationUsable(modelCapabilities(view)) &&
        onSettingsOpen &&
        setupSection && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onSettingsOpen(setupSection)}
                className={cn(
                  pillCls,
                  'text-amber-600 dark:text-amber-400 animate-pulse',
                  'bg-amber-50 dark:bg-amber-950/30 hover:bg-amber-100 dark:hover:bg-amber-950/50',
                )}
              >
                <Bot className="size-3.5" />
                <span>{t('toolbar.configureProvider')}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('toolbar.configureProviderHint')}</TooltipContent>
          </Tooltip>
        )
      )}

      {/* ── Course material (extractor + upload) combined Popover ── */}
      <Popover>
        <PopoverTrigger asChild>
          {courseMaterials.length > 0 ? (
            <button className={pillActive} data-testid="course-material-pill">
              {courseMaterials.some((item) => item.status === 'failed') ? (
                <AlertCircle className="size-3.5 text-destructive" />
              ) : courseMaterials.some(
                  (item) => item.status === 'uploading' || item.status === 'extracting',
                ) ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Paperclip className="size-3.5" />
              )}
              <span className="max-w-[140px] truncate">
                {courseMaterials.length === 1
                  ? courseMaterials[0].name
                  : t('toolbar.courseMaterialsSelected', { n: courseMaterials.length })}
              </span>
            </button>
          ) : (
            <button className={pillMuted}>
              <Paperclip className="size-3.5" />
            </button>
          )}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="max-h-[calc(var(--radix-popover-content-available-height)-8px)] w-72 overflow-y-auto p-0"
        >
          {/* Extractor selector: the workspace's document slot */}
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            <span className="text-xs font-medium text-muted-foreground shrink-0">
              {t('toolbar.documentExtractor')}
            </span>
            <Select
              value={documentTarget?.providerId ?? ''}
              onValueChange={(v) => void selectExtractor(v)}
              disabled={materialsLocked || !documentSlot || documentSlot.locked}
            >
              <SelectTrigger className="h-7 text-xs flex-1 min-w-0">
                <SelectValue placeholder={PDF_PROVIDERS.unpdf?.name ?? 'unpdf'} />
              </SelectTrigger>
              <SelectContent>
                {documentEntries.map((entry) => {
                  const provider = PDF_PROVIDERS[entry.registryId as PDFProviderId];
                  return (
                    <SelectItem key={entry.id} value={entry.id}>
                      <div className="flex items-center gap-1.5">
                        {provider?.icon && (
                          <img src={provider.icon} alt={provider.name} className="w-3.5 h-3.5" />
                        )}
                        {provider?.name ?? entry.id}
                        {entry.state === 'deployment' && (
                          <span className="text-[9px] px-1 py-0 rounded border text-muted-foreground">
                            {t('settings.serverConfigured')}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Upload area / file info */}
          <div className="px-3 pb-3">
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept={acceptForCurrentProvider}
              multiple
              disabled={materialsLocked}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) handleFilesSelect(files);
                e.target.value = '';
              }}
            />
            <div className="space-y-3">
              <div
                className={cn(
                  'flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 transition-colors',
                  isDragging
                    ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/20'
                    : 'border-muted-foreground/20 hover:border-violet-300',
                  materialsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                )}
                onClick={() => {
                  if (!materialsLocked) fileInputRef.current?.click();
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!materialsLocked) setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  if (materialsLocked) return;
                  const files = Array.from(e.dataTransfer.files ?? []);
                  if (files.length > 0) handleFilesSelect(files);
                }}
              >
                <Paperclip className="size-5 text-muted-foreground/50 mb-1.5" />
                <p className="text-xs font-medium">{t('toolbar.courseMaterialUpload')}</p>
                <p className="text-[10px] text-muted-foreground/70 mt-0.5 text-center">
                  {t('upload.courseMaterialFormats', {
                    formats: courseMaterialFormatList(t, activeDocumentProviderIds),
                    size: MAX_COURSE_MATERIAL_SIZE_MB,
                  })}
                </p>
                <p className="text-[10px] text-muted-foreground/70 text-center">
                  {t('upload.courseMaterialCountLimit', { n: MAX_DOCUMENT_BUNDLE_FILES })}
                </p>
              </div>

              {courseMaterials.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] text-muted-foreground/70">
                    {t('toolbar.courseMaterialMergeOrder')}
                  </p>
                  <div className="max-h-60 space-y-1.5 overflow-y-auto">
                    {[...courseMaterials]
                      .sort((a, b) => a.order - b.order)
                      .map((file) => (
                        <CourseMaterialChip
                          key={file.id}
                          material={file}
                          locked={materialsLocked}
                          onRemove={() => onCourseMaterialRemove(file.id)}
                          onRetry={() => onCourseMaterialRetry?.(file.id)}
                        />
                      ))}
                  </div>
                  {combined && (
                    <div className="space-y-0.5" data-testid="course-material-combined-truncation">
                      {truncationNotices(t, combined).map((notice) => (
                        <p key={notice} className="text-[10px] text-amber-600 dark:text-amber-400">
                          {notice}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** The notices of what generation leaves out of a material (or of all of them together). */
function truncationNotices(
  t: Translate,
  truncated: { textChars?: number; images?: { total: number; max: number } },
): string[] {
  return [
    ...(truncated.textChars !== undefined
      ? [t('generation.textTruncated', { n: truncated.textChars })]
      : []),
    ...(truncated.images
      ? [
          t('generation.imageTruncated', {
            total: truncated.images.total,
            max: truncated.images.max,
          }),
        ]
      : []),
  ];
}

function materialMessageText(t: Translate, message: CourseMaterialMessage | undefined): string {
  if (!message) return '';
  return message.text ?? (message.key ? t(message.key, message.values) : '');
}

/** A file-type icon for a material, by its kind, MIME type and extension. */
function MaterialTypeIcon({ material }: { material: CourseMaterialEntry }) {
  const mime = material.mime ?? material.type;
  const extension = material.name.split('.').pop()?.toLowerCase() ?? '';
  const className = 'size-3.5';
  if (material.mediaKind === 'media') {
    return mime.startsWith('video/') ? (
      <FileVideo className={className} />
    ) : (
      <FileAudio className={className} />
    );
  }
  if (mime.startsWith('image/')) return <FileImage className={className} />;
  if (['ppt', 'pptx', 'key', 'odp'].includes(extension)) {
    return <Presentation className={className} />;
  }
  if (['xls', 'xlsx', 'csv', 'ods'].includes(extension)) {
    return <FileSpreadsheet className={className} />;
  }
  return <FileText className={className} />;
}

/** A file size as the material row shows it (one decimal in MB; KB below 1 MB). */
function materialSizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** One attached material: its upload, its extraction, and what generation leaves out of it. */
export function CourseMaterialChip({
  material,
  locked,
  onRemove,
  onRetry,
}: {
  material: CourseMaterialEntry;
  locked: boolean;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const media = material.mediaKind === 'media';
  const failed = material.status === 'failed';
  const percent = Math.round(material.progress * 100);
  const failureText = failed ? materialMessageText(t, material.failure) : '';
  const notices =
    material.status === 'ready' && material.extraction?.truncated
      ? truncationNotices(t, material.extraction.truncated)
      : [];
  const iconButton = cn(
    'size-6 shrink-0 rounded-md inline-flex items-center justify-center text-muted-foreground/70 transition-colors',
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary',
    locked ? 'cursor-not-allowed opacity-40' : 'hover:bg-muted hover:text-foreground',
  );
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border bg-background/60 px-2 py-1.5',
        failed ? 'border-destructive/30' : 'border-border/60',
      )}
      data-testid="course-material-chip"
      data-status={material.status}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'size-6 shrink-0 rounded-md flex items-center justify-center',
            failed
              ? 'bg-destructive/10 text-destructive'
              : 'bg-violet-100/70 text-violet-600 dark:bg-violet-900/30 dark:text-violet-300',
          )}
        >
          <MaterialTypeIcon material={material} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium leading-tight" title={material.name}>
            <span className="text-muted-foreground tabular-nums">{material.order}.</span>{' '}
            {material.name}
          </p>
          {failed ? (
            <p
              className="mt-0.5 line-clamp-2 break-words text-[10px] leading-snug text-destructive"
              title={failureText || undefined}
            >
              {t('toolbar.materialFailed')}
              {failureText && failureText !== t('toolbar.materialFailed') && ` · ${failureText}`}
            </p>
          ) : (
            <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-tight text-muted-foreground">
              {media && (
                <span className="shrink-0 rounded-sm border border-border/70 px-1 text-[9px] leading-[13px]">
                  {t('toolbar.materialMediaLabel')}
                </span>
              )}
              {material.status === 'uploading' && (
                <span className="tabular-nums">{t('toolbar.materialUploading', { percent })}</span>
              )}
              {material.status === 'extracting' && (
                <>
                  <Loader2 className="size-2.5 shrink-0 animate-spin" />
                  <span>
                    {t(media ? 'toolbar.materialTranscribing' : 'toolbar.materialParsing')}
                  </span>
                </>
              )}
              {material.status === 'ready' && (
                <>
                  <Check className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>{t('toolbar.materialReady')}</span>
                  <span className="text-muted-foreground/70 tabular-nums">
                    · {materialSizeText(material.size)}
                  </span>
                </>
              )}
            </p>
          )}
        </div>
        {failed && (
          <button
            type="button"
            onClick={onRetry}
            disabled={locked}
            className={iconButton}
            aria-label={t('toolbar.materialRetry')}
            title={t('toolbar.materialRetry')}
          >
            <RotateCw className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          disabled={locked}
          className={iconButton}
          aria-label={t('toolbar.removeCourseMaterial')}
          title={t('toolbar.removeCourseMaterial')}
        >
          <X className="size-3.5" />
        </button>
      </div>
      {notices.map((notice) => (
        <p
          key={notice}
          className="mt-1 pl-8 text-[10px] leading-snug text-amber-600/90 dark:text-amber-400/90"
        >
          {notice}
        </p>
      ))}
      {material.status === 'uploading' && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-violet-500/10">
          <div
            className="h-full bg-violet-500 transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {material.status === 'extracting' && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-violet-500/40" />
      )}
    </div>
  );
}
