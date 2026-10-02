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
import { useModelSettingsView } from '@/lib/model-settings/use-model-settings';
import { modelSettingsClient } from '@/lib/model-settings/client';
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
  // The deployment may lock the course model; it is then shown, not picked.
  const llmEditable = !!llmSlot && !llmSlot.locked && llmPickerGroups.length > 0;
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
      {/* ── Course model: pill (picker popover), read-only pill, or Set-up CTA (#580) ── */}
      {llmEditable ? (
        // Editable: the picker, with nothing selected while `llm` resolves to
        // nothing (no default model); picking a model sets the llm slot.
        <ModelPicker
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
      ) : llm ? (
        <span
          className={cn(pillCls, 'cursor-default border-border/50 text-muted-foreground')}
          aria-label={`${currentProviderName} / ${modelId}`}
          title={t('toolbar.modelLockedHint')}
        >
          <Bot className="size-3.5" />
          <span className="max-w-[200px] truncate">{modelId || currentProviderName}</span>
        </span>
      ) : (
        view &&
        !courseGenerationUsable(modelCapabilities(view)) &&
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
