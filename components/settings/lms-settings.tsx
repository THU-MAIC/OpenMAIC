'use client';

/**
 * LMS Integration settings panel (LearnWorlds via MCP).
 *
 * Lets the user configure how OpenMAIC reaches their Learnworlds-MCP server
 * (stdio command or streamable HTTP URL) plus the LearnWorlds credentials,
 * either through individual fields or by pasting a Claude-Desktop-style
 * `mcpServers` JSON blob. Includes a connection test that lists the MCP
 * tools server-side.
 */
import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { CheckCircle2, Loader2, PlugZap, XCircle, ClipboardPaste } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { cn } from '@/lib/utils';
import type { LearnWorldsTestResult } from '@/lib/lms/types';
import { parseMcpServersJson, validateLearnWorldsConfig } from '@/lib/lms/types';

export function LmsSettings() {
  const { t } = useI18n();
  const config = useSettingsStore((state) => state.learnWorldsConfig);
  const setConfig = useSettingsStore((state) => state.setLearnWorldsConfig);

  const [jsonBlob, setJsonBlob] = useState('');
  const [showJsonImport, setShowJsonImport] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LearnWorldsTestResult | null>(null);

  const missingFields = validateLearnWorldsConfig(config);
  const isComplete = missingFields.length === 0;

  const handleImportJson = () => {
    const parsed = parseMcpServersJson(jsonBlob);
    if (!parsed) {
      toast.error(t('settings.lms.importJsonError'));
      return;
    }
    setConfig(parsed);
    setJsonBlob('');
    setShowJsonImport(false);
    setTestResult(null);
    toast.success(t('settings.lms.importJsonSuccess'));
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/lms/learnworlds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', config }),
      });
      const data = (await res.json()) as {
        success: boolean;
        result?: LearnWorldsTestResult;
        error?: string;
      };
      if (data.success && data.result) {
        setTestResult(data.result);
      } else {
        setTestResult({ ok: false, error: data.error || 'Unknown error' });
      }
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header + enable switch */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">{t('settings.lms.learnworldsTitle')}</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {t('settings.lms.learnworldsDescription')}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Label htmlFor="lms-enabled" className="text-sm">
            {t('settings.lms.enable')}
          </Label>
          <Switch
            id="lms-enabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => setConfig({ enabled })}
          />
        </div>
      </div>

      {/* JSON import */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ClipboardPaste className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{t('settings.lms.importJsonTitle')}</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowJsonImport((v) => !v)}>
            {showJsonImport ? t('common.cancel') : t('settings.lms.importJsonButton')}
          </Button>
        </div>
        {showJsonImport && (
          <div className="space-y-2">
            <Textarea
              value={jsonBlob}
              onChange={(e) => setJsonBlob(e.target.value)}
              placeholder={'{\n  "mcpServers": {\n    "learnworlds": { ... }\n  }\n}'}
              className="font-mono text-xs min-h-[140px]"
            />
            <Button size="sm" onClick={handleImportJson} disabled={!jsonBlob.trim()}>
              {t('settings.lms.importJsonApply')}
            </Button>
          </div>
        )}
      </div>

      {/* Transport */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">{t('settings.lms.transport')}</Label>
        <div className="flex gap-2">
          {(['stdio', 'http'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                setConfig({ transport: mode });
                setTestResult(null);
              }}
              className={cn(
                'px-3 py-1.5 text-sm rounded-md border transition-colors',
                config.transport === mode
                  ? 'bg-primary/10 border-primary/50 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              {mode === 'stdio'
                ? t('settings.lms.transportStdio')
                : t('settings.lms.transportHttp')}
            </button>
          ))}
        </div>
      </div>

      {/* Transport-specific fields */}
      {config.transport === 'stdio' ? (
        <div className="grid grid-cols-1 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t('settings.lms.command')}</Label>
            <Input
              value={config.command}
              onChange={(e) => setConfig({ command: e.target.value })}
              placeholder="node"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t('settings.lms.args')}</Label>
            <Input
              value={config.args.join(' ')}
              onChange={(e) =>
                setConfig({ args: e.target.value.split(' ').filter((a) => a.length > 0) })
              }
              placeholder="/absolute/path/Learnworlds-MCP/dist/index.js"
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">{t('settings.lms.argsHint')}</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t('settings.lms.httpUrl')}</Label>
            <Input
              value={config.httpUrl}
              onChange={(e) => setConfig({ httpUrl: e.target.value })}
              placeholder="http://localhost:3900/mcp"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t('settings.lms.httpAuthToken')}</Label>
            <Input
              type="password"
              value={config.httpAuthToken}
              onChange={(e) => setConfig({ httpAuthToken: e.target.value })}
              placeholder="MCP_AUTH_TOKEN"
            />
          </div>
        </div>
      )}

      {/* LearnWorlds credentials */}
      <div className="space-y-4">
        <Label className="text-sm font-medium">{t('settings.lms.credentials')}</Label>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">{t('settings.lms.baseUrl')}</Label>
          <Input
            value={config.baseUrl}
            onChange={(e) => setConfig({ baseUrl: e.target.value })}
            placeholder="https://your-school.learnworlds.com/admin/api"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">{t('settings.lms.apiToken')}</Label>
          <Input
            type="password"
            value={config.apiToken}
            onChange={(e) => setConfig({ apiToken: e.target.value })}
            placeholder="LEARNWORLDS_API_TOKEN"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">{t('settings.lms.clientId')}</Label>
          <Input
            value={config.clientId}
            onChange={(e) => setConfig({ clientId: e.target.value })}
            placeholder="LEARNWORLDS_CLIENT_ID"
          />
        </div>
        <p className="text-[11px] text-muted-foreground">{t('settings.lms.credentialsHint')}</p>
      </div>

      {/* Test connection */}
      <div className="space-y-3">
        <Button
          onClick={handleTestConnection}
          disabled={testing || !isComplete}
          variant="outline"
          className="gap-2"
        >
          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
          {t('settings.lms.testConnection')}
        </Button>
        {!isComplete && (
          <p className="text-[11px] text-muted-foreground">
            {t('settings.lms.missingFields')}: {missingFields.join(', ')}
          </p>
        )}
        {testResult && (
          <div
            className={cn(
              'rounded-lg border p-3 text-sm flex items-start gap-2',
              testResult.ok
                ? 'border-green-500/40 bg-green-500/5'
                : 'border-destructive/40 bg-destructive/5',
            )}
          >
            {testResult.ok ? (
              <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
            ) : (
              <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            )}
            <div className="min-w-0">
              {testResult.ok ? (
                <>
                  <p className="font-medium">{t('settings.lms.testSuccess')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {testResult.serverName} v{testResult.serverVersion} ·{' '}
                    {t('settings.lms.toolCount', { count: testResult.toolCount ?? 0 })}
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium">{t('settings.lms.testFailed')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 break-words">
                    {testResult.error}
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
