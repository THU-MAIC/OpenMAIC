'use client';

/**
 * The voices a user makes for voice-design and voice-clone providers (VoxCPM,
 * Qwen): kept per user, shown in the text-to-speech panel when the workspace
 * uses that provider.
 */
import { useState, useEffect, useRef, type ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { slotVoxCPMBackend } from '@/lib/audio/tts-selection';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import { DEFAULT_TTS_VOICES } from '@/lib/audio/constants';
import {
  Volume2,
  Loader2,
  Plus,
  Trash2,
  Upload,
  Wand2,
  FileAudio,
  Mic,
  Square,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useTTSPreview } from '@/lib/audio/use-tts-preview';
import {
  getVoxCPMProviderOptions,
  normalizeQwenReferenceAudio,
  preserveRecordedVoiceName,
  normalizeVoxCPMReferenceAudio,
  validateVoxCPMReferenceAudio,
  VOXCPM_REFERENCE_AUDIO_MAX_SECONDS,
  useVoxCPMVoiceProfiles,
  useQwenVoiceProfiles,
} from '@/lib/audio/voxcpm-voices';
import {
  VOXCPM_TTS_PROVIDER_ID,
  getVoxCPMProfileVoiceId,
  voxCPMBackendSupportsReferenceAudio,
} from '@/lib/audio/voxcpm';

export function VoxCPMVoiceManager() {
  const { t, locale } = useI18n();
  const { profiles, addPromptVoice, addCloneVoice, deleteVoice } = useVoxCPMVoiceProfiles();
  const ttsSpeed = useSettingsStore((state) => state.ttsSpeed);
  const { previewing, startPreview, stopPreview } = useTTSPreview();
  // The backend is the tts slot's provider option (openmaic.yml `options`).
  const voxcpmBackend = slotVoxCPMBackend(useModelCapabilities().tts);
  const supportsReferenceAudio = voxCPMBackendSupportsReferenceAudio(voxcpmBackend);

  const [createMode, setCreateMode] = useState<'prompt' | 'clone'>('prompt');
  const [promptName, setPromptName] = useState('');
  const [voicePrompt, setVoicePrompt] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [clonePromptText, setClonePromptText] = useState('');
  const [cloneVoicePrompt, setCloneVoicePrompt] = useState('');
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [saving, setSaving] = useState<'prompt' | 'clone' | null>(null);
  const [isRecordingReference, setIsRecordingReference] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRecordingTimer = () => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  };

  const stopRecordingStream = () => {
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
  };

  const startReferenceRecording = async () => {
    if (isRecordingReference) return;
    if (
      typeof navigator === 'undefined' ||
      typeof MediaRecorder === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      toast.error(t('settings.voxcpmRecordingUnsupported'));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : undefined;
      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingChunksRef.current = [];
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      mediaRecorder.onstop = () => {
        void (async () => {
          const type = mediaRecorder.mimeType || 'audio/webm';
          const blob = new Blob(recordingChunksRef.current, { type });
          if (blob.size > 0) {
            try {
              const referenceAudio = await normalizeVoxCPMReferenceAudio(
                blob,
                `voxcpm-reference-${Date.now()}.webm`,
              );
              const file = new File([referenceAudio.blob], referenceAudio.name, {
                type: referenceAudio.mimeType,
              });
              setCloneFile(file);
              if (!cloneName.trim()) setCloneName(t('settings.voxcpmRecordedVoiceName'));
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : t('settings.voxcpmRecordingFailed'),
              );
            }
          }
          recordingChunksRef.current = [];
          setIsRecordingReference(false);
          setRecordingSeconds(0);
          stopRecordingTimer();
          stopRecordingStream();
        })();
      };

      mediaRecorder.start();
      setIsRecordingReference(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((seconds) => {
          const nextSeconds = seconds + 1;
          if (nextSeconds >= VOXCPM_REFERENCE_AUDIO_MAX_SECONDS) {
            stopReferenceRecording();
          }
          return nextSeconds;
        });
      }, 1000);
    } catch (error) {
      setIsRecordingReference(false);
      stopRecordingTimer();
      stopRecordingStream();
      toast.error(
        error instanceof Error ? error.message : t('settings.voxcpmRecordingStartFailed'),
      );
    }
  };

  const stopReferenceRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  };

  useEffect(() => {
    return () => {
      stopRecordingTimer();
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      stopRecordingStream();
    };
  }, []);

  useEffect(() => {
    if (!previewing) setPreviewingVoiceId(null);
  }, [previewing]);

  const handlePreviewVoice = async (voiceId: string) => {
    if (previewingVoiceId === voiceId) {
      stopPreview();
      setPreviewingVoiceId(null);
      return;
    }

    setPreviewingVoiceId(voiceId);
    try {
      const providerOptions = await getVoxCPMProviderOptions(voiceId, {
        backend: voxcpmBackend,
        role: 'teacher',
        locale,
      });
      await startPreview({
        text: t('settings.ttsTestTextDefault'),
        providerId: VOXCPM_TTS_PROVIDER_ID,
        voice: voiceId,
        speed: ttsSpeed,
        providerOptions,
      });
    } catch (error) {
      setPreviewingVoiceId(null);
      toast.error(error instanceof Error ? error.message : t('settings.voxcpmPreviewFailed'));
    }
  };

  const handleAddPromptVoice = async () => {
    if (!promptName.trim() || !voicePrompt.trim()) return;
    setSaving('prompt');
    try {
      await addPromptVoice({
        name: promptName,
        voicePrompt,
      });
      setPromptName('');
      setVoicePrompt('');
      toast.success(t('settings.voxcpmVoiceSaved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.voxcpmVoiceSaveFailed'));
    } finally {
      setSaving(null);
    }
  };

  const handleCloneFileChange = async (file: File | null) => {
    if (!file) {
      setCloneFile(null);
      return;
    }
    try {
      await validateVoxCPMReferenceAudio(file);
      setCloneFile(file);
    } catch (error) {
      setCloneFile(null);
      toast.error(
        error instanceof Error ? error.message : t('settings.voxcpmReferenceAudioInvalid'),
      );
    }
  };

  const handleAddCloneVoice = async () => {
    if (!cloneName.trim() || !cloneFile) return;
    setSaving('clone');
    try {
      await addCloneVoice({
        name: cloneName,
        referenceAudio: cloneFile,
        referenceAudioName: cloneFile.name,
        referenceAudioMimeType: cloneFile.type,
        promptText: clonePromptText,
        voicePrompt: cloneVoicePrompt,
      });
      setCloneName('');
      setClonePromptText('');
      setCloneVoicePrompt('');
      setCloneFile(null);
      toast.success(t('settings.voxcpmCloneSaved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.voxcpmCloneSaveFailed'));
    } finally {
      setSaving(null);
    }
  };

  const promptCount = profiles.filter((profile) => profile.kind !== 'clone').length;
  const cloneCount = profiles.filter((profile) => profile.kind === 'clone').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Label className="text-base font-semibold">{t('settings.voxcpmVoicesTitle')}</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('settings.voxcpmVoicesDescription')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            {t('settings.voxcpmAutoVoicePrivacyNote')}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="rounded-md border border-border/60 px-2 py-1">
            {t('settings.voxcpmPromptCount', { count: promptCount + 1 })}
          </span>
          <span className="rounded-md border border-border/60 px-2 py-1">
            {t('settings.voxcpmCloneCount', { count: cloneCount })}
          </span>
          {!supportsReferenceAudio && (
            <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300">
              {t('settings.voxcpmCloneUnsupported')}
            </span>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border/70 bg-background">
        <div className="grid lg:grid-cols-[minmax(280px,0.95fr)_minmax(0,1.15fr)]">
          <section className="border-b border-border/60 lg:border-b-0 lg:border-r">
            <div className="flex h-12 items-center justify-between border-b border-border/60 px-4">
              <span className="text-sm font-medium">{t('settings.voxcpmVoicePool')}</span>
              <span className="text-xs text-muted-foreground">
                {t('settings.voxcpmVoiceCount', { count: profiles.length + 1 })}
              </span>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              <VoiceProfileRow
                icon={<Wand2 className="h-4 w-4" />}
                title={t('settings.voxcpmAutoVoice')}
                badge={t('toolbar.default')}
                badgeTone="default"
                detail={t('settings.voxcpmAutoVoiceDescription')}
                kind="auto"
              />
              {profiles.length > 0 ? (
                profiles.map((profile) => {
                  const voiceId = getVoxCPMProfileVoiceId(profile.id);
                  const canPreview = profile.kind !== 'clone' || supportsReferenceAudio;
                  return (
                    <VoiceProfileRow
                      key={profile.id}
                      icon={
                        profile.kind === 'clone' ? (
                          <FileAudio className="h-4 w-4" />
                        ) : (
                          <Wand2 className="h-4 w-4" />
                        )
                      }
                      title={profile.name}
                      badge={
                        profile.kind === 'clone' && !supportsReferenceAudio
                          ? t('settings.voxcpmUnavailable')
                          : profile.kind === 'clone'
                            ? t('settings.voxcpmClone')
                            : 'Prompt'
                      }
                      badgeTone={
                        profile.kind === 'clone' && !supportsReferenceAudio ? 'warning' : 'neutral'
                      }
                      detail={
                        profile.kind === 'clone' && !supportsReferenceAudio
                          ? t('settings.voxcpmCloneUnsupportedDetail')
                          : profile.kind === 'clone'
                            ? profile.referenceAudioName || 'reference audio'
                            : profile.voicePrompt || ''
                      }
                      kind={profile.kind === 'clone' ? 'clone' : 'prompt'}
                      muted={profile.kind === 'clone' && !supportsReferenceAudio}
                      previewing={canPreview && previewingVoiceId === voiceId}
                      onPreview={canPreview ? () => handlePreviewVoice(voiceId) : undefined}
                      onDelete={async () => {
                        await deleteVoice(profile.id);
                      }}
                    />
                  );
                })
              ) : (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground/60">
                  {t('settings.voxcpmNoCustomVoices')}
                </div>
              )}
            </div>
          </section>

          <section className="p-4">
            <Tabs
              value={createMode}
              onValueChange={(value) => setCreateMode(value as typeof createMode)}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <TabsList className="h-9 rounded-md bg-muted p-1">
                  <TabsTrigger value="prompt" className="gap-1.5 rounded-sm px-3 text-sm">
                    <Wand2 className="h-3.5 w-3.5" />
                    Prompt
                  </TabsTrigger>
                  <TabsTrigger value="clone" className="gap-1.5 rounded-sm px-3 text-sm">
                    <Upload className="h-3.5 w-3.5" />
                    {t('settings.voxcpmClone')}
                  </TabsTrigger>
                </TabsList>
                {createMode === 'clone' && !supportsReferenceAudio && (
                  <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300">
                    {t('settings.voxcpmCloneSaveOnly')}
                  </span>
                )}
              </div>

              <TabsContent value="prompt" className="mt-4 space-y-3">
                <Input
                  value={promptName}
                  onChange={(e) => setPromptName(e.target.value)}
                  placeholder={t('settings.voxcpmVoiceNamePlaceholder')}
                  className="h-10 rounded-md text-sm"
                />
                <Textarea
                  value={voicePrompt}
                  onChange={(e) => setVoicePrompt(e.target.value)}
                  placeholder={t('settings.voxcpmPromptPlaceholder')}
                  className="min-h-28 resize-none rounded-md text-sm"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={handleAddPromptVoice}
                    disabled={saving === 'prompt' || !promptName.trim() || !voicePrompt.trim()}
                    className="h-9 gap-1.5 rounded-md"
                  >
                    {saving === 'prompt' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    {t('settings.voxcpmAddVoice')}
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="clone" className="mt-4 space-y-3">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                  <Input
                    value={cloneName}
                    onChange={(e) => setCloneName(e.target.value)}
                    placeholder={t('settings.voxcpmCloneVoiceNamePlaceholder')}
                    className="h-10 rounded-md text-sm"
                  />
                  <label className="inline-flex h-10 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent hover:text-accent-foreground">
                    <Upload className="h-3.5 w-3.5 shrink-0" />
                    <span className="max-w-[180px] truncate">
                      {cloneFile ? cloneFile.name : t('settings.voxcpmUploadReferenceAudio')}
                    </span>
                    <input
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      onChange={(e) => {
                        void handleCloneFileChange(e.target.files?.[0] || null);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <Button
                    type="button"
                    variant={isRecordingReference ? 'destructive' : 'outline'}
                    size="sm"
                    onClick={
                      isRecordingReference ? stopReferenceRecording : startReferenceRecording
                    }
                    className="h-10 gap-2 rounded-md"
                  >
                    {isRecordingReference ? (
                      <>
                        <Square className="h-3.5 w-3.5" />
                        {formatRecordingTime(recordingSeconds)}
                      </>
                    ) : (
                      <>
                        <Mic className="h-3.5 w-3.5" />
                        {t('settings.voxcpmRecord')}
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground/70">
                  {t('settings.voxcpmReferenceAudioLimitHint')}
                </p>
                <Textarea
                  value={clonePromptText}
                  onChange={(e) => setClonePromptText(e.target.value)}
                  placeholder={t('settings.voxcpmReferenceTextPlaceholder')}
                  className="min-h-20 resize-none rounded-md text-sm"
                />
                <Input
                  value={cloneVoicePrompt}
                  onChange={(e) => setCloneVoicePrompt(e.target.value)}
                  placeholder={t('settings.voxcpmVoiceDescriptionPlaceholder')}
                  className="h-10 rounded-md text-sm"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={handleAddCloneVoice}
                    disabled={saving === 'clone' || !cloneName.trim() || !cloneFile}
                    className="h-9 gap-1.5 rounded-md"
                  >
                    {saving === 'clone' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    {t('settings.voxcpmAddClone')}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </section>
        </div>
      </div>
    </div>
  );
}

export function QwenVoiceCloneManager() {
  const { t } = useI18n();
  const { profiles, addCloneVoice, deleteVoice } = useQwenVoiceProfiles();
  const ttsVoiceProviderId = useSettingsStore((state) => state.ttsVoiceProviderId);
  const ttsVoice = useSettingsStore((state) => state.ttsVoice);
  const ttsSpeed = useSettingsStore((state) => state.ttsSpeed);
  const setTTSVoice = useSettingsStore((state) => state.setTTSVoice);
  const { previewing, startPreview, stopPreview } = useTTSPreview();

  const [name, setName] = useState('');
  const [refText, setRefText] = useState('');
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRecordingTimer = () => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  };

  const stopRecordingStream = () => {
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
  };

  const normalizeFile = async (file: File): Promise<File> => {
    const normalized = await normalizeQwenReferenceAudio(file, file.name);
    return new File([normalized.blob], normalized.name, { type: normalized.mimeType });
  };

  const handleFileChange = async (file: File | null) => {
    if (!file) {
      setReferenceFile(null);
      return;
    }
    try {
      setReferenceFile(await normalizeFile(file));
    } catch (error) {
      setReferenceFile(null);
      toast.error(error instanceof Error ? error.message : t('settings.qwenCloneSaveFailed'));
    }
  };

  const startRecording = async () => {
    if (isRecording) return;
    if (
      typeof navigator === 'undefined' ||
      typeof MediaRecorder === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      toast.error(t('settings.qwenCloneUnsupported'));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingChunksRef.current = [];
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        void (async () => {
          try {
            const blob = new Blob(recordingChunksRef.current, {
              type: recorder.mimeType || 'audio/webm',
            });
            if (blob.size > 0) {
              const file = new File([blob], `qwen-reference-${Date.now()}.webm`, {
                type: blob.type,
              });
              setReferenceFile(await normalizeFile(file));
              setName((currentName) =>
                preserveRecordedVoiceName(currentName, t('settings.voxcpmRecordedVoiceName')),
              );
            }
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t('settings.qwenCloneSaveFailed'));
          } finally {
            recordingChunksRef.current = [];
            setIsRecording(false);
            setRecordingSeconds(0);
            stopRecordingTimer();
            stopRecordingStream();
          }
        })();
      };
      recorder.start();
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((seconds) => {
          const nextSeconds = seconds + 1;
          if (nextSeconds >= 58 && mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop();
          }
          return nextSeconds;
        });
      }, 1000);
    } catch (error) {
      setIsRecording(false);
      stopRecordingTimer();
      stopRecordingStream();
      toast.error(error instanceof Error ? error.message : t('settings.qwenCloneUnsupported'));
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
  };

  useEffect(() => {
    return () => {
      stopRecordingTimer();
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
      stopRecordingStream();
    };
  }, []);

  useEffect(() => {
    if (!previewing) setPreviewingVoiceId(null);
  }, [previewing]);

  const handleSave = async () => {
    if (!name.trim() || !refText.trim() || !referenceFile) return;
    setSaving(true);
    try {
      const voiceId = await addCloneVoice({ name, referenceAudio: referenceFile, refText });
      // A new clone becomes the narration voice (this manager shows only while
      // the tts slot is Qwen).
      setTTSVoice(voiceId, 'qwen-tts');
      setName('');
      setRefText('');
      setReferenceFile(null);
      toast.success(t('settings.qwenCloneSaved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.qwenCloneSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async (voiceId: string) => {
    if (previewingVoiceId === voiceId) {
      stopPreview();
      setPreviewingVoiceId(null);
      return;
    }
    setPreviewingVoiceId(voiceId);
    try {
      await startPreview({
        text: t('settings.ttsTestTextDefault'),
        providerId: 'qwen-tts',
        voice: voiceId,
        speed: ttsSpeed,
      });
    } catch (error) {
      setPreviewingVoiceId(null);
      toast.error(error instanceof Error ? error.message : t('settings.qwenCloneSaveFailed'));
    }
  };

  const handleDelete = async (voiceId: string) => {
    const vendorDeleted = await deleteVoice(voiceId);
    if (!vendorDeleted) toast.warning(t('settings.qwenCloneDeleteWarning'));
    if (ttsVoiceProviderId === 'qwen-tts' && ttsVoice === voiceId) {
      setTTSVoice(DEFAULT_TTS_VOICES['qwen-tts'], 'qwen-tts');
    }
  };

  const recordingSupported =
    typeof navigator !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

  return (
    <div className="space-y-4 pt-2">
      <div>
        <Label className="text-base font-semibold leading-normal">
          {t('settings.qwenCloneVoicesTitle')}
        </Label>
        <p className="mt-1 text-xs text-muted-foreground">{t('settings.qwenCloneRefAudioHint')}</p>
        {!recordingSupported && (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-300">
            {t('settings.qwenCloneUnsupported')}
          </p>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-border/70 bg-background">
        <div className="grid lg:grid-cols-[minmax(0,45fr)_minmax(0,55fr)]">
          {/* 左：音色池（结果展示区） */}
          <section className="flex min-h-0 flex-col border-b border-border/50 lg:border-b-0">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/50 px-4">
              <span className="text-sm font-medium">{t('settings.voxcpmVoicePool')}</span>
              <span className="text-xs text-muted-foreground">
                {t('settings.voxcpmVoiceCount', { count: profiles.length })}
              </span>
            </div>
            <div className="max-h-[360px] min-h-[240px] overflow-y-auto">
              {profiles.length ? (
                profiles.map((profile) => (
                  <VoiceProfileRow
                    key={profile.id}
                    icon={<FileAudio className="h-4 w-4" />}
                    title={profile.name}
                    badge={t('settings.voxcpmClone')}
                    detail={profile.referenceAudioName || profile.id}
                    kind="clone"
                    previewing={previewingVoiceId === profile.id}
                    onPreview={() => handlePreview(profile.id)}
                    onDelete={() => handleDelete(profile.id)}
                  />
                ))
              ) : (
                <div className="flex min-h-[200px] items-center justify-center px-4 py-8 text-center text-sm text-muted-foreground/60">
                  {t('settings.voxcpmNoCustomVoices')}
                </div>
              )}
            </div>
          </section>

          {/* 右：创建音色（操作区，浅色卡片，暗表单自上而下按操作顺序） */}
          <section className="p-3">
            <div className="flex h-full flex-col gap-3 rounded-lg bg-muted/40 p-4">
              <div className="grid grid-cols-2 gap-2">
                <label className="inline-flex h-10 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent hover:text-accent-foreground">
                  <Upload className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">
                    {referenceFile ? referenceFile.name : t('settings.qwenCloneUploadShort')}
                  </span>
                  <input
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={(event) => {
                      void handleFileChange(event.target.files?.[0] || null);
                      event.target.value = '';
                    }}
                  />
                </label>
                <Button
                  type="button"
                  variant={isRecording ? 'destructive' : 'outline'}
                  disabled={!recordingSupported}
                  onClick={isRecording ? stopRecording : startRecording}
                  className="h-10 gap-2 rounded-md"
                >
                  {isRecording ? (
                    <>
                      <Square className="h-3.5 w-3.5" />
                      {formatRecordingTime(recordingSeconds)}
                    </>
                  ) : (
                    <>
                      <Mic className="h-3.5 w-3.5" />
                      {t('settings.voxcpmRecord')}
                    </>
                  )}
                </Button>
              </div>
              <Textarea
                value={refText}
                onChange={(event) => setRefText(event.target.value)}
                placeholder={t('settings.qwenCloneRefText')}
                className="min-h-24 resize-none rounded-md text-sm"
              />
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('settings.voxcpmCloneVoiceNamePlaceholder')}
                className="h-10 rounded-md text-sm"
              />
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving || !name.trim() || !refText.trim() || !referenceFile}
                className="h-10 w-full gap-1.5 rounded-md"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                {t('settings.voxcpmAddClone')}
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function formatRecordingTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function VoiceProfileRow({
  icon,
  title,
  badge,
  badgeTone = 'neutral',
  detail,
  kind = 'prompt',
  muted,
  previewing,
  onPreview,
  onDelete,
}: {
  icon: ReactNode;
  title: string;
  badge: string;
  badgeTone?: 'default' | 'warning' | 'neutral';
  detail: string;
  kind?: 'auto' | 'prompt' | 'clone';
  muted?: boolean;
  previewing?: boolean;
  onPreview?: () => void;
  onDelete?: () => void | Promise<void>;
}) {
  const iconClassName =
    kind === 'auto'
      ? 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300'
      : kind === 'clone'
        ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
        : 'bg-muted text-muted-foreground';
  const badgeClassName =
    badgeTone === 'default'
      ? 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800/70 dark:bg-violet-950/40 dark:text-violet-300'
      : badgeTone === 'warning'
        ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-300'
        : 'border-border/70 bg-background text-muted-foreground';
  const { t } = useI18n();

  return (
    <div
      className={cn(
        'group relative flex min-h-16 items-center gap-3 border-t border-border/50 px-4 py-3 first:border-t-0',
        muted ? 'opacity-60' : 'hover:bg-muted/35',
      )}
    >
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
          iconClassName,
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          <span
            className={cn(
              'rounded-md border px-1.5 py-0.5 text-[10px] leading-none',
              badgeClassName,
            )}
          >
            {badge}
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      {onPreview && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onPreview()}
          aria-label={
            previewing ? t('settings.voxcpmStopPreview') : t('settings.voxcpmPreviewVoice')
          }
          className="h-8 w-8 text-muted-foreground opacity-70 hover:text-foreground group-hover:opacity-100"
        >
          {previewing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Volume2 className="h-3.5 w-3.5" />
          )}
        </Button>
      )}
      {onDelete && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void onDelete()}
          aria-label={t('settings.voxcpmDeleteVoice')}
          className="h-8 w-8 text-muted-foreground opacity-70 hover:text-destructive group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
