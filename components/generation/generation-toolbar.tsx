'use client';

import { useState, useRef, useMemo, useEffect } from 'react';
import { Bot, Paperclip, FileText, X } from 'lucide-react';
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
import { useSettingsStore } from '@/lib/store/settings';
import { getThinkingConfigKey } from '@/lib/ai/thinking-config';
import type { SettingsSection } from '@/lib/types/settings';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { getAcceptStringForProviders, isMimeSupportedByProviders } from '@/lib/document/mime';
import {
  MAX_DOCUMENT_BUNDLE_FILES,
  MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES,
} from '@/lib/document/bundle';
import { dedupeCourseMaterialFiles } from '@/lib/document/course-materials';
import type { SelectedCourseMaterial } from '@/lib/types/generation';
import { ModelPicker } from '@/components/settings/model-picker';
import { useLLMPickerGroups } from '@/components/settings/use-llm-picker-groups';

// ─── Constants ───────────────────────────────────────────────
const MAX_COURSE_MATERIAL_SIZE_MB = 50;
const MAX_COURSE_MATERIAL_SIZE_BYTES = MAX_COURSE_MATERIAL_SIZE_MB * 1024 * 1024;

// ─── Types ───────────────────────────────────────────────────
export interface GenerationToolbarProps {
  // PDF
  courseMaterials: SelectedCourseMaterial[];
  onCourseMaterialsAdd: (files: File[]) => void;
  onCourseMaterialRemove: (id: string) => void;
  onPdfError: (error: string | null) => void;
  /**
   * When set, the course-material add/remove affordances and the extractor
   * Select are all disabled (the parent freezes the material set and the
   * session inputs for the duration of generate-prep). The parent's handlers
   * are inert under the same flag; this only mirrors it in the UI.
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
  onPdfError,
  materialsLocked = false,
  onSettingsOpen,
}: GenerationToolbarProps) {
  const { t } = useI18n();
  const pdfProviderId = useSettingsStore((s) => s.pdfProviderId);
  const pdfProvidersConfig = useSettingsStore((s) => s.pdfProvidersConfig);
  const setPDFProvider = useSettingsStore((s) => s.setPDFProvider);
  const providerId = useSettingsStore((s) => s.providerId);
  const modelId = useSettingsStore((s) => s.modelId);
  const setModel = useSettingsStore((s) => s.setModel);
  const thinkingConfigs = useSettingsStore((s) => s.thinkingConfigs);
  const setThinkingConfig = useSettingsStore((s) => s.setThinkingConfig);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const { groups: llmPickerGroups } = useLLMPickerGroups();
  const currentProviderName = llmPickerGroups.find((g) => g.id === providerId)?.name ?? providerId;
  const currentThinkingConfig = thinkingConfigs[getThinkingConfigKey(providerId, modelId)];

  // Course material handler. `plain-text` is always active alongside the
  // user-selected extractor so txt/md files remain uploadable without
  // configuring an external service.
  const activeDocumentProviderIds = useMemo(
    () => [pdfProviderId, 'plain-text'] as const,
    [pdfProviderId],
  );
  const acceptForCurrentProvider = useMemo(
    () => getAcceptStringForProviders(activeDocumentProviderIds),
    [activeDocumentProviderIds],
  );

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
    onPdfError(t('upload.unsupportedCourseMaterial'));
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
    if (supportedFiles.length === 0) {
      onPdfError(t('upload.unsupportedCourseMaterial'));
      return;
    }
    if (supportedFiles.length !== incomingFiles.length) {
      onPdfError(t('upload.unsupportedCourseMaterial'));
      return;
    }
    if (supportedFiles.some((file) => file.size > MAX_COURSE_MATERIAL_SIZE_BYTES)) {
      onPdfError(t('upload.fileTooLarge'));
      return;
    }

    const dedupedFiles = dedupeCourseMaterialFiles(courseMaterials, supportedFiles);
    if (dedupedFiles.length === 0) return;

    if (courseMaterials.length + dedupedFiles.length > MAX_DOCUMENT_BUNDLE_FILES) {
      onPdfError(t('upload.courseMaterialCountLimit', { n: MAX_DOCUMENT_BUNDLE_FILES }));
      return;
    }

    const totalSize =
      courseMaterials.reduce((sum, file) => sum + file.size, 0) +
      dedupedFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES) {
      onPdfError(
        t('upload.courseMaterialTotalSizeLimit', {
          n: Math.floor(MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES / 1024 / 1024),
        }),
      );
      return;
    }

    onPdfError(null);
    onCourseMaterialsAdd(dedupedFiles);
  };

  // ─── Pill button helper ─────────────────────────────
  const pillCls =
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all cursor-pointer select-none whitespace-nowrap border';
  const pillMuted = `${pillCls} border-border/50 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60`;
  const pillActive = `${pillCls} border-violet-200/60 dark:border-violet-700/50 bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300`;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {/* ── Model selection: pill (picker popover) or Set-up CTA (#580) ── */}
      {llmPickerGroups.length > 0 ? (
        <ModelPicker
          groups={llmPickerGroups}
          value={providerId && modelId ? { providerId, modelId } : null}
          onSelect={(pid, mid) => setModel(pid as Parameters<typeof setModel>[0], mid)}
          thinkingConfig={currentThinkingConfig}
          onThinkingChange={(config) => setThinkingConfig(providerId, modelId, config)}
          ariaLabel={`${currentProviderName} / ${modelId}`}
          className="h-8 w-auto max-w-[260px] gap-1.5 rounded-full px-2.5 text-xs"
          t={t}
        />
      ) : (
        onSettingsOpen && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onSettingsOpen('model-services')}
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
            <button className={pillActive}>
              <Paperclip className="size-3.5" />
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
          {/* Extractor selector */}
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            <span className="text-xs font-medium text-muted-foreground shrink-0">
              {t('toolbar.documentExtractor')}
            </span>
            <Select
              value={pdfProviderId}
              onValueChange={(v) => setPDFProvider(v as PDFProviderId)}
              disabled={materialsLocked}
            >
              <SelectTrigger className="h-7 text-xs flex-1 min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(PDF_PROVIDERS).map((provider) => {
                  const cfg = pdfProvidersConfig[provider.id];
                  // AliDocMind authenticates with an AK/SK pair rather than a
                  // single apiKey — recognize either credential shape.
                  const hasCredentials =
                    !!cfg?.apiKey || (!!cfg?.accessKeyId && !!cfg?.accessKeySecret);
                  const available =
                    !provider.requiresApiKey || hasCredentials || !!cfg?.isServerConfigured;
                  return (
                    <SelectItem key={provider.id} value={provider.id} disabled={!available}>
                      <div className={cn('flex items-center gap-1.5', !available && 'opacity-50')}>
                        {provider.icon && (
                          <img src={provider.icon} alt={provider.name} className="w-3.5 h-3.5" />
                        )}
                        {provider.name}
                        {cfg?.isServerConfigured && (
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
                <p className="text-[10px] text-muted-foreground/60 mt-0.5 text-center">
                  {t('upload.courseMaterialSizeLimit')}
                </p>
                <p className="text-[10px] text-muted-foreground/60 text-center">
                  {t('upload.courseMaterialCountLimit', { n: MAX_DOCUMENT_BUNDLE_FILES })}
                </p>
              </div>

              {courseMaterials.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[10px] text-muted-foreground/70">
                    {t('toolbar.courseMaterialMergeOrder')}
                  </p>
                  <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
                    {[...courseMaterials]
                      .sort((a, b) => a.order - b.order)
                      .map((file) => (
                        <div
                          key={file.id}
                          className="flex items-center gap-2 rounded-lg border border-border/50 px-2 py-2"
                        >
                          <div className="size-8 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center shrink-0">
                            <FileText className="size-4 text-violet-600 dark:text-violet-400" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">
                              {file.order}. {file.name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {(file.size / 1024 / 1024).toFixed(2)} MB
                            </p>
                          </div>
                          <button
                            onClick={() => onCourseMaterialRemove(file.id)}
                            disabled={materialsLocked}
                            className={cn(
                              'size-6 rounded-full inline-flex items-center justify-center text-muted-foreground transition-colors',
                              materialsLocked ? 'cursor-not-allowed opacity-40' : 'hover:bg-muted',
                            )}
                            aria-label={t('toolbar.removeCourseMaterial')}
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
