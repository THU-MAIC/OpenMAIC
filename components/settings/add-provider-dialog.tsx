'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

export interface NewProviderData {
  name: string;
  type: 'openai' | 'anthropic' | 'google';
  baseUrl: string;
  icon: string;
  requiresApiKey: boolean;
}

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (provider: NewProviderData) => void;
}

export function AddProviderDialog({ open, onOpenChange, onAdd }: AddProviderDialogProps) {
  const { t } = useI18n();

  // Internal state
  const [name, setName] = useState('');
  const [type, setType] = useState<'openai' | 'anthropic' | 'google'>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [icon, setIcon] = useState('');
  const [requiresApiKey, setRequiresApiKey] = useState(true);

  // Reset form when dialog closes (derived state pattern)
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setName('');
      setType('openai');
      setBaseUrl('');
      setIcon('');
      setRequiresApiKey(true);
    }
  }

  const handleClose = () => {
    onOpenChange(false);
  };

  const handleAdd = () => {
    onAdd({
      name,
      type,
      baseUrl,
      icon,
      requiresApiKey,
    });
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
          </div>

          {/* API Mode */}
          <div className="space-y-2">
            <Label>{t('settings.providerApiMode')}</Label>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => setType('openai')}
                className={cn(
                  'p-2 rounded-lg border text-left text-sm transition-colors',
                  type === 'openai'
                    ? 'bg-primary/5 border-primary/50'
                    : 'hover:bg-muted/50 border-transparent',
                )}
              >
                {t('settings.apiModeOpenAI')}
              </button>
              <button
                onClick={() => setType('anthropic')}
                className={cn(
                  'p-2 rounded-lg border text-left text-sm transition-colors',
                  type === 'anthropic'
                    ? 'bg-primary/5 border-primary/50'
                    : 'hover:bg-muted/50 border-transparent',
                )}
              >
                {t('settings.apiModeAnthropic')}
              </button>
              <button
                onClick={() => setType('google')}
                className={cn(
                  'p-2 rounded-lg border text-left text-sm transition-colors',
                  type === 'google'
                    ? 'bg-primary/5 border-primary/50'
                    : 'hover:bg-muted/50 border-transparent',
                )}
              >
                {t('settings.apiModeGoogle')}
              </button>
            </div>
          </div>

          {/* Default Base URL */}
          <div className="space-y-2">
            <Label>{t('settings.defaultBaseUrl')}</Label>
            <Input
              type="url"
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          {/* Icon URL */}
          <div className="space-y-2">
            <Label>{t('settings.providerIcon')}</Label>
            <Input
              type="url"
              placeholder="https://example.com/icon.svg"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
            />
          </div>

          {/* Requires API Key */}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="requires-api-key"
              checked={requiresApiKey}
              onCheckedChange={(checked) => setRequiresApiKey(checked as boolean)}
            />
            <label htmlFor="requires-api-key" className="text-sm cursor-pointer">
              {t('settings.requiresApiKey')}
            </label>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t">
            <Button variant="outline" size="sm" onClick={handleClose}>
              {t('settings.cancelEdit')}
            </Button>
            <Button size="sm" onClick={handleAdd} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              {t('settings.addProviderButton')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
