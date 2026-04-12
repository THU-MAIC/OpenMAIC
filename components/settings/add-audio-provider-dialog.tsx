'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

export interface NewAudioProviderData {
  name: string;
  baseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
}

interface AddAudioProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (data: NewAudioProviderData) => void;
  type: 'tts' | 'asr';
}

export function AddAudioProviderDialog({
  open,
  onOpenChange,
  onAdd,
  type,
}: AddAudioProviderDialogProps) {
  const { t } = useI18n();

  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [requiresApiKey, setRequiresApiKey] = useState(false);

  // Reset form when dialog closes
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setName('');
      setBaseUrl('');
      setDefaultModel('');
      setRequiresApiKey(false);
    }
  }

  const handleAdd = () => {
    if (!name.trim() || !baseUrl.trim()) return;
    onAdd({
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      defaultModel: defaultModel.trim(),
      requiresApiKey,
    });
    onOpenChange(false);
  };

  const titleKey =
    type === 'tts' ? 'settings.addCustomTTSProvider' : 'settings.addCustomASRProvider';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogTitle className="sr-only">{t(titleKey)}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('settings.addCustomAudioProviderDescription')}
        </DialogDescription>
        <div className="space-y-4">
          <div className="pb-3 border-b">
            <h2 className="text-lg font-semibold">{t(titleKey)}</h2>
            <p className="text-xs text-muted-foreground mt-1">
              {t('settings.addCustomAudioProviderDescription')}
            </p>
          </div>

          <div className="space-y-2">
            <Label>{t('settings.providerName')}</Label>
            <Input
              placeholder={type === 'tts' ? 'My Local TTS' : 'My Local ASR'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('settings.defaultBaseUrl')}</Label>
            <Input
              type="url"
              placeholder="http://localhost:8000/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          {/* Default Model — TTS only (ASR models are managed in provider settings) */}
          {type === 'tts' && (
            <div className="space-y-2">
              <Label>{t('settings.defaultModel')}</Label>
              <Input
                placeholder="tts-1"
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('settings.defaultModelHint')}</p>
            </div>
          )}

          <div className="flex items-center space-x-2">
            <Checkbox
              id="audio-requires-api-key"
              checked={requiresApiKey}
              onCheckedChange={(checked) => setRequiresApiKey(checked as boolean)}
            />
            <label htmlFor="audio-requires-api-key" className="text-sm cursor-pointer">
              {t('settings.requiresApiKey')}
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('settings.cancelEdit')}
            </Button>
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={!name.trim() || !baseUrl.trim()}
              className="gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('settings.addProviderButton')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
