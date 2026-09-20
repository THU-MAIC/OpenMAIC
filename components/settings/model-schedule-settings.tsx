'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

const PRESET_TEMPLATE: Record<string, unknown> = {
  models: {
    'qwen:qwen3.8-flash': { tier: 'low', label: 'Qwen3.8 Flash (fast/cheap)' },
    'qwen:deepseek-v4.1-flash': { tier: 'low+', label: 'DeepSeek V4.1 Flash (optional low tier)' },
    'openai:ZHIPU/GLM-5.3-Flash': { tier: 'mid', label: 'GLM-5.3 Flash (main/default)' },
    'openai:ZHIPU/GLM-5.3': { tier: 'mid+', label: 'GLM-5.3 (stronger than Flash)' },
    'qwen:deepseek-v4-pro-0813': { tier: 'high', label: 'DeepSeek V4 Pro (hardest pages)' },
  },
  budget: { monthlyCapCny: 100, dailyEscalationCap: 20, hardLock: true },
  escalation: {
    'scene-content:slide': {
      base: 'qwen:qwen3.8-flash',
      escalateTo: 'openai:ZHIPU/GLM-5.3-Flash',
      trigger: 'onTimeout',
      max: 1,
    },
    'scene-content:quiz': {
      base: 'qwen:qwen3.8-flash',
      escalateTo: 'openai:ZHIPU/GLM-5.3-Flash',
      trigger: 'onTimeout',
      max: 1,
    },
    'scene-content:interactive': {
      base: 'openai:ZHIPU/GLM-5.3-Flash',
      escalateTo: 'qwen:deepseek-v4-pro-0813',
      trigger: 'onTimeout',
      max: 1,
    },
    'scene-content:pbl': {
      base: 'openai:ZHIPU/GLM-5.3-Flash',
      escalateTo: 'qwen:deepseek-v4-pro-0813',
      trigger: 'onTimeout',
      max: 1,
    },
    'scene-actions': {
      base: 'qwen:qwen3.8-flash',
      escalateTo: 'openai:ZHIPU/GLM-5.3-Flash',
      trigger: 'onRetryableError',
      max: 1,
    },
  },
  strictMode: false,
};

interface LedgerEvent {
  ts: string;
  kind: 'escalation' | 'suggestion' | 'decision';
  stage: string;
  scene?: string;
  base?: string;
  used?: string;
  reason?: string;
}

/**
 * Model Scheduling panel: JSON config editor + preset template + recent ledger.
 * Talks to GET/PUT /api/model-schedule; the engine hot-reads the file per call,
 * so saving applies without a server restart.
 */
export function ModelScheduleSettings() {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/model-schedule', { cache: 'no-store' });
      const data = (await res.json()) as { config: unknown | null; events: LedgerEvent[] };
      setConfigured(data.config !== null);
      setText(data.config !== null ? JSON.stringify(data.config, null, 2) : '');
      setEvents(data.events ?? []);
    } catch {
      toast.error(t('settings.modelSchedule.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyTemplate = () => {
    setText(JSON.stringify(PRESET_TEMPLATE, null, 2));
    setConfigured(true);
  };

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      toast.error(t('settings.modelSchedule.invalidJson'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/model-schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const data = (await res.json()) as { ok: boolean };
      if (data.ok) {
        toast.success(t('settings.modelSchedule.saveSuccess'));
        void load();
      } else {
        toast.error(t('settings.modelSchedule.saveFailed'));
      }
    } catch {
      toast.error(t('settings.modelSchedule.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const clearConfig = async () => {
    setSaving(true);
    try {
      await fetch('/api/model-schedule', { method: 'DELETE' });
    } finally {
      setSaving(false);
      await load();
    }
  };

  return (
    <div className="flex-1 overflow-y-auto h-full">
      <div className="p-4 space-y-4">
        <div>
          <h3 className="text-base font-semibold">{t('settings.modelSchedule.title')}</h3>
          <p className="text-sm text-muted-foreground mt-1">{t('settings.modelSchedule.desc')}</p>
          <div
            className={cn(
              'mt-2 inline-flex items-center gap-2 text-xs',
              configured ? 'text-green-600' : 'text-muted-foreground',
            )}
          >
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                configured ? 'bg-green-500' : 'bg-muted-foreground',
              )}
            />
            {configured
              ? t('settings.modelSchedule.enabled')
              : t('settings.modelSchedule.disabled')}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={applyTemplate}>
            {t('settings.modelSchedule.loadTemplate')}
          </Button>
          <Button size="sm" variant="outline" onClick={clearConfig} disabled={saving}>
            {t('settings.modelSchedule.clear')}
          </Button>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder='{ "models": {...}, "escalation": {...}, "budget": {...} }'
          className="w-full h-72 rounded-lg border bg-background p-3 font-mono text-xs leading-relaxed"
        />

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? t('settings.modelSchedule.saving') : t('settings.save')}
          </Button>
        </div>

        <div>
          <h4 className="text-sm font-semibold">{t('settings.modelSchedule.ledger')}</h4>
          {events.length === 0 ? (
            <p className="text-xs text-muted-foreground mt-1">
              {t('settings.modelSchedule.noEvents')}
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {events.map((e, i) => (
                <li
                  key={`${e.ts}-${i}`}
                  className="text-xs rounded-lg border px-3 py-1.5 flex flex-wrap gap-x-2 gap-y-0.5"
                >
                  <span className="text-muted-foreground">{new Date(e.ts).toLocaleString()}</span>
                  <span className="font-medium">{e.stage}</span>
                  {e.scene && <span className="text-muted-foreground">{e.scene}</span>}
                  {e.base && (
                    <span>
                      {e.base} → {e.used}
                    </span>
                  )}
                  {e.reason && <span className="text-muted-foreground">({e.reason})</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
