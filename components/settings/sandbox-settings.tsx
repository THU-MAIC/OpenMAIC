'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/hooks/use-i18n';
import { sandboxRequest } from '@/components/sandbox/client';
import type { SandboxSettingsFields, SandboxSettingsView } from '@/lib/sandbox/settings';
import { CredentialStorageHint } from './server-settings';

const URL = '/api/sandbox/settings';
const textFields = ['apiUrl', 'domain', 'template'] as const;
const limits = ['lifetimeMs', 'maxActivePerOwner', 'maxActive'] as const;
export function SandboxSettings() {
  const { t } = useI18n();
  const tr = (key: string) => t(`sandbox.settings.${key}`);
  const [view, setView] = useState<SandboxSettingsView | null>(null);
  const [fields, setFields] = useState<SandboxSettingsFields | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const accept = (next: SandboxSettingsView) => {
    setView(next);
    setFields(next.fields);
    setApiKey('');
  };
  useEffect(() => {
    let active = true;
    sandboxRequest<SandboxSettingsView>(URL).then(
      (next) => {
        if (active) accept(next);
      },
      (e) => {
        if (active) setError(e instanceof Error ? e.message : t('sandbox.requestFailed'));
      },
    );
    return () => {
      active = false;
    };
  }, [t]);
  const refresh = async () => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      accept(await sandboxRequest<SandboxSettingsView>(URL));
    } catch (e) {
      setError(e instanceof Error ? e.message : tr('failed'));
    } finally {
      setBusy(false);
    }
  };
  const save = async (reset = false) => {
    if (!view || !fields) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      accept(
        await sandboxRequest<SandboxSettingsView>(URL, 'PUT', {
          revision: view.revision,
          ...(reset
            ? { reset: true }
            : { fields, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
        }),
      );
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : tr('failed'));
    } finally {
      setBusy(false);
    }
  };
  const changed = !!view && (JSON.stringify(fields) !== JSON.stringify(view.fields) || !!apiKey);
  const locked = busy || !!view?.locked || !!view?.activeEnvironments;
  return (
    <div className="max-w-2xl space-y-5" data-testid="sandbox-settings">
      <p className="text-sm text-muted-foreground">{tr('description')}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!view || !fields ? (
        <Button variant="outline" onClick={() => void refresh()} disabled={busy}>
          {tr(error ? 'retry' : 'loading')}
        </Button>
      ) : (
        <>
          <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1" role="status">
            <p>
              {tr(view.configured ? 'enabledStatus' : 'disabledStatus')} · {tr(view.source)}
            </p>
            <p>
              {tr('preview')}: {tr(view.previewConfigured ? 'configured' : 'notConfigured')} ·{' '}
              {tr('checkpoint')}: {tr(view.checkpointConfigured ? 'configured' : 'notConfigured')}
            </p>
            <p className="text-xs text-muted-foreground">{tr('dependencyHint')}</p>
          </div>
          {view.locked && (
            <p role="status" className="rounded border p-3 text-sm">
              {tr('locked')}
            </p>
          )}
          {view.activeEnvironments > 0 && (
            <p role="alert" className="rounded border border-amber-400 p-3 text-sm">
              {tr('activeWarning')} ({view.activeEnvironments})
            </p>
          )}
          <fieldset disabled={locked} className="space-y-4 disabled:opacity-70">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={fields.enabled}
                onChange={(e) => {
                  setFields({ ...fields, enabled: e.target.checked });
                  setSaved(false);
                }}
              />
              {tr('enabled')}
            </label>
            <div className="space-y-1">
              <label htmlFor="sandbox-provider" className="text-sm font-medium">
                Provider
              </label>
              <select
                id="sandbox-provider"
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={fields.provider}
                onChange={() => {}}
              >
                <option value="e2b-compatible">E2B-compatible</option>
              </select>
            </div>
            {textFields.map((key) => (
              <div key={key} className="space-y-1">
                <label htmlFor={`sandbox-${key}`} className="text-sm font-medium">
                  {tr(key)}
                </label>
                <Input
                  id={`sandbox-${key}`}
                  value={fields[key]}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setFields({ ...fields, [key]: e.target.value });
                    setSaved(false);
                  }}
                />
              </div>
            ))}
            <div className="space-y-1">
              <label htmlFor="sandbox-key" className="text-sm font-medium">
                API Key
              </label>
              <Input
                id="sandbox-key"
                type="password"
                autoComplete="new-password"
                value={apiKey}
                placeholder={tr(view.keySet ? 'keyStored' : 'keyMissing')}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setSaved(false);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {tr(view.keyUnreadable ? 'keyUnreadable' : 'keyHint')}
              </p>
              <CredentialStorageHint />
            </div>
            <details className="space-y-3">
              <summary className="cursor-pointer text-sm font-medium">{tr('advanced')}</summary>
              {(['connectionId', 'desktopTemplate'] as const).map((key) => (
                <div key={key} className="space-y-1">
                  <label htmlFor={`sandbox-${key}`} className="text-sm font-medium">
                    {tr(key)}
                  </label>
                  <Input
                    id={`sandbox-${key}`}
                    value={fields[key]}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => {
                      setFields({ ...fields, [key]: e.target.value });
                      setSaved(false);
                    }}
                  />
                </div>
              ))}
              <div className="grid gap-3 sm:grid-cols-3">
                {limits.map((key) => (
                  <div key={key} className="space-y-1">
                    <label htmlFor={`sandbox-${key}`} className="text-sm font-medium">
                      {tr(key)}
                    </label>
                    <Input
                      id={`sandbox-${key}`}
                      type="number"
                      min={key === 'lifetimeMs' ? 60 : 1}
                      max={key === 'lifetimeMs' ? 3600 : key === 'maxActive' ? 100 : 20}
                      value={key === 'lifetimeMs' ? fields[key] / 1000 : fields[key]}
                      onChange={(e) => {
                        setFields({
                          ...fields,
                          [key]: Number(e.target.value) * (key === 'lifetimeMs' ? 1000 : 1),
                        });
                        setSaved(false);
                      }}
                    />
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{tr('limitsHint')}</p>
            </details>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void save()} disabled={locked || !changed}>
              {tr(busy ? 'saving' : 'save')}
            </Button>
            {view.hasOverrides && (
              <Button variant="outline" onClick={() => void save(true)} disabled={locked}>
                {tr('reset')}
              </Button>
            )}
            <Button variant="outline" onClick={() => void refresh()} disabled={busy}>
              {tr('refresh')}
            </Button>
            {view.configured && (
              <Button asChild variant="outline">
                <Link href="/project-workspace/sandbox-project">{tr('openWorkspace')}</Link>
              </Button>
            )}
          </div>
          {saved && (
            <p role="status" className="text-sm text-green-700 dark:text-green-400">
              {tr('saved')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
