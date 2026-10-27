import { useState, useRef, useCallback, useEffect } from 'react';
import type { ASRProviderId } from '@/lib/audio/types';
import { normalizeASRUploadAudio } from '@/lib/audio/wav-utils';
import { loadModelCapabilities } from '@/lib/model-settings/capabilities';
import { createLogger } from '@/lib/logger';
import { useI18n } from '@/lib/hooks/use-i18n';

const log = createLogger('AudioRecorder');

/** Shown when the workspace's asr slot resolves to nothing. */
export const ASR_NOT_CONFIGURED_MESSAGE = 'Speech recognition is not set up';

/**
 * The provider the workspace's asr slot resolves to (its registry id), and the
 * user's language for it. The provider, model and key are the server's.
 */
async function asrSetup(
  locale: string,
): Promise<{ providerId: ASRProviderId; language: string } | null> {
  const [{ asr }, { useSettingsStore, resolveASRLanguage }] = await Promise.all([
    loadModelCapabilities(),
    import('@/lib/store/settings'),
  ]);
  if (!asr) return null;
  const providerId = asr.registryId as ASRProviderId;
  return {
    providerId,
    language: resolveASRLanguage(providerId, useSettingsStore.getState().asrLanguage, locale),
  };
}

// Window.SpeechRecognition / webkitSpeechRecognition have minimal constructor
// declarations in types/web-speech.d.ts; this hook casts the richer instance.

export interface UseAudioRecorderOptions {
  onTranscription?: (text: string) => void;
  onError?: (error: string) => void;
  /** When true and using browser-native ASR, recognition stays active until explicitly stopped. */
  continuous?: boolean;
}

