'use client';

import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { CheckCircle2, Eye, EyeOff, Loader2, Zap, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

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

interface PDFSettingsProps {
  selectedProviderId: PDFProviderId;
}

export function PDFSettings({ selectedProviderId }: PDFSettingsProps) {
  const { t } = useI18n();
  const [showApiKey, setShowApiKey] = useState(false);
  const [showCloudApiKey, setShowCloudApiKey] = useState(false);
  const [showLocalApiKey, setShowLocalApiKey] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [cloudTestStatus, setCloudTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [cloudTestMessage, setCloudTestMessage] = useState('');
  const [localTestStatus, setLocalTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [localTestMessage, setLocalTestMessage] = useState('');

  const pdfProvidersConfig = useSettingsStore((state) => state.pdfProvidersConfig);
  const setPDFProviderConfig = useSettingsStore((state) => state.setPDFProviderConfig);

  const pdfProvider = PDF_PROVIDERS[selectedProviderId];
  const isServerConfigured = !!pdfProvidersConfig[selectedProviderId]?.isServerConfigured;
  const providerConfig = pdfProvidersConfig[selectedProviderId];
  const hasBaseUrl = !!providerConfig?.baseUrl;
  const needsRemoteConfig = selectedProviderId === 'mineru';

  // Reset state when provider changes
  const [prevSelectedProviderId, setPrevSelectedProviderId] = useState(selectedProviderId);
  if (selectedProviderId !== prevSelectedProviderId) {
    setPrevSelectedProviderId(selectedProviderId);
    setShowApiKey(false);
    setShowCloudApiKey(false);
    setShowLocalApiKey(false);
    setTestStatus('idle');
    setTestMessage('');
    setCloudTestStatus('idle');
    setCloudTestMessage('');
    setLocalTestStatus('idle');
    setLocalTestMessage('');
  }

  const handleTestConnection = async () => {
    const baseUrl = providerConfig?.baseUrl;
    if (!baseUrl) return;

    setTestStatus('testing');
    setTestMessage('');

    try {
      const response = await fetch('/api/verify-pdf-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: selectedProviderId,
          apiKey: providerConfig?.apiKey || '',
          baseUrl,
        }),
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

  const handleCloudTest = async () => {
    const baseUrl = providerConfig?.cloudBaseUrl;
    if (!baseUrl) return;

    setCloudTestStatus('testing');
    setCloudTestMessage('');

    try {
      const response = await fetch('/api/verify-pdf-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: selectedProviderId,
          apiKey: providerConfig?.cloudApiKey || '',
          baseUrl,
        }),
      });

      const data = await response.json();

      if (data.success) {
        setCloudTestStatus('success');
        setCloudTestMessage(t('settings.connectionSuccess'));
      } else {
        setCloudTestStatus('error');
        setCloudTestMessage(`${t('settings.connectionFailed')}: ${data.error}`);
      }
    } catch (err) {
      setCloudTestStatus('error');
      const message = err instanceof Error ? err.message : String(err);
      setCloudTestMessage(`${t('settings.connectionFailed')}: ${message}`);
    }
  };

  const handleLocalTest = async () => {
    const baseUrl = providerConfig?.localBaseUrl;
    if (!baseUrl) return;

    setLocalTestStatus('testing');
    setLocalTestMessage('');

    try {
      const response = await fetch('/api/verify-pdf-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: selectedProviderId,
          apiKey: providerConfig?.localApiKey || '',
          baseUrl,
        }),
      });

      const data = await response.json();

      if (data.success) {
        setLocalTestStatus('success');
        setLocalTestMessage(t('settings.connectionSuccess'));
      } else {
        setLocalTestStatus('error');
        setLocalTestMessage(`${t('settings.connectionFailed')}: ${data.error}`);
      }
    } catch (err) {
      setLocalTestStatus('error');
      const message = err instanceof Error ? err.message : String(err);
      setLocalTestMessage(`${t('settings.connectionFailed')}: ${message}`);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Server-configured notice */}
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {/* MinerU: Cloud + Local blocks */}
      {needsRemoteConfig && (
        <>
          {/* Cloud */}
          <div className="space-y-4">
            <p className="text-sm font-medium">{t('settings.mineruCloud')}</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-sm">{t('settings.pdfBaseUrl')}</Label>
                <div className="flex gap-2">
                  <Input
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="https://mineru.net/api/v4"
                    value={providerConfig?.cloudBaseUrl || ''}
                    onChange={(e) =>
                      setPDFProviderConfig(selectedProviderId, { cloudBaseUrl: e.target.value })
                    }
                    className="text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCloudTest}
                    disabled={cloudTestStatus === 'testing' || !providerConfig?.cloudBaseUrl}
                    className="gap-1.5 shrink-0"
                  >
                    {cloudTestStatus === 'testing' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>
                        <Zap className="h-3.5 w-3.5" />
                        {t('settings.testConnection')}
                      </>
                    )}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm">
                  {t('settings.pdfApiKey')}
                </Label>
                <div className="relative">
                  <Input
                    type={showCloudApiKey ? 'text' : 'password'}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={t('settings.enterApiKey')}
                    value={providerConfig?.cloudApiKey || ''}
                    onChange={(e) =>
                      setPDFProviderConfig(selectedProviderId, { cloudApiKey: e.target.value })
                    }
                    className="font-mono text-sm pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCloudApiKey(!showCloudApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showCloudApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            {cloudTestMessage && (
              <div
                className={cn(
                  'rounded-lg p-3 text-sm',
                  cloudTestStatus === 'success' &&
                    'bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800',
                  cloudTestStatus === 'error' &&
                    'bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800',
                )}
              >
                <div className="flex items-center gap-2">
                  {cloudTestStatus === 'success' && <CheckCircle2 className="h-4 w-4 shrink-0" />}
                  {cloudTestStatus === 'error' && <XCircle className="h-4 w-4 shrink-0" />}
                  <span className="break-all">{cloudTestMessage}</span>
                </div>
              </div>
            )}

            {providerConfig?.cloudBaseUrl && (
              <p className="text-xs text-muted-foreground break-all">
                {t('settings.requestUrl')}: {providerConfig.cloudBaseUrl}/file_parse
              </p>
            )}
          </div>

          {/* Local */}
          <div className="space-y-4">
            <p className="text-sm font-medium">{t('settings.mineruLocal')}</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-sm">{t('settings.pdfBaseUrl')}</Label>
                <div className="flex gap-2">
                  <Input
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="http://localhost:8080"
                    value={providerConfig?.localBaseUrl || ''}
                    onChange={(e) =>
                      setPDFProviderConfig(selectedProviderId, { localBaseUrl: e.target.value })
                    }
                    className="text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleLocalTest}
                    disabled={localTestStatus === 'testing' || !providerConfig?.localBaseUrl}
                    className="gap-1.5 shrink-0"
                  >
                    {localTestStatus === 'testing' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>
                        <Zap className="h-3.5 w-3.5" />
                        {t('settings.testConnection')}
                      </>
                    )}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm">
                  {t('settings.pdfApiKey')}
                  <span className="text-muted-foreground ml-1 font-normal">
                    ({t('settings.optional')})
                  </span>
                </Label>
                <div className="relative">
                  <Input
                    type={showLocalApiKey ? 'text' : 'password'}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={t('settings.enterApiKey')}
                    value={providerConfig?.localApiKey || ''}
                    onChange={(e) =>
                      setPDFProviderConfig(selectedProviderId, { localApiKey: e.target.value })
                    }
                    className="font-mono text-sm pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowLocalApiKey(!showLocalApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showLocalApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            {localTestMessage && (
              <div
                className={cn(
                  'rounded-lg p-3 text-sm',
                  localTestStatus === 'success' &&
                    'bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800',
                  localTestStatus === 'error' &&
                    'bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800',
                )}
              >
                <div className="flex items-center gap-2">
                  {localTestStatus === 'success' && <CheckCircle2 className="h-4 w-4 shrink-0" />}
                  {localTestStatus === 'error' && <XCircle className="h-4 w-4 shrink-0" />}
                  <span className="break-all">{localTestMessage}</span>
                </div>
              </div>
            )}

            {providerConfig?.localBaseUrl && (
              <p className="text-xs text-muted-foreground break-all">
                {t('settings.requestUrl')}: {providerConfig.localBaseUrl}/file_parse
              </p>
            )}
          </div>
        </>
      )}

      {/* Base URL + API Key Configuration (for non-MinerU remote providers) */}
      {!needsRemoteConfig && isServerConfigured && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm">{t('settings.pdfBaseUrl')}</Label>
              <div className="flex gap-2">
                <Input
                  name={`pdf-base-url-${selectedProviderId}`}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="http://localhost:8080"
                  value={providerConfig?.baseUrl || ''}
                  onChange={(e) =>
                    setPDFProviderConfig(selectedProviderId, { baseUrl: e.target.value })
                  }
                  className="text-sm"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestConnection}
                  disabled={testStatus === 'testing' || !hasBaseUrl}
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
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-sm">
                {t('settings.pdfApiKey')}
                <span className="text-muted-foreground ml-1 font-normal">
                  ({t('settings.optional')})
                </span>
              </Label>
              <div className="relative">
                <Input
                  name={`pdf-api-key-${selectedProviderId}`}
                  type={showApiKey ? 'text' : 'password'}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={
                    isServerConfigured ? t('settings.optionalOverride') : t('settings.enterApiKey')
                  }
                  value={providerConfig?.apiKey || ''}
                  onChange={(e) =>
                    setPDFProviderConfig(selectedProviderId, {
                      apiKey: e.target.value,
                    })
                  }
                  className="font-mono text-sm pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>

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

          {/* Request URL Preview */}
          {(() => {
            const effectiveBaseUrl = providerConfig?.baseUrl || '';
            if (!effectiveBaseUrl) return null;
            const fullUrl = effectiveBaseUrl + '/file_parse';
            return (
              <p className="text-xs text-muted-foreground break-all">
                {t('settings.requestUrl')}: {fullUrl}
              </p>
            );
          })()}
        </>
      )}

      {/* Features List */}
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
    </div>
  );
}
