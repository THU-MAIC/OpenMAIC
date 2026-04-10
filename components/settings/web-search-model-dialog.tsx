'use client';

import { useState, useCallback } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Zap, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';

interface WebSearchModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: { id: string; name: string } | null;
  setModel: (model: { id: string; name: string } | null) => void;
  onSave: () => void;
  isEditing: boolean;
  apiKey?: string;
  baseUrl?: string;
}

export function WebSearchModelDialog({
  open,
  onOpenChange,
  model,
  setModel,
  onSave,
  isEditing,
  apiKey,
  baseUrl,
}: WebSearchModelDialogProps) {
  const { t } = useI18n();
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const canTest = !!(model?.id?.trim() && model?.name?.trim() && apiKey);

  const handleTest = useCallback(async () => {
    if (!canTest || !model) return;
    setTestStatus('testing');
    setTestMessage('');
    try {
      const response = await fetch('/api/verify-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          model: `anthropic:${model.id}`,
          providerType: 'anthropic',
          requiresApiKey: true,
        }),
      });
      const data = await response.json();
      if (data.success) {
        setTestStatus('success');
        setTestMessage(t('settings.connectionSuccess'));
      } else {
        setTestStatus('error');
        setTestMessage(data.error || t('settings.connectionFailed'));
      }
    } catch {
      setTestStatus('error');
      setTestMessage(t('settings.connectionFailed'));
    }
  }, [canTest, model, apiKey, t]);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setTestStatus('idle');
      setTestMessage('');
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? t('settings.webSearchEditModelTitle')
              : t('settings.webSearchAddModelTitle')}
          </DialogTitle>
          <DialogDescription>{t('settings.webSearchModelDialogDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.webSearchModelIdField')}</Label>
            <Input
              value={model?.id ?? ''}
              onChange={(e) => {
                setModel(model ? { ...model, id: e.target.value } : null);
                setTestStatus('idle');
                setTestMessage('');
              }}
              placeholder="claude-opus-4.6"
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.webSearchModelNameField')}</Label>
            <Input
              value={model?.name ?? ''}
              onChange={(e) => {
                setModel(model ? { ...model, name: e.target.value } : null);
                setTestStatus('idle');
                setTestMessage('');
              }}
              placeholder="Claude Opus 4.6"
              className="text-sm"
            />
          </div>

          {/* Test connection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">{t('settings.testModel')}</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={!canTest || testStatus === 'testing'}
                className="gap-1.5"
              >
                {testStatus === 'testing' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Zap className="h-3.5 w-3.5" />
                )}
                {t('settings.testConnection')}
              </Button>
            </div>
            {testMessage && (
              <div
                className={cn(
                  'rounded-lg p-3 text-sm overflow-hidden',
                  testStatus === 'success' &&
                    'bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800',
                  testStatus === 'error' &&
                    'bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800',
                )}
              >
                <div className="flex items-start gap-2 min-w-0">
                  {testStatus === 'success' && <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />}
                  {testStatus === 'error' && <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                  <p className="flex-1 min-w-0 break-all">{testMessage}</p>
                </div>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {t('settings.close')}
          </Button>
          <Button onClick={onSave} disabled={!model?.id?.trim() || !model?.name?.trim()}>
            {t('settings.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
