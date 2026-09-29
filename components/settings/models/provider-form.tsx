'use client';

import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { PresetView, ProviderView } from '@/lib/model-settings/client';
import { groupPresets, providerFields, type ProviderDraft } from '@/lib/model-settings/edit';
import { cn } from '@/lib/utils';

import { MS } from './slot-meta';

type T = (key: string, options?: Record<string, unknown>) => string;

export function PresetSelect({
  presets,
  value,
  onChange,
  t,
  id,
}: {
  presets: readonly PresetView[];
  value: string;
  onChange: (preset: string) => void;
  t: T;
  id?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} size="sm" className="w-full text-sm">
        <SelectValue placeholder={t(`${MS}.providers.pickPreset`)} />
      </SelectTrigger>
      <SelectContent align="start" className="max-h-80">
        {groupPresets(presets).map(({ group, presets: members }) => (
          <SelectGroup key={group}>
            <SelectLabel className="text-[11px]">
              {t(`${MS}.providers.groups.${group}`)}
            </SelectLabel>
            {members.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The key, endpoint and model fields of a provider. For an existing provider
 * the stored key is never shown: it can be kept, replaced or removed.
 */
export function ProviderFields({
  preset,
  draft,
  onChange,
  existing,
  t,
}: {
  preset: PresetView | undefined;
  draft: ProviderDraft;
  onChange: (draft: ProviderDraft) => void;
  existing?: ProviderView;
  t: T;
}) {
  const id = useId();
  const [showKey, setShowKey] = useState(false);
  const fields = providerFields(preset, draft);
  const storedKey = existing?.key?.set && !existing.key.unreadable;

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${id}-key`} className="text-xs">
            {t(`${MS}.providers.apiKey`)}
          </Label>
          {storedKey && (
            <div className="flex items-center gap-2 text-[11px]">
              {(['keep', 'replace', 'remove'] as const).map((action) => (
                <button
                  key={action}
                  type="button"
                  onClick={() => onChange({ ...draft, keyAction: action, apiKey: '' })}
                  aria-pressed={draft.keyAction === action}
                  className={cn(
                    'rounded-sm underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    draft.keyAction === action
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:underline',
                  )}
                >
                  {t(`${MS}.providers.${action}Key`)}
                </button>
              ))}
            </div>
          )}
        </div>
        {storedKey && draft.keyAction === 'keep' ? (
          <p className="flex h-8 items-center rounded-md border border-dashed px-2.5 font-mono text-xs text-muted-foreground">
            {existing?.key?.mask ?? t(`${MS}.providers.keySetNoMask`)}
          </p>
        ) : storedKey && draft.keyAction === 'remove' ? (
          <p className="flex min-h-8 items-center rounded-md border border-dashed border-destructive/40 px-2.5 text-xs text-destructive">
            {t(`${MS}.providers.keyWillBeRemoved`)}
          </p>
        ) : (
          <div className="relative">
            <Input
              id={`${id}-key`}
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={draft.apiKey}
              onChange={(event) => onChange({ ...draft, apiKey: event.target.value })}
              placeholder={t(`${MS}.providers.apiKeyPlaceholder`)}
              className="h-8 pr-8 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => setShowKey((shown) => !shown)}
              aria-label={t(showKey ? `${MS}.providers.hideKey` : `${MS}.providers.showKey`)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
        )}
      </div>

      {fields.baseUrl && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-url`} className="text-xs">
            {fields.baseUrlRequired
              ? t(`${MS}.providers.baseUrl`)
              : t(`${MS}.providers.baseUrlOptional`)}
          </Label>
          <Input
            id={`${id}-url`}
            type="url"
            inputMode="url"
            spellCheck={false}
            value={draft.baseUrl}
            onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
            placeholder="https://"
            className="h-8 font-mono text-xs"
          />
        </div>
      )}

      {fields.models && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-models`} className="text-xs">
            {t(`${MS}.providers.models`)}
          </Label>
          <Textarea
            id={`${id}-models`}
            rows={2}
            spellCheck={false}
            value={draft.models}
            onChange={(event) => onChange({ ...draft, models: event.target.value })}
            placeholder="model-a, model-b"
            className="min-h-14 font-mono text-xs"
          />
          <p className="text-[11px] text-muted-foreground">{t(`${MS}.providers.modelsHint`)}</p>
        </div>
      )}
    </div>
  );
}
