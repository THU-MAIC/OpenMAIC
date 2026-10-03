'use client';

import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { MINERU_CLOUD_DEFAULT_BASE, PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { getFormatLabelsForProviders } from '@/lib/document/mime';
import { CheckCircle2, Loader2, Zap, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ApiKeyField,
  EndpointServerOnlyHint,
  ServerConfiguredNotice,
  ServerOnlyNotice,
  saveServiceProvider,
  type ServicePanelProps,
} from './server-settings';

/**
 * Get display label for feature
 */
function getFeatureLabel(feature: string, t: (key: string) => string): string {
  const labels: Record<string, string> = {
    text: t('settings.featureText'),
    images: t('settings.featureImages'),
    tables: t('settings.featureTables'),
    formulas: t('settings.featureFormulas'),
    'layout-analysis': t('settings.featureLayoutAnalysis'),
    metadata: t('settings.featureMetadata'),
  };
  return labels[feature] || feature;
}

/**
 * A document parsing service. MinerU Cloud takes a key; AliDocMind's key pair
 * and a self-hosted MinerU are the server's to configure; the built-in
 * parsers need nothing.
 */
export function PDFSettings({ view, apply, entry }: ServicePanelProps) {
  const { t } = useI18n();
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const providerId = entry.registryId as PDFProviderId;
  const pdfProvider = PDF_PROVIDERS[providerId];
  const provider = entry.provider;
  const isCloud = providerId === 'mineru-cloud';
  const needsRemoteConfig = !!pdfProvider?.requiresApiKey || !!pdfProvider?.requiresCredentials;
  const editable =
    (entry.state === 'workspace' || entry.state === 'available') && needsRemoteConfig;

  const handleTestConnection = async () => {
    setTestStatus('testing');
    setTestMessage('');
    try {
      const response = await fetch('/api/verify-pdf-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: entry.id }),
      });
      const data = await response.json();
      if (data.success) {
        setTestStatus('success');
        setTestMessage(t('settings.connectionSuccess'));
      } else {
        setTestStatus('error');
        setTestMessage(`${t('settings.connectionFailed')}: ${data.error}`);
      }
    } catch (err) {
      setTestStatus('error');
      const message = err instanceof Error ? err.message : String(err);
      setTestMessage(`${t('settings.connectionFailed')}: ${message}`);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {entry.state === 'deployment' && <ServerConfiguredNotice view={view} capability="document" />}
      {entry.state === 'server-only' && <ServerOnlyNotice noUserKeys={!view.allowUserKeys} />}

      {editable && (
        <>
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.pdfApiKey')}</Label>
            <ApiKeyField
              name={`pdf-api-key-${entry.id}`}
              provider={provider}
              placeholder={isCloud ? t('settings.mineruCloudApiKeyPlaceholder') : undefined}
              inputClassName="font-mono text-sm"
              onSave={(apiKey) => saveServiceProvider(view, apply, entry, { apiKey }, t)}
              onRemove={() => saveServiceProvider(view, apply, entry, { apiKey: '' }, t)}
            >
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleTestConnection()}
                disabled={testStatus === 'testing' || !provider}
                className="gap-1.5 shrink-0"
              >
                {testStatus === 'testing' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <Zap className="h-3.5 w-3.5" />
                    {t('settings.testConnection')}
                  </>
                )}
              </Button>
            </ApiKeyField>
          </div>

          {/* Base URL: the service's own; another endpoint is the server's to set. */}
          {isCloud && (
            <div className="space-y-2">
              <Label className="text-sm">{t('settings.pdfBaseUrl')}</Label>
              <p className="text-xs text-muted-foreground break-all">
                {t('settings.requestUrl')}: {MINERU_CLOUD_DEFAULT_BASE}/file-urls/batch
              </p>
              <EndpointServerOnlyHint />
            </div>
          )}

          {/* Test result message */}
          {testMessage && (
            <div
              className={cn(
                'rounded-lg p-3 text-sm',
                testStatus === 'success' &&
                  'bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800',
                testStatus === 'error' &&
                  'bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800',
              )}
            >
              <div className="flex items-center gap-2">
                {testStatus === 'success' && <CheckCircle2 className="h-4 w-4 shrink-0" />}
                {testStatus === 'error' && <XCircle className="h-4 w-4 shrink-0" />}
                <span className="break-all">{testMessage}</span>
              </div>
            </div>
          )}
        </>
      )}

      {/* Supported Formats */}
      <div className="space-y-2">
        <Label className="text-sm">{t('settings.supportedFormats')}</Label>
        <div className="flex flex-wrap gap-2">
          {getFormatLabelsForProviders([providerId]).map((format) => (
            <Badge key={format} variant="secondary" className="font-normal">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              {format}
            </Badge>
          ))}
        </div>
        {/* Self-hosted MinerU can under-deliver on PDF/image formats when the
            server lacks the pipeline/core extras — warn against over-promising. */}
        {providerId === 'mineru' && (
          <p className="text-xs text-muted-foreground">{t('settings.mineruSelfHostFormatsNote')}</p>
        )}
      </div>

      {/* Features List */}
      {pdfProvider && (
        <div className="space-y-2">
          <Label className="text-sm">{t('settings.pdfFeatures')}</Label>
          <div className="flex flex-wrap gap-2">
            {pdfProvider.features.map((feature) => (
              <Badge key={feature} variant="secondary" className="font-normal">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                {getFeatureLabel(feature, t)}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
