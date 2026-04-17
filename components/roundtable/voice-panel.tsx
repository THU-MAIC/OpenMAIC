'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Volume2, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { resolveAgentVoice, getAvailableProvidersWithVoices } from '@/lib/audio/voice-resolver';
import { playBrowserTTSPreview } from '@/lib/audio/browser-tts-preview';
import type { Participant } from '@/lib/types/roundtable';
import type { TTSProviderId } from '@/lib/audio/types';

interface VoicePanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Participant data for display (avatar, name). */
  readonly participant: Participant | null;
  /** Registry id — used to look up the live AgentConfig. */
  readonly participantId: string;
  /** Which type of participant this panel represents. */
  readonly profileType: 'teacher' | 'agent' | 'user';
  /** Position index among agents — used for default-voice fallback. */
  readonly agentIndex: number;
}

export function VoicePanel({
  open,
  onClose,
  participant,
  participantId,
  profileType,
  agentIndex,
}: VoicePanelProps) {
  const { t } = useI18n();

  // Teacher voice (settingsStore)
  const ttsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const ttsVoice = useSettingsStore((s) => s.ttsVoice);
  const setTTSProvider = useSettingsStore((s) => s.setTTSProvider);
  const setTTSVoice = useSettingsStore((s) => s.setTTSVoice);
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);

  // Agent config (registry) — reactive so voice badge updates live
  const agentConfig = useAgentRegistry((s) =>
    participantId ? s.getAgent(participantId) : undefined,
  );
  const updateAgent = useAgentRegistry((s) => s.updateAgent);

  const availableProviders = getAvailableProvidersWithVoices(ttsProvidersConfig);

  // Voice preview state
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const previewCancelRef = useRef<(() => void) | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);

  const stopPreview = useCallback(() => {
    previewCancelRef.current?.();
    previewCancelRef.current = null;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.src = '';
      previewAudioRef.current = null;
    }
    setPreviewingId(null);
  }, []);

  const handlePreview = useCallback(
    async (providerId: TTSProviderId, voiceId: string, modelId?: string) => {
      const key = `${providerId}::${voiceId}`;
      if (previewingId === key) {
        stopPreview();
        return;
      }
      stopPreview();
      setPreviewingId(key);

      const courseLanguage =
        (typeof localStorage !== 'undefined' && localStorage.getItem('generationLanguage')) ||
        'zh-CN';
      const previewText = courseLanguage === 'en-US' ? 'Welcome to AI Classroom' : '欢迎来到AI课堂';

      if (providerId === 'browser-native-tts') {
        const { promise, cancel } = playBrowserTTSPreview({ text: previewText, voice: voiceId });
        previewCancelRef.current = cancel;
        try {
          await promise;
        } catch {
          // ignore abort
        }
        setPreviewingId(null);
        return;
      }

      try {
        const controller = new AbortController();
        previewAbortRef.current = controller;
        const providerConfig = ttsProvidersConfig[providerId];
        const res = await fetch('/api/generate/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: previewText,
            audioId: 'voice-preview',
            ttsProviderId: providerId,
            ttsModelId: modelId || providerConfig?.modelId,
            ttsVoice: voiceId,
            ttsSpeed: 1,
            ttsApiKey: providerConfig?.apiKey,
            ttsBaseUrl: providerConfig?.serverBaseUrl || providerConfig?.baseUrl,
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('TTS error');
        const data = await res.json();
        if (!data.base64) throw new Error('No audio');
        const audio = new Audio(`data:audio/${data.format || 'mp3'};base64,${data.base64}`);
        previewAudioRef.current = audio;
        audio.addEventListener('ended', () => setPreviewingId(null));
        audio.addEventListener('error', () => setPreviewingId(null));
        await audio.play();
      } catch {
        setPreviewingId(null);
      }
    },
    [previewingId, stopPreview, ttsProvidersConfig],
  );

  // Stop preview on unmount
  useEffect(() => () => stopPreview(), [stopPreview]);

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      stopPreview();
      onClose();
    }
  };

  const handleSelectVoice = (providerId: TTSProviderId, voiceId: string, modelId?: string) => {
    if (profileType === 'teacher' || profileType === 'user') {
      setTTSProvider(providerId);
      setTTSVoice(voiceId);
    } else if (agentConfig) {
      updateAgent(agentConfig.id, {
        voiceConfig: { providerId, modelId: modelId || undefined, voiceId },
      });
    }
  };

  // Resolve the currently-active voice for this person
  const resolvedVoice = profileType === 'teacher' || profileType === 'user'
    ? { providerId: ttsProviderId, voiceId: ttsVoice || '', modelId: undefined as string | undefined }
    : agentConfig
      ? resolveAgentVoice(agentConfig, agentIndex, availableProviders)
      : null;

  const isVoiceActive = (providerId: TTSProviderId, voiceId: string, modelId?: string) => {
    if (!resolvedVoice) return false;
    return (
      resolvedVoice.providerId === providerId &&
      resolvedVoice.voiceId === voiceId &&
      (resolvedVoice.modelId || '') === (modelId || '')
    );
  };

  // Role badge
  const roleLabelKey =
    profileType === 'teacher'
      ? 'teacher'
      : profileType === 'agent'
        ? agentConfig?.role?.toLowerCase().replace(/\s+/g, '-') || ''
        : '';
  const resolvedRoleLabel =
    profileType === 'user'
      ? t('roundtable.you')
      : roleLabelKey
        ? t(`settings.agentRoles.${roleLabelKey}`)
        : '';
  const showRoleLabel =
    !!resolvedRoleLabel &&
    !resolvedRoleLabel.startsWith('settings.agentRoles.') &&
    resolvedRoleLabel !== 'roundtable.you';
  const agentColor =
    profileType === 'teacher'
      ? '#8b5cf6'
      : profileType === 'user'
        ? '#7c3aed'
        : agentConfig?.color || '#6b7280';
  const persona = profileType === 'agent' ? agentConfig?.persona || '' : '';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton className="max-w-xs p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">{t('roundtable.changeVoice')}</DialogTitle>

        {/* Profile header */}
        <div className="flex items-center gap-3 px-4 pt-5 pb-4 border-b border-border/50">
          <div
            className="w-12 h-12 rounded-full overflow-hidden shrink-0 bg-gray-100 dark:bg-gray-800 ring-2 ring-offset-1"
            style={{ '--tw-ring-color': agentColor } as Record<string, string>}
          >
            {participant?.avatar && (
              <img
                src={participant.avatar}
                alt={participant.name}
                className="w-full h-full object-cover"
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm truncate">{participant?.name || '—'}</p>
            {(showRoleLabel || profileType === 'user') && (
              <span
                className="inline-block text-[11px] leading-tight px-1.5 py-0.5 rounded-full text-white mt-0.5"
                style={{ backgroundColor: agentColor }}
              >
                {profileType === 'user' ? t('roundtable.you') : resolvedRoleLabel}
              </span>
            )}
          </div>
        </div>

        {/* Persona snippet */}
        {persona && (
          <div className="px-4 py-3 border-b border-border/50">
            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{persona}</p>
          </div>
        )}

        {/* Voice selector */}
        <div className="px-4 py-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Volume2 className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t('roundtable.changeVoice')}
            </span>
          </div>

          {!ttsEnabled ? (
            <p className="text-xs text-muted-foreground/60 py-2">{t('agentBar.voiceAutoAssign')}</p>
          ) : availableProviders.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 py-2">{t('agentBar.voiceLoading')}</p>
          ) : (
            <div className="max-h-52 overflow-y-auto -mx-1">
              {availableProviders.map((provider) =>
                provider.modelGroups.map((group) => (
                  <div key={`${provider.providerId}::${group.modelId}`}>
                    <div className="text-[10px] text-muted-foreground/50 font-medium px-2 py-1 sticky top-0 bg-background">
                      {group.modelId
                        ? `${provider.providerName} · ${group.modelName}`
                        : provider.providerName}
                    </div>
                    {group.voices.map((voice) => {
                      const isActive = isVoiceActive(
                        provider.providerId,
                        voice.id,
                        group.modelId,
                      );
                      const previewKey = `${provider.providerId}::${voice.id}`;
                      const isPreviewing = previewingId === previewKey;
                      return (
                        <div
                          key={previewKey}
                          className={cn(
                            'flex items-center gap-1 rounded px-1 transition-colors',
                            isActive ? 'bg-primary/10' : 'hover:bg-muted',
                          )}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              handleSelectVoice(provider.providerId, voice.id, group.modelId)
                            }
                            className={cn(
                              'flex-1 text-left text-[13px] px-1 py-1.5 min-w-0 truncate',
                              isActive ? 'text-primary font-medium' : 'text-foreground',
                            )}
                          >
                            {voice.name}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              handlePreview(provider.providerId, voice.id, group.modelId)
                            }
                            className={cn(
                              'shrink-0 size-6 flex items-center justify-center rounded transition-colors',
                              isPreviewing
                                ? 'text-primary'
                                : 'text-muted-foreground/40 hover:text-muted-foreground',
                            )}
                          >
                            {isPreviewing ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Volume2 className="size-3.5" />
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )),
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
