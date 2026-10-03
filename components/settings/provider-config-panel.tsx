'use client';

import { useState, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Plus,
  Zap,
  Settings2,
  Trash2,
  Sparkles,
  Wrench,
  FileText,
  Send,
  Download,
  ExternalLink,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { PROVIDERS, type ProviderId } from '@/lib/ai/providers';
import type { CatalogueModel } from '@/lib/config/provider-presets';
import { formatContextWindow } from './utils';
import { PROVIDER_SIGNUP_LINKS } from './provider-links';
import { ModelEditDialog } from './model-edit-dialog';
import {
  ApiKeyField,
  ServerConfiguredNotice,
  ServerOnlyNotice,
  saveServiceProvider,
  type ProviderFields,
  type ServicePanelProps,
  verifySavedModel,
} from './server-settings';
import { cn } from '@/lib/utils';

/**
 * A language model service: its key (write-only), its endpoint where the
 * server lets a workspace set one, and its models. A service the server
 * configures is shown read-only.
 */
export function ProviderConfigPanel({ view, apply, entry }: ServicePanelProps) {
  const { t } = useI18n();
  const registry = PROVIDERS[entry.registryId as ProviderId];
  const provider = entry.provider;
  const signupLinks = PROVIDER_SIGNUP_LINKS[entry.id];
  const editable = entry.state === 'workspace' || entry.state === 'available';
  const serverConfigured = entry.state === 'deployment';

  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'fetching' | 'success' | 'error'>('idle');
  const [fetchMessage, setFetchMessage] = useState('');
  const [editing, setEditing] = useState<{ index: number | null; id: string } | null>(null);

  const models: CatalogueModel[] = useMemo(
    () => provider?.capabilities.chat?.models ?? entry.preset?.capabilities.chat?.models ?? [],
    [provider, entry.preset],
  );
  // A provider's own model list narrows (or names) what it serves.
  const pinned = !!provider?.models?.length;
  // Only the workspace's own endpoint may be changed, and only for chat services.
  const endpointEditable = editable && !!entry.preset?.customEndpoint;

  const save = useCallback(
    (fields: ProviderFields) => saveServiceProvider(view, apply, entry, fields, t),
    [view, apply, entry, t],
  );

  const saveModels = (ids: string[] | null) => save({ models: ids && ids.length ? ids : null });

  const handleTestApi = useCallback(async () => {
    setTestStatus('testing');
    setTestMessage('');
    if (models.length === 0) {
      setTestStatus('error');
      setTestMessage(t('settings.noModelsAvailable') || 'No models available for testing');
      return;
    }
    try {
      const data = await verifySavedModel(entry.id, models[0].id);
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
  }, [entry.id, models, t]);

  // Ask the provider which models it serves (on the server, with its stored
  // key) and add them to its list.
  const handleFetchModels = useCallback(async () => {
    setFetchStatus('fetching');
    setFetchMessage('');
    try {
      const response = await fetch('/api/provider/probe-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: entry.id }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        const ids: string[] = (data.models || []).map((m: { id: string }) => m.id);
        const current = models.map((model) => model.id);
        const additions = ids.filter((id) => !current.includes(id));
        // Report models as added only once the server saved them; a refused
        // or lost write leaves a failure the user can retry.
        if (additions.length && !(await saveModels([...current, ...additions]))) {
          setFetchStatus('error');
          setFetchMessage(t('settings.serverConfig.fetchNotSaved'));
          return;
        }
        setFetchStatus('success');
        setFetchMessage(
          t('settings.fetchModelsResult')
            .replace('{added}', String(additions.length))
            .replace('{total}', String(ids.length)),
        );
      } else if (response.status === 404) {
        setFetchStatus('error');
        setFetchMessage(t('settings.fetchModelsNoEndpoint'));
      } else if (response.status === 401) {
        setFetchStatus('error');
        setFetchMessage(t('settings.fetchModelsAuthError'));
      } else {
        setFetchStatus('error');
        setFetchMessage(data.error || t('settings.fetchModelsFailed'));
      }
    } catch {
      setFetchStatus('error');
      setFetchMessage(t('settings.fetchModelsFailed'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, models, t]);

  const commitBaseUrl = (value: string) => {
    const next = value.trim();
    if (next === (provider?.baseUrl ?? '')) return;
    if (!provider && !next) return;
    void save({ baseUrl: next || null });
  };

  const placeholderUrl =
    registry?.baseUrlPlaceholder || registry?.defaultBaseUrl || 'https://api.example.com/v1';

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Server-configured notice */}
      {serverConfigured && <ServerConfiguredNotice view={view} capability="chat" />}
      {entry.state === 'server-only' && <ServerOnlyNotice noUserKeys={!view.allowUserKeys} />}

      {/* The server's providers are the operator's: their key and endpoint
          are neither shown nor editable here. */}
      {editable && (
        <>
          {/* 推广位（如 Kimi）：获取 API key 的国内/海外双链接。 */}
          {signupLinks && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="text-muted-foreground">{t('settings.providerLinks.getApiKey')}</span>
              <a
                href={signupLinks.domestic}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-sm text-primary underline-offset-2 hover:underline"
              >
                {t('settings.providerLinks.domestic')}
                <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
              </a>
              <a
                href={signupLinks.international}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-sm text-primary underline-offset-2 hover:underline"
              >
                {t('settings.providerLinks.international')}
                <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
              </a>
            </div>
          )}
          {/* API Key */}
          <div className="space-y-2">
            <Label>{t('settings.apiSecret')}</Label>
            <ApiKeyField
              name={`llm-api-key-${entry.id}`}
              provider={provider}
              placeholder="sk-..."
              onSave={(apiKey) => save({ apiKey })}
              onRemove={() => save({ apiKey: '' })}
            >
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestApi}
                disabled={testStatus === 'testing' || !provider}
                className="gap-1.5"
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
            {testMessage && (
              <div
                className={cn(
                  'rounded-lg p-3 text-sm overflow-hidden',
                  testStatus === 'success' && 'bg-green-50 text-green-700 border border-green-200',
                  testStatus === 'error' && 'bg-red-50 text-red-700 border border-red-200',
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

          {/* API Host */}
          {endpointEditable && (
            <div className="space-y-2">
              <Label>{t('settings.apiHost')}</Label>
              <Input
                name={`llm-base-url-${entry.id}`}
                type="url"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={placeholderUrl}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                onBlur={() => commitBaseUrl(baseUrl)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitBaseUrl(baseUrl);
                }}
                className="h-8"
              />
              {registry?.alternateBaseUrls && registry.alternateBaseUrls.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {registry.alternateBaseUrls.map((alt) => {
                    const active = (baseUrl || registry.defaultBaseUrl) === alt.url;
                    return (
                      <button
                        key={alt.url}
                        type="button"
                        onClick={() => {
                          // The default endpoint is no endpoint of the provider's own.
                          const next = alt.url === registry.defaultBaseUrl ? '' : alt.url;
                          setBaseUrl(next);
                          commitBaseUrl(next);
                        }}
                        className={cn(
                          'px-2 py-0.5 text-xs rounded-md border transition-colors',
                          active
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-background text-muted-foreground border-border hover:bg-muted',
                        )}
                      >
                        {t(alt.label)}
                      </button>
                    );
                  })}
                </div>
              )}
              {(() => {
                const effectiveBaseUrl = baseUrl || registry?.defaultBaseUrl || '';
                if (!effectiveBaseUrl) return null;
                let endpointPath = '';
                switch (registry?.type) {
                  case 'openai':
                    endpointPath = '/chat/completions';
                    break;
                  case 'azure':
                    endpointPath = '/v1/responses?api-version=v1';
                    break;
                  case 'anthropic':
                    endpointPath = '/messages';
                    break;
                  case 'google':
                    endpointPath = '/models/[model]';
                    break;
                  default:
                    endpointPath = '';
                }
                return (
                  <p className="text-xs text-muted-foreground break-all">
                    {t('settings.requestUrl')}: {effectiveBaseUrl + endpointPath}
                  </p>
                );
              })()}
              {provider?.baseUrl && Object.keys(provider.capabilities).length === 1 && (
                <p className="text-xs text-muted-foreground">
                  {t('settings.serverConfig.endpointChatOnly')}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* Models - No selection state, just list for management */}
      <div className="space-y-3">
        {entry.registryId === 'azure' && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
            {t('settings.azureDeploymentHint')}
          </div>
        )}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Label className="text-base">{t('settings.models')}</Label>
            {serverConfigured && (
              <span className="text-[10px] px-1 py-0 h-4 leading-4 rounded bg-muted text-muted-foreground">
                {t('settings.serverConfigured')}
              </span>
            )}
          </div>
          {editable && (
            <div className="flex items-center gap-2 flex-wrap">
              {pinned && entry.preset?.capabilities.chat?.models.length ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowResetDialog(true)}
                  className="gap-1.5"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('settings.reset')}
                </Button>
              ) : null}
              {registry?.supportsModelDiscovery !== false && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleFetchModels}
                  disabled={fetchStatus === 'fetching' || !provider}
                  className="gap-1.5"
                >
                  {fetchStatus === 'fetching' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {t('settings.fetchModels')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing({ index: null, id: '' })}
                className="gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('settings.addNewModel')}
              </Button>
            </div>
          )}
        </div>

        {/* Fetch-models result message */}
        {fetchMessage && (
          <div
            className={cn(
              'rounded-lg p-2.5 text-xs',
              fetchStatus === 'success' && 'bg-green-50 text-green-700 border border-green-200',
              fetchStatus === 'error' && 'bg-amber-50 text-amber-700 border border-amber-200',
            )}
          >
            {fetchMessage}
          </div>
        )}

        <div className="space-y-1.5">
          {models.map((model, index) => {
            return (
              <div
                key={model.id}
                className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-card"
              >
                <div className="flex-1">
                  <div className="font-mono text-sm font-medium mb-1.5">{model.name}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {/* Capabilities */}
                    <div className="flex items-center gap-1">
                      {model.capabilities?.vision && (
                        <div title={t('settings.capabilities.vision')}>
                          <Sparkles className="h-3 w-3" />
                        </div>
                      )}
                      {model.capabilities?.tools && (
                        <div title={t('settings.capabilities.tools')}>
                          <Wrench className="h-3 w-3" />
                        </div>
                      )}
                      {model.capabilities?.streaming && (
                        <div title={t('settings.capabilities.streaming')}>
                          <Zap className="h-3 w-3" />
                        </div>
                      )}
                    </div>
                    {/* Context Window */}
                    {model.contextWindow && (
                      <span className="flex items-center gap-0.5">
                        <FileText className="h-3 w-3" />
                        <span className="text-[10px]">
                          {formatContextWindow(model.contextWindow)}
                        </span>
                      </span>
                    )}
                    {/* Output Window */}
                    {model.outputWindow && (
                      <span className="flex items-center gap-0.5">
                        <Send className="h-3 w-3" />
                        <span className="text-[10px]">
                          {formatContextWindow(model.outputWindow)}
                        </span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Edit/Delete Buttons — only for the workspace's own services */}
                {editable && (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-2"
                      onClick={() => setEditing({ index, id: model.id })}
                      title={t('settings.editModel')}
                      aria-label={`${t('settings.editModel')} ${model.id}`}
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() =>
                        void saveModels(
                          models.map((entryModel) => entryModel.id).filter((_, i) => i !== index),
                        )
                      }
                      title={t('settings.deleteModel')}
                      aria-label={`${t('settings.deleteModel')} ${model.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Edit Model Dialog */}
      <ModelEditDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        modelId={editing?.id ?? ''}
        isNew={editing?.index === null}
        providerId={provider ? entry.id : undefined}
        onSave={async (id) => {
          const ids = models.map((model) => model.id);
          if (editing?.index === null || editing === null) {
            if (!ids.includes(id)) ids.push(id);
          } else {
            ids[editing.index] = id;
          }
          await saveModels([...new Set(ids)]);
          setEditing(null);
        }}
      />

      {/* Reset Confirmation Dialog */}
      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.resetToDefault')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.resetConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancelEdit')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowResetDialog(false);
                void saveModels(null);
              }}
            >
              {t('settings.confirmReset')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
