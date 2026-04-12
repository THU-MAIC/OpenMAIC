'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
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
  mediaType: 'none' | 'image' | 'video';
  mediaPrompt: string;
}

interface RegenerateSlideDialogProps {
  open: boolean;
  scene: Scene;
  outline: SceneOutline;
  initialValues?: RegenerateFormValues;
  onRegenerate: (params: RegenerateParams) => void;
  onClose: () => void;
}

function sceneToAudioText(scene: Scene): string {
  return (scene.actions ?? [])
    .filter((a): a is SpeechAction => a.type === 'speech')
    .map((a) => a.text)
    .join('\n\n');
}

function outlineToMediaType(outline: SceneOutline): 'none' | 'image' | 'video' {
  const generations = outline.mediaGenerations ?? [];
  if (generations.some((g) => g.type === 'video')) return 'video';
  if (generations.some((g) => g.type === 'image')) return 'image';
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
  onRegenerate,
  onClose,
}: RegenerateSlideDialogProps) {
  const { t } = useI18n();

  const [indication, setIndication] = useState('');
  const [audioText, setAudioText] = useState('');
  const [mediaType, setMediaType] = useState<'none' | 'image' | 'video'>('none');
  const [mediaPrompt, setMediaPrompt] = useState('');
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);

  // Initialise form values on open
  useEffect(() => {
    if (!open) return;
    if (initialValues) {
      setIndication(initialValues.indication);
      setAudioText(initialValues.audioText);
      setMediaType(initialValues.mediaType);
      setMediaPrompt(initialValues.mediaPrompt);
    } else {
      setIndication(outlineToIndication(outline.description, outline.keyPoints));
      setAudioText(sceneToAudioText(scene));
      const mt = outlineToMediaType(outline);
      setMediaType(mt);
      setMediaPrompt(outlineToMediaPrompt(outline, mt));
    }
  }, [open, outline, scene, initialValues]);

  const generatePromptForType = useCallback(
    async (type: 'image' | 'video') => {
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
            indicationText: indication,
            mediaType: type,
            language: outline.language,
          }),
        });
        const json = await res.json();
        if (json.success && json.data?.prompt) {
          setMediaPrompt(json.data.prompt);
        }
      } catch {
        // Prompt stays empty; user can type it manually
      } finally {
        setIsGeneratingPrompt(false);
      }
    },
    [indication, outline.language],
  );

  const handleMediaTypeChange = useCallback(
    (value: 'none' | 'image' | 'video') => {
      setMediaType(value);
      if (value === 'none') {
        setMediaPrompt('');
        return;
      }
      // Check if original outline already has a prompt for this type
      const existingPrompt = outlineToMediaPrompt(outline, value);
      if (existingPrompt) {
        setMediaPrompt(existingPrompt);
      } else {
        generatePromptForType(value);
      }
    },
    [outline, generatePromptForType],
  );

  const handleSubmit = () => {
    const { description, keyPoints } = indicationToOutline(indication);
    const updatedOutline: SceneOutline = {
      ...outline,
      description,
      keyPoints,
    };
    onRegenerate({
      outline: updatedOutline,
      audioTextOverride: audioText,
      mediaType,
      mediaPrompt: mediaType !== 'none' ? mediaPrompt : undefined,
    });
    onClose();
  };

  const isSubmitDisabled = isGeneratingPrompt || (mediaType !== 'none' && !mediaPrompt.trim());

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-purple-700 dark:text-purple-300">
            ↺ {t('stage.regen.dialogTitle')} — {scene.title}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 px-1 py-2">
          {/* Indication */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('stage.regen.indication')}
            </Label>
            <Textarea
              value={indication}
              onChange={(e) => setIndication(e.target.value)}
              rows={4}
              className="resize-none text-sm"
              placeholder={t('stage.regen.indicationPlaceholder')}
            />
          </div>

          {/* Audio text */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('stage.regen.audioText')}
            </Label>
            <Textarea
              value={audioText}
              onChange={(e) => setAudioText(e.target.value)}
              rows={6}
              className="resize-none text-sm"
              placeholder={t('stage.regen.audioTextPlaceholder')}
            />
          </div>

          {/* Media selector */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('stage.regen.media')}
            </Label>
            <div className="flex gap-2">
              {(['none', 'image', 'video'] as const).map((opt) => (
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

            {mediaType !== 'none' && (
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
            ↺ {t('stage.regen.regenerate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
