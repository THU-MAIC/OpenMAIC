'use client';

import { useEffect, useRef, useState } from 'react';
import { BookmarkMinus, Loader2, MoreHorizontal, Plus, Trash2, Upload } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AccountVoice, ConfiguredTTSVoice } from '@/lib/audio/types';
import type { useAccountVoices } from '@/lib/audio/use-account-voices';
import { registerVoiceFromReference } from '@/lib/audio/voice-registration-client';
import {
  normalizeMiniMaxReferenceAudio,
  removeLocalMiniMaxVoice,
  saveMiniMaxVoice,
  useAllVoiceProfiles,
} from '@/lib/audio/voxcpm-voices';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { cn } from '@/lib/utils';
import { VoicePreviewButton } from './voice-preview-button';

const providerId = 'minimax-tts';

interface MiniMaxVoiceManagerProps {
  serviceId: string;
  settingsRevision: number;
  account: ReturnType<typeof useAccountVoices>;
  selectedVoice: string;
  configuredVoices?: ConfiguredTTSVoice[];
  onPreview: (id: string) => Promise<void>;
  previewingVoiceId: string | null;
  canPreview: boolean;
}

export function MiniMaxVoiceManager(props: MiniMaxVoiceManagerProps) {
  const local = useAllVoiceProfiles();
  return <MiniMaxVoiceEditor key={local.miniMaxAccountScope} {...props} local={local} />;
}

