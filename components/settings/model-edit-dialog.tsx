'use client';

import { useState, useCallback, useEffect } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { verifySavedModel } from './server-settings';

interface ModelEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The model id being edited ('' for a new model). */
  modelId: string;
  isNew: boolean;
  /** The saved provider, for testing the model; undefined until the service is saved. */
  providerId?: string;
  onSave: (modelId: string) => void | Promise<void>;
}

/**
 * Add or edit a model of a language model service: its id, and a test of it
 * on the server. A model's name, capabilities and context window come from
 * the built-in catalogue; a service's model list holds ids only.
 */
export function ModelEditDialog({
  open,
  onOpenChange,
  modelId,
  isNew,
  providerId,
  onSave,
}: ModelEditDialogProps) {
  const { t } = useI18n();
  const [id, setId] = useState(modelId);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  // Start from the model being edited, and reset the test, whenever the dialog opens.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset state when dialog opens
      setId(modelId);
      setTestStatus('idle');
      setTestMessage('');
    }
  }, [open, modelId]);

  const handleTestModel = useCallback(async () => {
    if (!providerId || !id.trim()) return;
    setTestStatus('testing');
    setTestMessage('');
    try {
      const data = await verifySavedModel(providerId, id.trim());
      if (data.success) {
        setTestStatus('success');
        setTestMessage(t('settings.connectionSuccess'));
      } else {
        setTestStatus('error');
        setTestMessage(data.error || t('settings.connectionFailed'));
      }
    } catch (_error) {
      setTestStatus('error');
      setTestMessage(t('settings.connectionFailed'));
    }
  }, [id, providerId, t]);

  const title = isNew ? t('settings.addNewModel') : t('settings.editModel');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          {isNew ? t('settings.addNewModelDescription') : t('settings.editModelDescription')}
        </DialogDescription>
        <div className="space-y-4">
          <div className="pb-3 border-b">
            <h2 className="text-lg font-semibold">{title}</h2>
          </div>

          {/* Model ID */}
          <div className="space-y-2">
            <Label>{t('settings.modelId')}</Label>
            <Input
              placeholder={t('settings.modelIdPlaceholder')}
              value={id}
              onChange={(e) => {
                setId(e.target.value);
                setTestStatus('idle');
                setTestMessage('');
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.serverConfig.modelFromCatalogue')}
            </p>
          </div>

          {/* Test Model */}
          <div className="space-y-3 pt-3 border-t">
            <div className="flex items-center justify-between">
              <Label className="text-base">{t('settings.testModel')}</Label>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestModel}
                disabled={!id.trim() || !providerId || testStatus === 'testing'}
                className={cn(
                  testStatus === 'success' && 'border-green-600 text-green-600 hover:bg-green-50',
                  testStatus === 'error' && 'border-red-600 text-red-600 hover:bg-red-50',
                )}
              >
                {testStatus === 'testing' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {testStatus === 'success' && <CheckCircle className="mr-2 h-4 w-4" />}
                {testStatus === 'error' && <XCircle className="mr-2 h-4 w-4" />}
                {testStatus === 'testing' ? t('settings.testing') : t('settings.testConnection')}
              </Button>
            </div>
            {testMessage && (
              <div
                className={cn(
                  'rounded-lg p-3 text-sm',
                  testStatus === 'success' && 'bg-green-50 text-green-700 border border-green-200',
                  testStatus === 'error' && 'bg-red-50 text-red-700 border border-red-200',
                )}
              >
                <div className="flex items-start gap-2 flex-wrap">
                  {testStatus === 'success' && <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                  {testStatus === 'error' && <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                  <p className="flex-1 break-words">{testMessage}</p>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('settings.cancelEdit')}
            </Button>
            <Button
              size="sm"
              disabled={!id.trim()}
              onClick={() => {
                if (!id.trim()) {
                  return;
                }
                void onSave(id.trim());
              }}
            >
              {t('settings.saveModel')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
