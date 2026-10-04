'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { ApplyChange, ModelSettingsView } from '@/lib/model-settings/client';
import { newProviderId } from '@/lib/model-settings/edit';
import { reportApply } from './server-settings';

/** The API dialects a custom endpoint can speak, and the preset each one is. */
const API_MODE_PRESETS = {
  openai: 'openai-compatible',
  anthropic: 'anthropic',
  google: 'google',
} as const;

type ApiMode = keyof typeof API_MODE_PRESETS;

/** A provider id from a name: lowercase letters, digits and dashes. */
export function providerIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 59);
}

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: ModelSettingsView;
  apply: ApplyChange;
  /** Called with the new provider's id once it is saved. */
  onAdded: (providerId: string) => void;
}

/**
 * Add a language model service at an endpoint of the workspace's own: an
 * OpenAI-, Anthropic- or Google-compatible API. Its name becomes the
 * provider's id; its key and models are set in its panel afterwards.
 */
export function AddProviderDialog({
  open,
  onOpenChange,
  view,
  apply,
  onAdded,
}: AddProviderDialogProps) {
  const { t } = useI18n();

  const [name, setName] = useState('');
  const [type, setType] = useState<ApiMode>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset form when dialog closes (derived state pattern)
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setName('');
      setType('openai');
      setBaseUrl('');
    }
  }

  const preset = API_MODE_PRESETS[type];
  const available = view.presets.some((entry) => entry.id === preset);
  const slug = providerIdFromName(name);

  const handleAdd = async () => {
    if (!slug || !baseUrl.trim()) return;
    const id = newProviderId(view, slug);
    setSaving(true);
    try {
      const result = await apply({ kind: 'provider', id, preset, baseUrl: baseUrl.trim() }, view);
      if (reportApply(result, t)) onAdded(id);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogTitle className="sr-only">{t('settings.addProviderDialog')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('settings.addProviderDescription')}
        </DialogDescription>
        <div className="space-y-4">
          <div className="pb-3 border-b">
            <h2 className="text-lg font-semibold">{t('settings.addProviderDialog')}</h2>
          </div>

          {/* Provider Name */}
          <div className="space-y-2">
            <Label>{t('settings.providerName')}</Label>
            <Input
              placeholder={t('settings.providerNamePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {slug && (
              <p className="text-xs text-muted-foreground">
                {t('settings.serverConfig.providerIdHint', { id: slug })}
              </p>
            )}
          </div>

          {/* API Mode */}
          <div className="space-y-2">
            <Label>{t('settings.providerApiMode')}</Label>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(API_MODE_PRESETS) as ApiMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setType(mode)}
                  className={cn(
                    'p-2 rounded-lg border text-left text-sm transition-colors',
                    type === mode
                      ? 'bg-primary/5 border-primary/50'
                      : 'hover:bg-muted/50 border-transparent',
                  )}
                >
                  {t(
                    mode === 'openai'
                      ? 'settings.apiModeOpenAI'
                      : mode === 'anthropic'
                        ? 'settings.apiModeAnthropic'
                        : 'settings.apiModeGoogle',
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Base URL */}
          <div className="space-y-2">
            <Label>{t('settings.defaultBaseUrl')}</Label>
            <Input
              type="url"
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          {!available && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t('settings.serverConfig.serverOnlyPolicy')}
            </p>
          )}

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('settings.cancelEdit')}
            </Button>
            <Button
              size="sm"
              onClick={() => void handleAdd()}
              disabled={!slug || !baseUrl.trim() || !available || saving}
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