function MiniMaxVoiceEditor({
  serviceId,
  settingsRevision,
  selectedVoice,
  configuredVoices,
  onPreview,
  previewingVoiceId,
  canPreview,
  local,
  account,
}: MiniMaxVoiceManagerProps & {
  local: ReturnType<typeof useAllVoiceProfiles>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [operation, setOperation] = useState<'create' | 'remove' | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const saved = local.profiles.filter((profile) => profile.providerId === providerId);
  const rows = new Map<
    string,
    { id: string; name: string; kind: AccountVoice['kind']; local: boolean }
  >();
  for (const profile of saved) {
    rows.set(profile.id, { id: profile.id, name: profile.name, kind: 'clone', local: true });
  }
  for (const voice of account.voices) {
    const existing = rows.get(voice.id);
    if (existing) existing.kind = voice.kind;
    else if (voice.kind !== 'system') rows.set(voice.id, { ...voice, local: false });
  }
  const nameCounts = new Map<string, number>();
  for (const { name } of rows.values()) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const confirming = account.canDeleteRemote && confirmId ? rows.get(confirmId) : undefined;
  useEffect(() => {
    if (confirmId && (!confirming || confirming.kind === 'system')) setConfirmId(null);
  }, [confirmId, confirming]);

  const createVoice = async () => {
    const scope = local.miniMaxAccountScope;
    if (!scope || !file || !name.trim()) return;
    setOperation('create');
    setError('');
    try {
      const audio = await normalizeMiniMaxReferenceAudio(file);
      if (!mounted.current) return;
      const id = await registerVoiceFromReference(providerId, {
        name: name.trim(),
        accountScope: scope,
        referenceAudio: audio.blob,
        expectedServiceId: serviceId,
        expectedRevision: settingsRevision,
      });
      // Registration may complete after navigation. Keep the result with its original account.
      await saveMiniMaxVoice(id, name, scope);
      if (mounted.current) {
        setName('');
        setFile(null);
        if (fileInput.current) fileInput.current.value = '';
        account.refresh();
      }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setOperation(null);
    }
  };

  const removeVoice = async (id: string, atProvider: boolean) => {
    const row = rows.get(id);
    if (!row) return;
    setOperation('remove');
    setError('');
    try {
      if (atProvider) {
        if (!account.canDeleteRemote || row.kind === 'system') return;
        const response = await fetch('/api/generate/voice', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerId,
            expectedServiceId: serviceId,
            expectedRevision: settingsRevision,
            voiceId: id,
            kind: row.kind,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success !== true || data.vendorDeleted !== true) {
          throw new Error(
            typeof data.error === 'string' ? data.error : t('settings.minimaxDeleteFailed'),
          );
        }
        if (mounted.current) account.refresh();
      }
      if (row.local && local.miniMaxAccountScope) {
        await removeLocalMiniMaxVoice(id, local.miniMaxAccountScope);
      }
      if (!mounted.current) return;
      let stillListed =
        account.voices.some((voice) => voice.id === id) ||
        configuredVoices?.some((voice) => voice.id === id);
      // The voice may also have been activated by a class since the list was last read.
      if (!atProvider && !configuredVoices?.length && !stillListed) {
        const voices = await account.refresh();
        if (!mounted.current) return;
        stillListed = voices?.some((voice) => voice.id === id);
      }
      const state = useSettingsStore.getState();
      if (
        (atProvider || !stillListed) &&
        state.ttsVoiceProviderId === providerId &&
        state.ttsVoice === id
      ) {
        state.setTTSVoice('', providerId);
      }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setOperation(null);
    }
  };

  return (
    <section className="space-y-3">
      <h3 className="text-base font-semibold">{t('settings.minimaxVoicesTitle')}</h3>
      <p className="text-xs text-muted-foreground">{t('settings.minimaxReferenceHint')}</p>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <div className="min-w-0">
          <Label className="sr-only" htmlFor="minimax-voice-name">
            {t('settings.voxcpmCloneVoiceNamePlaceholder')}
          </Label>
          <Input
            id="minimax-voice-name"
            placeholder={t('settings.voxcpmCloneVoiceNamePlaceholder')}
            value={name}
            disabled={busy || !local.miniMaxAccountScope}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <input
          ref={fileInput}
          id="minimax-reference"
          type="file"
          accept="audio/*"
          hidden
          disabled={busy || !local.miniMaxAccountScope}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy || !local.miniMaxAccountScope}
          onClick={() => fileInput.current?.click()}
          aria-label={t('settings.voxcpmUploadReferenceAudio')}
          title={file?.name}
        >
          <Upload />
          <span className="max-w-44 truncate">
            {file?.name || t('settings.voxcpmUploadReferenceAudio')}
          </span>
        </Button>
        <Button
          type="button"
          disabled={busy || !file || !name.trim() || !local.miniMaxAccountScope}
          onClick={() => void createVoice()}
        >
          {operation === 'create' ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          {t('settings.voxcpmAddClone')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.minimaxActivationHint')}</p>
      {rows.size > 0 ? (
        <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
          {[...rows.values()].map((row) => (
            <li
              key={row.id}
              className={cn(
                'group flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2',
                selectedVoice === row.id ? 'bg-primary/10' : 'hover:bg-muted/35',
              )}
            >
              <div className="min-w-32 flex-1">
                <div
                  title={row.name === row.id ? row.name : `${row.name} · ${row.id}`}
                  className={cn(
                    'truncate text-sm font-medium',
                    selectedVoice === row.id && 'text-primary',
                  )}
                >
                  {row.name}
                </div>
                {row.name !== row.id && (nameCounts.get(row.name) ?? 0) > 1 && (
                  <div title={row.id} className="truncate text-xs text-muted-foreground">
                    {row.id}
                  </div>
                )}
              </div>
              <div className="ms-auto flex max-w-full items-center gap-1">
                <VoicePreviewButton
                  previewing={previewingVoiceId === row.id}
                  disabled={previewingVoiceId !== row.id && (!canPreview || busy)}
                  onClick={() => void onPreview(row.id)}
                />
                <Button
                  type="button"
                  variant={selectedVoice === row.id ? 'secondary' : 'outline'}
                  size="sm"
                  className="h-auto min-h-8 min-w-0 shrink whitespace-normal"
                  aria-pressed={selectedVoice === row.id}
                  onClick={() => useSettingsStore.getState().setTTSVoice(row.id, providerId)}
                >
                  {t(
                    selectedVoice === row.id
                      ? 'settings.serverConfig.inUse'
                      : 'settings.serverConfig.useForNarration',
                  )}
                </Button>
                {(row.local || (account.canDeleteRemote && row.kind !== 'system')) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground"
                        aria-label={t('settings.more')}
                        disabled={busy}
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-max max-w-[calc(100vw-2rem)]">
                      {row.local && (
                        <DropdownMenuItem onSelect={() => void removeVoice(row.id, false)}>
                          <BookmarkMinus />
                          {t('settings.minimaxRemoveLocal')}
                        </DropdownMenuItem>
                      )}
                      {account.canDeleteRemote && row.kind !== 'system' && (
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setConfirmId(row.id)}
                        >
                          <Trash2 />
                          {t('settings.minimaxDeleteRemote')}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : !local.error && !account.error ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t(account.loading || local.loading ? 'common.loading' : 'settings.voxcpmNoCustomVoices')}
        </p>
      ) : null}
      {(error || local.error || account.error) && (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          {error || local.error || account.error}
          {(local.error || account.error) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void local.refresh();
                account.refresh();
              }}
            >
              {t('common.retry')}
            </Button>
          )}
        </div>
      )}
      <AlertDialog
        open={!!confirming && confirming.kind !== 'system'}
        onOpenChange={(open) => !open && setConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.minimaxDeleteRemote')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.minimaxDeleteConfirm', { name: confirming?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirming) void removeVoice(confirming.id, true);
              }}
            >
              {t('settings.minimaxDeleteRemote')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
