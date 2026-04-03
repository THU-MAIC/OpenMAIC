'use client';

import { useState, useCallback, useEffect } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, CheckCircle, XCircle, Zap } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('MediaModelEditDialog');

type MediaType = 'tts' | 'asr' | 'image' | 'video';

interface MediaModelEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaType: MediaType;
  providerId: string;
  modelId: string;
  onModelIdChange: (id: string) => void;
  modelName: string;
  onModelNameChange: (name: string) => void;
  apiKey: string;
  baseUrl?: string;
  onSave: () => void;
  isEditing?: boolean;
  language?: string;
}

export function MediaModelEditDialog({
  open,
  onOpenChange,
  mediaType,
  providerId,
  modelId,
  onModelIdChange,
  modelName,
  onModelNameChange,
  apiKey,
  baseUrl,
  onSave,
  isEditing = false,
  language,
}: MediaModelEditDialogProps) {
  const { t } = useI18n();
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  // Reset test state when dialog opens
  useEffect(() => {
    if (open) {
      setTestStatus('idle');
      setTestMessage('');
    }
  }, [open]);

  const handleClose = () => {
    onOpenChange(false);
  };

  const handleSave = () => {
    if (!modelId.trim()) return;
    onSave();
    handleClose();
  };

  const handleTestModel = useCallback(async () => {
    if (!modelId.trim()) return;

    setTestStatus('testing');
    setTestMessage('');

    const testEndpoint = () => {
      switch (mediaType) {
        case 'image':
          return '/api/verify-image-provider';
        case 'video':
          return '/api/verify-video-provider';
        case 'tts':
          return '/api/verify-tts-provider';
        case 'asr':
          return '/api/verify-asr-provider';
        default:
          return '';
      }
    };

    const buildBody = () => {
      const baseBody: Record<string, unknown> = {
        providerId,
        apiKey,
        baseUrl,
      };

      switch (mediaType) {
        case 'image':
          return {
            ...baseBody,
            model: modelId,
          };
        case 'video':
          return {
            ...baseBody,
            model: modelId,
          };
        case 'tts':
          return {
            ...baseBody,
            modelId,
          };
        case 'asr':
          return {
            ...baseBody,
            modelId,
            language: language || 'en',
          };
        default:
          return baseBody;
      }
    };

    const buildHeaders = () => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      switch (mediaType) {
        case 'image':
          return {
            'x-image-provider': providerId,
            'x-image-model': modelId,
            'x-api-key': apiKey,
            'x-base-url': baseUrl || '',
          };
        case 'video':
          return {
            'x-video-provider': providerId,
            'x-video-model': modelId,
            'x-api-key': apiKey,
            'x-base-url': baseUrl || '',
          };
        default:
          return headers;
      }
    };

    try {
      const endpoint = testEndpoint();
      const headers = buildHeaders();
      const isImageOrVideo = mediaType === 'image' || mediaType === 'video';
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: isImageOrVideo 
          ? (headers as Record<string, string>)
          : { 'Content-Type': 'application/json' },
        body: isImageOrVideo ? undefined : JSON.stringify(buildBody()),
      });

      const data = await response.json();

      if (data.success) {
        setTestStatus('success');
        setTestMessage(t('settings.connectionSuccess') || 'Connection successful');
      } else {
        setTestStatus('error');
        setTestMessage(data.error || data.message || t('settings.connectionFailed'));
      }
    } catch (err) {
      log.error('Model test failed:', err);
      setTestStatus('error');
      setTestMessage(t('settings.connectionFailed') || 'Connection failed');
    }
  }, [modelId, mediaType, providerId, apiKey, baseUrl, language, t]);

  const canTest = modelId.trim() && apiKey && baseUrl;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>
          {isEditing ? t('settings.editModel') : t('settings.addNewModel')}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t('settings.customizeModel')}
        </DialogDescription>

        <div className="space-y-4 py-4">
          {/* Model ID */}
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.modelId')}</Label>
            <Input
              placeholder="e.g., my-model-v1"
              value={modelId}
              onChange={(e) => onModelIdChange(e.target.value)}
              className="font-mono text-sm"
            />
          </div>

          {/* Model Display Name */}
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.modelDisplayName')}</Label>
            <Input
              placeholder="e.g., My Custom Model"
              value={modelName}
              onChange={(e) => onModelNameChange(e.target.value)}
              className="text-sm"
            />
          </div>

          {/* Test Connection */}
          <div className="space-y-3 pt-4 border-t">
            <div className="flex items-center justify-between">
              <Label className="text-base">{t('settings.testConnection')}</Label>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestModel}
                disabled={!canTest || testStatus === 'testing'}
                className={cn(
                  testStatus === 'success' && 'border-green-600 text-green-600 hover:bg-green-50 dark:hover:bg-green-950',
                  testStatus === 'error' && 'border-red-600 text-red-600 hover:bg-red-50 dark:hover:bg-red-950',
                )}
              >
                {testStatus === 'testing' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {testStatus === 'success' && <CheckCircle className="mr-2 h-4 w-4" />}
                {testStatus === 'error' && <XCircle className="mr-2 h-4 w-4" />}
                {!['testing', 'success', 'error'].includes(testStatus) && (
                  <Zap className="mr-2 h-4 w-4" />
                )}
                {testStatus === 'testing' ? t('settings.testing') : t('settings.testConnection')}
              </Button>
            </div>

            {testMessage && (
              <div
                className={cn(
                  'rounded-lg p-3 text-sm',
                  testStatus === 'success' &&
                    'bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/50 dark:text-green-400 dark:border-green-800',
                  testStatus === 'error' &&
                    'bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800',
                )}
              >
                <div className="flex items-start gap-2 min-w-0">
                  {testStatus === 'success' && <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                  {testStatus === 'error' && <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                  <p className="flex-1 min-w-0 break-all">{testMessage}</p>
                </div>
              </div>
            )}

            {!canTest && baseUrl === undefined && (
              <div className="text-xs text-muted-foreground">
                {t('settings.testRequiresConfig')}
              </div>
            )}
          </div>
        </div>

        {/* Dialog Actions */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleClose}>
            {t('settings.cancelEdit')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!modelId.trim()}>
            {t('settings.saveModel')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
