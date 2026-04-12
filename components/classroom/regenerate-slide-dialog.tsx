'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSettingsStore } from '@/lib/store/settings';
import type { ThemeListItem } from '@/lib/types/theme';
import { useI18n } from '@/lib/hooks/use-i18n';
import { outlineToIndication, indicationToOutline } from '@/lib/hooks/use-scene-regenerator';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { CompactModelSelector } from '@/components/generation/model-selector-popover';
import { MediaPopover } from '@/components/generation/media-popover';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { SpeechAction } from '@/lib/types/action';
import type { RegenerateParams } from '@/lib/hooks/use-scene-regenerator';

export interface RegenerateFormValues {
  title: string;
  indication: string;
  regenerateSlide: boolean;
  audioText: string;
  modifyAudio: boolean;
  mediaType: 'none' | 'image' | 'video' | 'keep';
  mediaPrompt: string;
  themeId: string;
}

interface RegenerateSlideDialogProps {
  open: boolean;
  scene: Scene;
  outline: SceneOutline;
  initialValues?: RegenerateFormValues;
  /** Error message from the last regeneration attempt, if any */
  errorMessage?: string;
  onRegenerate: (params: RegenerateParams) => void;
  onClose: () => void;
}

function sceneToAudioText(scene: Scene): string {
  return (scene.actions ?? [])
    .filter((a): a is SpeechAction => a.type === 'speech')
    .map((a) => a.text)
    .join('\n\n');
}

function outlineToMediaType(outline: SceneOutline): 'none' | 'image' | 'video' | 'keep' {
  const generations = outline.mediaGenerations ?? [];
  // If the outline had media, default to 'keep' so it's preserved without re-generation
  if (generations.some((g) => g.type === 'video')) return 'keep';
  if (generations.some((g) => g.type === 'image')) return 'keep';
  return 'none';
}

function outlineToMediaPrompt(
  outline: SceneOutline,
  mediaType: 'none' | 'image' | 'video',
): string {
  if (mediaType === 'none') return '';
  const entry = (outline.mediaGenerations ?? []).find((g) => g.type === mediaType);
  return entry?.prompt ?? '';
}