export function useAudioRecorder(options: UseAudioRecorderOptions = {}) {
  const { onTranscription, onError, continuous = false } = options;
  const { locale } = useI18n();
  const localeRef = useRef(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  const [isStarting, setIsStarting] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Web Speech API not typed
  const speechRecognitionRef = useRef<any>(null);
  // Synchronous lock to prevent rapid re-entry (React state updates are async)
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const sessionRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);

  const isCurrentSession = useCallback(
    (session: number) => mountedRef.current && sessionRef.current === session,
    [],
  );

  const clearRecordingTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Resource-only cleanup: safe during unmount, without uploading or updating state.
  const releaseResources = useCallback(() => {
    clearRecordingTimer();
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    const recognition = speechRecognitionRef.current;
    speechRecognitionRef.current = null;
    if (recognition) {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // An already-ended recognizer must not prevent the remaining cleanup.
      }
    }
    const mediaRecorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (mediaRecorder) {
      mediaRecorder.ondataavailable = null;
      mediaRecorder.onstop = null;
      try {
        if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      } catch {
        // Always release the tracks even if the recorder has already stopped.
      }
    }
    const stream = streamRef.current ?? mediaRecorder?.stream;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    audioChunksRef.current = [];
    busyRef.current = false;
  }, [clearRecordingTimer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionRef.current += 1;
      releaseResources();
    };
  }, [releaseResources]);

  // Send audio to server for transcription
  const transcribeAudio = useCallback(
    async (audioBlob: Blob, session: number) => {
      if (!isCurrentSession(session)) return;
      const controller = new AbortController();
      transcriptionAbortRef.current = controller;
      setIsProcessing(true);

      try {
        const formData = new FormData();

        // The asr slot names the provider and model on the server; the
        // upload format and the language follow the provider it resolves to.
        // onstop 持有开始录音时的回调；转录时读取最新语言，避免录音期间切换界面后仍用旧值。
        const setup = typeof window !== 'undefined' ? await asrSetup(localeRef.current) : null;
        if (setup) {
          const uploadAudio = await normalizeASRUploadAudio(setup.providerId, audioBlob);
          formData.append('audio', uploadAudio.blob, uploadAudio.fileName);
          formData.append('language', setup.language);
        } else {
          formData.append('audio', audioBlob, 'recording.webm');
        }

        if (!isCurrentSession(session)) return;
        const response = await fetch('/api/transcription', {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Transcription failed');
        }

        const result = await response.json();
        if (isCurrentSession(session)) onTranscription?.(result.text);
      } catch (error) {
        if (!isCurrentSession(session) || controller.signal.aborted) return;
        log.error('Transcription error:', error);
        onError?.(error instanceof Error ? error.message : '语音识别失败，请重试');
      } finally {
        if (isCurrentSession(session)) {
          transcriptionAbortRef.current = null;
          busyRef.current = false;
          setIsProcessing(false);
          setRecordingTime(0);
        }
      }
    },
    [onTranscription, onError, isCurrentSession],
  );

  // Start recording
  const startRecording = useCallback(async () => {
    // Synchronous lock — React state is async so isRecording may be stale
    if (!mountedRef.current || busyRef.current) return;
    const session = ++sessionRef.current;
    busyRef.current = true;
    setIsStarting(true);
    try {
      // Get current ASR configuration
      if (typeof window !== 'undefined') {
        // Nothing to record with when the asr slot is off or unassigned.
        const setup = await asrSetup(locale);
        if (!isCurrentSession(session)) return;
        if (!setup) {
          // Release the lock: a later click (once speech input is set up) must work.
          busyRef.current = false;
          setIsStarting(false);
          onError?.(ASR_NOT_CONFIGURED_MESSAGE);
          return;
        }
        const asrLanguage = setup.language;

        // Use browser native ASR if configured
        if (setup.providerId === 'browser-native') {
          // Check if Speech Recognition is supported
          if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
            busyRef.current = false;
            setIsStarting(false);
            onError?.('您的浏览器不支持语音识别功能');
            return;
          }

          const SpeechRecognitionCtor = (window.SpeechRecognition ||
            window.webkitSpeechRecognition)!;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Web Speech API instance shape isn't in lib.dom
          const recognition: any = new SpeechRecognitionCtor();

          recognition.lang = asrLanguage;
          recognition.continuous = continuous;
          recognition.interimResults = false;

          recognition.onstart = () => {
            if (!isCurrentSession(session)) return;
            setIsStarting(false);
            setIsRecording(true);
            setRecordingTime(0);

            // Start timer
            timerRef.current = setInterval(() => {
              setRecordingTime((prev) => prev + 1);
            }, 1000);
          };

          recognition.onresult = (event: {
            resultIndex: number;
            results: {
              [index: number]: {
                isFinal: boolean;
                [index: number]: { transcript: string };
              };
              length: number;
            };
          }) => {
            if (!isCurrentSession(session)) return;
            let transcript = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const result = event.results[i];
              if (result.isFinal && result[0]?.transcript) {
                transcript += result[0].transcript;
              }
            }
            if (transcript) {
              onTranscription?.(transcript);
            }
          };

          recognition.onerror = (event: { error: string }) => {
            if (!isCurrentSession(session)) return;
            setIsStarting(false);
            log.error('Speech recognition error:', event.error);
            let errorMessage = '语音识别失败';

            switch (event.error) {
              case 'aborted':
                // Non-fatal: caused by our own cancel/stop logic or rapid toggle
                busyRef.current = false;
                setIsRecording(false);
                setRecordingTime(0);
                if (timerRef.current) {
                  clearInterval(timerRef.current);
                  timerRef.current = null;
                }
                return;
              case 'no-speech':
                errorMessage = '未检测到语音输入';
                break;
              case 'audio-capture':
                errorMessage = '无法访问麦克风';
                break;
              case 'not-allowed':
                errorMessage = '麦克风权限被拒绝';
                break;
              case 'network':
                errorMessage = '网络错误';
                break;
              default:
                errorMessage = `语音识别错误: ${event.error}`;
            }

            onError?.(errorMessage);
            busyRef.current = false;
            setIsRecording(false);
            setRecordingTime(0);
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
          };

          recognition.onend = () => {
            if (!isCurrentSession(session)) return;
            speechRecognitionRef.current = null;
            setIsStarting(false);
            busyRef.current = false;
            setIsRecording(false);
            setRecordingTime(0);
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
          };

          speechRecognitionRef.current = recognition;
          recognition.start();
          return;
        }
      }

      // Use MediaRecorder for server-side ASR
      // Request microphone permission
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrentSession(session)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm',
      });

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (isCurrentSession(session) && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Stop all audio tracks
        stream.getTracks().forEach((track) => track.stop());
        if (!isCurrentSession(session)) return;
        streamRef.current = null;
        mediaRecorderRef.current = null;
        clearRecordingTimer();
        setIsRecording(false);

        // Merge audio chunks
        const audioBlob = new Blob(audioChunksRef.current, {
          type: 'audio/webm',
        });

        // Send to server for transcription
        await transcribeAudio(audioBlob, session);
      };

      // Start recording
      mediaRecorder.start();
      setIsStarting(false);
      setIsRecording(true);
      setRecordingTime(0);

      // Start timer
      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch (error) {
      if (!isCurrentSession(session)) return;
      releaseResources();
      setIsStarting(false);
      setIsRecording(false);
      setIsProcessing(false);
      log.error('Failed to start recording:', error);
      onError?.('无法访问麦克风，请检查权限设置');
    }
  }, [
    onTranscription,
    onError,
    transcribeAudio,
    continuous,
    locale,
    isCurrentSession,
    releaseResources,
    clearRecordingTimer,
  ]);

  // Explicit stop preserves the final transcription; cancellation discards it.
  const stopRecording = useCallback(() => {
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.stop();
      setIsStarting(false);
      setIsRecording(false);
      clearRecordingTimer();
      return;
    }
    const mediaRecorder = mediaRecorderRef.current;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      setIsRecording(false);
      setIsProcessing(true);
      clearRecordingTimer();
    }
  }, [clearRecordingTimer]);

  const cancelRecording = useCallback(() => {
    sessionRef.current += 1;
    releaseResources();
    if (mountedRef.current) {
      setIsStarting(false);
      setIsRecording(false);
      setIsProcessing(false);
      setRecordingTime(0);
    }
  }, [releaseResources]);

  return {
    isStarting,
    isRecording,
    isProcessing,
    recordingTime,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
