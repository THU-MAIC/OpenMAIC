'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { outlineToIndication, indicationToOutline } from '@/lib/hooks/use-scene-regenerator';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { SpeechAction } from '@/lib/types/action';
import type { RegenerateParams } from '@/lib/hooks/use-scene-regenerator';

export interface RegenerateFormValues {
  indication: string;
  audioText: string;
  modifyAudio: boolean;
  mediaType: 'none' | 'image' | 'video' | 'keep';
  mediaPrompt: string;
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

function outlineToMediaPrompt(outline: SceneOutline, mediaType: 'none' | 'image' | 'video'): string {
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

  const [indication, setIndication] = useState('');
  const [audioText, setAudioText] = useState('');
  const [modifyAudio, setModifyAudio] = useState(false);
  const [mediaType, setMediaType] = useState<'none' | 'image' | 'video' | 'keep'>('none');
  const [mediaPrompt, setMediaPrompt] = useState('');
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const promptAbortRef = useRef<AbortController | null>(null);

  // Initialise form values on open
  useEffect(() => {
    if (!open) return;
    if (initialValues) {
      setIndication(initialValues.indication);
      setAudioText(initialValues.audioText);
      setModifyAudio(initialValues.modifyAudio);
      setMediaType(initialValues.mediaType);
      setMediaPrompt(initialValues.mediaPrompt);
    } else {
      setIndication(outlineToIndication(outline.description, outline.keyPoints));
      setAudioText(sceneToAudioText(scene));
      setModifyAudio(false);
      const mt = outlineToMediaType(outline);
      setMediaType(mt);
      setMediaPrompt(mt === 'keep' ? '' : outlineToMediaPrompt(outline, mt));
    }
  }, [open, outline, scene, initialValues]);

  // Abort in-flight media-prompt fetch when dialog closes
  useEffect(() => {
    if (!open) promptAbortRef.current?.abort();
  }, [open]);

  // Abort on unmount
  useEffect(() => {
    return () => {
      promptAbortRef.current?.abort();
    };
  }, []);

  const generatePromptForType = useCallback(
    async (type: 'image' | 'video', currentIndication: string) => {
      // Cancel any in-flight request
      promptAbortRef.current?.abort();
      const ctrl = new AbortController();
      promptAbortRef.current = ctrl;

      setIsGeneratingPrompt(true);
      setMediaPrompt('');
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
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Prompt stays empty; user can type it manually
      } finally {
        if (!ctrl.signal.aborted) setIsGeneratingPrompt(false);
      }
    },
    [outline.language],
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

  const handleSubmit = () => {
    const { description, keyPoints } = indicationToOutline(indication);
    const updatedOutline: SceneOutline = {
      ...outline,
      description,
      keyPoints,
    };
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
    });
  };

  const isSubmitDisabled = isGeneratingPrompt || (mediaType !== 'none' && !mediaPrompt.trim());

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-purple-700 dark:text-purple-300">
            <span aria-hidden="true">↺</span> {t('stage.regen.dialogTitle')} — {scene.title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('stage.regen.dialogTitle')} — {scene.title}
          </DialogDescription>
        </DialogHeader>

        {errorMessage && (
          <div className="mx-1 px-3 py-2 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
            <span className="font-semibold">Error: </span>{errorMessage}
          </div>
        )}

        <div className="flex-1 overflow-y-auto space-y-4 px-1 py-2">
          {/* Indication */}
          <div className="space-y-1.5">
            <Label htmlFor="regen-indication" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('stage.regen.indication')}
            </Label>
            <Textarea
              id="regen-indication"
              value={indication}
              onChange={(e) => setIndication(e.target.value)}
              rows={4}
              className="resize-none text-sm"
              placeholder={t('stage.regen.indicationPlaceholder')}
            />
          </div>

          {/* Audio text */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="regen-audio-text" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('stage.regen.audioText')}
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{t('stage.regen.modifyAudio')}</span>
                <Switch
                  id="regen-modify-audio"
                  checked={modifyAudio}
                  onCheckedChange={setModifyAudio}
                />
              </div>
            </div>
            {modifyAudio ? (
              <Textarea
                id="regen-audio-text"
                value={audioText}
                onChange={(e) => setAudioText(e.target.value)}
                rows={6}
                className="resize-none text-sm"
                placeholder={t('stage.regen.audioTextPlaceholder')}
              />
            ) : (
              <p className="text-xs text-muted-foreground py-1">
                {t('stage.regen.audioKeep')}
              </p>
            )}
          </div>

          {/* Media selector */}
          <div className="space-y-2">
            <Label id="regen-media-label" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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

        <DialogFooter className="pt-2">
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