export function RegenerateSlideDialog({
  open,
  scene,
  outline,
  initialValues,
  errorMessage,
  onRegenerate,
  onClose,
}: RegenerateSlideDialogProps) {
  const { t } = useI18n();
  const defaultThemeId = useSettingsStore((s) => s.themeId);

  const [title, setTitle] = useState('');
  const [regenerateSlide, setRegenerateSlide] = useState(true);
  const [indication, setIndication] = useState('');
  const [audioText, setAudioText] = useState('');
  const [modifyAudio, setModifyAudio] = useState(false);
  const [mediaType, setMediaType] = useState<'none' | 'image' | 'video' | 'keep'>('none');
  const [mediaPrompt, setMediaPrompt] = useState('');
  const [themeId, setThemeId] = useState(defaultThemeId);
  const [themes, setThemes] = useState<ThemeListItem[]>([]);
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const [isGeneratingNarration, setIsGeneratingNarration] = useState(false);
  const [narrationError, setNarrationError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const promptAbortRef = useRef<AbortController | null>(null);
  const narrationAbortRef = useRef<AbortController | null>(null);

  // Initialise form values on open + fetch theme list
  useEffect(() => {
    if (!open) return;
    if (initialValues) {
      setTitle(initialValues.title);
      setRegenerateSlide(initialValues.regenerateSlide);
      setIndication(initialValues.indication);
      setAudioText(initialValues.audioText);
      setModifyAudio(initialValues.modifyAudio);
      setMediaType(initialValues.mediaType);
      setMediaPrompt(initialValues.mediaPrompt);
      setThemeId(initialValues.themeId || defaultThemeId);
    } else {
      setTitle(outline.title);
      setRegenerateSlide(true);
      setIndication(outlineToIndication(outline.description, outline.keyPoints));
      setAudioText(sceneToAudioText(scene));
      setModifyAudio(false);
      const mt = outlineToMediaType(outline);
      setMediaType(mt);
      setMediaPrompt(mt === 'keep' ? '' : outlineToMediaPrompt(outline, mt));
      setThemeId(defaultThemeId);
    }
    // Fetch available themes
    fetch('/api/themes')
      .then((r) => r.json())
      .then((data: ThemeListItem[]) => setThemes(data))
      .catch(() => {
        /* theme list stays empty, selector hidden */
      });
  }, [open, outline, scene, initialValues, defaultThemeId]);

  // Abort in-flight fetches when dialog closes
  useEffect(() => {
    if (!open) {
      promptAbortRef.current?.abort();
      narrationAbortRef.current?.abort();
    }
  }, [open]);

  // Abort on unmount
  useEffect(() => {
    return () => {
      promptAbortRef.current?.abort();
      narrationAbortRef.current?.abort();
    };
  }, []);

  const generateNarration = useCallback(
    async (currentIndication: string) => {
      narrationAbortRef.current?.abort();
      const ctrl = new AbortController();
      narrationAbortRef.current = ctrl;

      setIsGeneratingNarration(true);
      setNarrationError(null);
      try {
        const config = getCurrentModelConfig();
        const res = await fetch('/api/generate/narration-text', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-model': config.modelString || '',
            'x-provider-type': config.providerType || '',
          },
          body: JSON.stringify({
            indicationText: currentIndication,
            language: outline.language,
          }),
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) return;
        const json = await res.json();
        if (json.success && json.data?.text) {
          setAudioText(json.data.text);
        } else {
          setNarrationError(json.error || t('stage.regen.aiGenerationError'));
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setNarrationError(t('stage.regen.aiGenerationError'));
      } finally {
        if (!ctrl.signal.aborted) setIsGeneratingNarration(false);
      }
    },
    [outline.language, t],
  );

  const generatePromptForType = useCallback(
    async (type: 'image' | 'video', currentIndication: string) => {
      // Cancel any in-flight request
      promptAbortRef.current?.abort();
      const ctrl = new AbortController();
      promptAbortRef.current = ctrl;

      setIsGeneratingPrompt(true);
      setMediaPrompt('');
      setPromptError(null);
      try {
        const config = getCurrentModelConfig();
        const res = await fetch('/api/generate/media-prompt', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-model': config.modelString || '',
            'x-provider-type': config.providerType || '',
          },
          body: JSON.stringify({
            indicationText: currentIndication,
            mediaType: type,
            language: outline.language,
          }),
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) return;
        const json = await res.json();
        if (json.success && json.data?.prompt) {
          setMediaPrompt(json.data.prompt);
        } else {
          setPromptError(json.error || t('stage.regen.aiGenerationError'));
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setPromptError(t('stage.regen.aiGenerationError'));
      } finally {
        if (!ctrl.signal.aborted) setIsGeneratingPrompt(false);
      }
    },
    [outline.language, t],
  );

  const handleMediaTypeChange = useCallback(
    (value: 'none' | 'image' | 'video' | 'keep') => {
      setMediaType(value);
      if (value === 'none' || value === 'keep') {
        setMediaPrompt('');
        promptAbortRef.current?.abort();
        return;
      }
      // Check if original outline already has a prompt for this type
      const existingPrompt = outlineToMediaPrompt(outline, value);
      if (existingPrompt) {
        setMediaPrompt(existingPrompt);
      } else {
        generatePromptForType(value, indication);
      }
    },
    [outline, generatePromptForType, indication],
  );

  // Conflict: new media requested without slide toggle, but slide has no existing media slot
  const hasExistingMedia = outlineToMediaType(outline) !== 'none';
  const needsNewMedia = mediaType === 'image' || mediaType === 'video';
  const showSlideWarning = !regenerateSlide && needsNewMedia && !hasExistingMedia;

  const handleSubmit = () => {
    const forceSlideRegen = !regenerateSlide && needsNewMedia && !hasExistingMedia;
    const updatedOutline: SceneOutline =
      regenerateSlide || forceSlideRegen
        ? { ...outline, title, ...indicationToOutline(indication) }
        : { ...outline };
    // Do NOT call onClose() here — Stage closes the dialog by transitioning
    // regenState from 'dialog_open' to 'regenerating'. Calling onClose() would
    // race with setRegenState('regenerating') and the batch winner is 'idle',
    // leaving the dialog open throughout the entire regeneration.
    onRegenerate({
      outline: updatedOutline,
      audioTextOverride: modifyAudio ? audioText : '',
      mediaType,
      mediaPrompt: mediaType !== 'none' && mediaType !== 'keep' ? mediaPrompt : undefined,
      skipAudio: !modifyAudio,
      skipSlide: !regenerateSlide && !forceSlideRegen,
      themeId: themeId || undefined,
    });
  };

  const isSubmitDisabled =
    isGeneratingPrompt || (mediaType !== 'none' && mediaType !== 'keep' && !mediaPrompt.trim());

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-purple-700 dark:text-purple-300">
            <span aria-hidden="true">↺</span> {t('stage.regen.dialogTitle')} — {title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('stage.regen.dialogTitle')} — {title}
          </DialogDescription>
        </DialogHeader>

        {errorMessage && (
          <div className="mx-1 px-3 py-2 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
            <span className="font-semibold">Error: </span>
            {errorMessage}
          </div>
        )}

        <div className="flex-1 overflow-y-auto space-y-4 px-1 py-2">
          {/* Slide block */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('stage.regen.indication')}
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {t('stage.regen.modifySlide')}
                </span>
                <Switch
                  id="regen-modify-slide"
                  checked={regenerateSlide}
                  onCheckedChange={setRegenerateSlide}
                />
              </div>
            </div>
            {regenerateSlide ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor="regen-title" className="text-xs text-muted-foreground">
                    {t('stage.regen.slideTitle')}
                  </Label>
                  <Input
                    id="regen-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
                <Textarea
                  id="regen-indication"
                  value={indication}
                  onChange={(e) => setIndication(e.target.value)}
                  rows={4}
                  className="resize-none text-sm"
                  placeholder={t('stage.regen.indicationPlaceholder')}
                />
                {themes.length > 0 && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('stage.regen.theme')}
                    </Label>
                    <Select value={themeId} onValueChange={setThemeId}>
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue>
                          {(() => {
                            const active = themes.find((th) => th.id === themeId);
                            return active ? (
                              <span className="flex items-center gap-2">
                                <span
                                  className="w-3 h-3 rounded-sm border border-border/50 shrink-0"
                                  style={{ background: active.colors.primary }}
                                />
                                {active.name}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">
                                {t('stage.regen.theme')}
                              </span>
                            );
                          })()}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {themes.map((theme) => (
                          <SelectItem key={theme.id} value={theme.id}>
                            <span className="flex items-center gap-2">
                              <span
                                className="w-3 h-3 rounded-sm border border-border/50 shrink-0"
                                style={{ background: theme.colors.primary }}
                              />
                              {theme.name}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground py-1">{t('stage.regen.slideKeep')}</p>
            )}
          </div>

          {/* Conflict warning: new media requested but slide has no existing media slot */}
          {showSlideWarning && (
            <div className="mx-1 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-sm text-amber-700 dark:text-amber-300">
              ⚠ {t('stage.regen.slideWarningMediaNeeded')}
            </div>
          )}

          {/* Audio text */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label
                htmlFor="regen-audio-text"
                className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {t('stage.regen.audioText')}
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {t('stage.regen.modifyAudio')}
                </span>
                <Switch
                  id="regen-modify-audio"
                  checked={modifyAudio}
                  onCheckedChange={setModifyAudio}
                />
              </div>
            </div>
            {modifyAudio ? (
              <div className="space-y-1">
                <Textarea
                  id="regen-audio-text"
                  value={audioText}
                  onChange={(e) => setAudioText(e.target.value)}
                  rows={5}
                  disabled={isGeneratingNarration}
                  className="resize-none text-sm"
                  placeholder={t('stage.regen.audioTextPlaceholder')}
                />
                <div className="flex items-center justify-between gap-2">
                  {narrationError ? (
                    <p className="text-xs text-red-600 dark:text-red-400 flex-1">
                      {narrationError} {t('stage.regen.aiModelHint')}
                    </p>
                  ) : (
                    <span />
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isGeneratingNarration || !indication.trim()}
                    onClick={() => generateNarration(indication)}
                    className="h-7 text-xs gap-1.5 shrink-0 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-700 hover:bg-violet-50 dark:hover:bg-violet-950/30"
                  >
                    <Sparkles className="size-3.5" />
                    {isGeneratingNarration
                      ? t('stage.regen.generatingNarration')
                      : t('stage.regen.generateNarration')}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground py-1">{t('stage.regen.audioKeep')}</p>
            )}
          </div>

          {/* Media selector */}
          <div className="space-y-2">
            <Label
              id="regen-media-label"
              className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {t('stage.regen.media')}
            </Label>
            <div role="group" aria-labelledby="regen-media-label" className="flex gap-2 flex-wrap">
              {(['keep', 'none', 'image', 'video'] as const).map((opt) => (
                <Button
                  key={opt}
                  type="button"
                  size="sm"
                  variant={mediaType === opt ? 'default' : 'outline'}
                  onClick={() => handleMediaTypeChange(opt)}
                >
                  {t(`stage.regen.media${opt.charAt(0).toUpperCase() + opt.slice(1)}`)}
                </Button>
              ))}
            </div>

            {mediaType !== 'none' && mediaType !== 'keep' && (
              <div className="space-y-1">
                {isGeneratingPrompt ? (
                  <p className="text-xs text-blue-500 dark:text-blue-400 animate-pulse">
                    ✨ {t('stage.regen.generatingPrompt')}
                  </p>
                ) : promptError ? (
                  <p className="text-xs text-red-600 dark:text-red-400">
                    {promptError} {t('stage.regen.aiModelHint')}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {outlineToMediaPrompt(outline, mediaType)
                      ? t('stage.regen.promptOriginal')
                      : t('stage.regen.promptAutoGenerated')}
                  </p>
                )}
                <Textarea
                  value={mediaPrompt}
                  onChange={(e) => setMediaPrompt(e.target.value)}
                  rows={3}
                  disabled={isGeneratingPrompt}
                  className="resize-none text-sm"
                  placeholder={t('stage.regen.mediaPromptPlaceholder')}
                />
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="pt-2 flex-row items-center">
          {/* Model controls — left side */}
          <div className="flex items-center gap-1.5 mr-auto">
            <CompactModelSelector />
            <MediaPopover onSettingsOpen={() => {}} />
          </div>
          {/* Actions — right side */}
          <Button variant="ghost" onClick={onClose}>
            {t('stage.regen.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitDisabled}
            className="bg-purple-600 hover:bg-purple-700 text-white"
          >
            <span aria-hidden="true">↺</span> {t('stage.regen.regenerate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
