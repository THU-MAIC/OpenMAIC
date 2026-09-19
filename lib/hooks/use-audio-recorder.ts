import { useState, useRef, useCallback } from 'react';
import { ASR_PROVIDERS } from '@/lib/audio/constants';
import { getASRServerDisabledError } from '@/lib/audio/asr-enablement';
import { normalizeASRUploadAudio } from '@/lib/audio/wav-utils';
import { createLogger } from '@/lib/logger';
import { useI18n } from '@/lib/hooks/use-i18n';

const log = createLogger('AudioRecorder');

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
  const { t } = useI18n();

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

  // Send audio to server for transcription
  const transcribeAudio = useCallback(
    async (audioBlob: Blob) => {
      setIsProcessing(true);

      try {
        const formData = new FormData();

        // Get current ASR configuration from settings store
        // Note: This requires importing useSettingsStore in browser context
        if (typeof window !== 'undefined') {
          const { useSettingsStore } = await import('@/lib/store/settings');
          const { asrProviderId, asrLanguage, asrProvidersConfig } = useSettingsStore.getState();
          const uploadAudio = await normalizeASRUploadAudio(asrProviderId, audioBlob);
          formData.append('audio', uploadAudio.blob, uploadAudio.fileName);

          formData.append('providerId', asrProviderId);
          formData.append(
            'modelId',
            asrProvidersConfig?.[asrProviderId]?.modelId ||
              ASR_PROVIDERS[asrProviderId as keyof typeof ASR_PROVIDERS]?.defaultModelId ||
              '',
          );
          formData.append('language', asrLanguage);

          // Append API key and base URL if configured
          const providerConfig = asrProvidersConfig?.[asrProviderId];
          if (providerConfig?.apiKey?.trim()) {
            formData.append('apiKey', providerConfig.apiKey);
          }
          const effectiveBaseUrl =
            providerConfig?.baseUrl?.trim() || providerConfig?.customDefaultBaseUrl || '';
          if (effectiveBaseUrl) {
            formData.append('baseUrl', effectiveBaseUrl);
          }
        } else {
          formData.append('audio', audioBlob, 'recording.webm');
        }

        const response = await fetch('/api/transcription', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Transcription failed');
        }

        const result = await response.json();
        onTranscription?.(result.text);
      } catch (error) {
        log.error('Transcription error:', error);
        onError?.(
          error instanceof Error ? error.message : t('audio.error.recognitionFailed'),
        );
      } finally {
        setIsProcessing(false);
        setRecordingTime(0);
      }
    },
    [onTranscription, onError, t],
  );

  // Start recording
  const startRecording = useCallback(async () => {
    // Synchronous lock — React state is async so isRecording may be stale
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      // Get current ASR configuration
      if (typeof window !== 'undefined') {
        const { useSettingsStore } = await import('@/lib/store/settings');
        const { asrProviderId, asrLanguage, asrProvidersConfig } = useSettingsStore.getState();

        // Browser-native ASR never reaches the server route, so enforce the
        // operator force-off locally before invoking the Web Speech API.
        const serverDisabledError = getASRServerDisabledError(asrProvidersConfig[asrProviderId]);
        if (serverDisabledError) {
          onError?.(serverDisabledError);
          return;
        }

        // Use browser native ASR if configured
        if (asrProviderId === 'browser-native') {
          // Check if Speech Recognition is supported
          if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
            onError?.(t('audio.error.browserUnsupported'));
            return;
          }

          const SpeechRecognitionCtor = (window.SpeechRecognition ||
            window.webkitSpeechRecognition)!;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Web Speech API instance shape isn't in lib.dom
          const recognition: any = new SpeechRecognitionCtor();

          recognition.lang = asrLanguage || 'zh-CN';
          recognition.continuous = continuous;
          recognition.interimResults = false;

          recognition.onstart = () => {
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
            log.error('Speech recognition error:', event.error);
            let errorMessage = t('audio.error.recognitionFailed');

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
                errorMessage = t('audio.error.noSpeech');
                break;
              case 'audio-capture':
                errorMessage = t('audio.error.micUnavailable');
                break;
              case 'not-allowed':
                errorMessage = t('audio.error.micPermissionDenied');
                break;
              case 'network':
                errorMessage = t('audio.error.network');
                break;
              default:
                errorMessage = t('audio.error.recognitionError', { code: event.error });
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
            busyRef.current = false;
            setIsRecording(false);
            setRecordingTime(0);
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
          };

          recognition.start();
          speechRecognitionRef.current = recognition;
          return;
        }
      }

      // Use MediaRecorder for server-side ASR
      // Request microphone permission
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm',
      });

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Stop all audio tracks
        stream.getTracks().forEach((track) => track.stop());

        // Merge audio chunks
        const audioBlob = new Blob(audioChunksRef.current, {
          type: 'audio/webm',
        });

        // Send to server for transcription
        await transcribeAudio(audioBlob);
        busyRef.current = false;
      };

      // Start recording
      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);

      // Start timer
      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch (error) {
      busyRef.current = false;
      log.error('Failed to start recording:', error);
      onError?.(t('audio.error.micAccess'));
    }
  }, [onTranscription, onError, transcribeAudio, continuous, t]);

  // Stop recording
  const stopRecording = useCallback(() => {
    // Stop Speech Recognition if active
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.stop();
      speechRecognitionRef.current = null;
      busyRef.current = false;
      setIsRecording(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    // Stop MediaRecorder if active
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      busyRef.current = false;
      setIsRecording(false);

      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [isRecording]);

  // Cancel recording
  const cancelRecording = useCallback(() => {
    // Cancel Speech Recognition if active
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.onresult = null; // Prevent transcription callback
      speechRecognitionRef.current.onerror = null; // Suppress browser abort error events
      speechRecognitionRef.current.stop();
      speechRecognitionRef.current = null;
      busyRef.current = false;
      setIsRecording(false);
      setRecordingTime(0);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    // Cancel MediaRecorder if active
    if (mediaRecorderRef.current && isRecording) {
      // Stop recording without transcription
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();

      // Stop all audio tracks
      if (mediaRecorderRef.current.stream) {
        mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
      }

      busyRef.current = false;
      setIsRecording(false);
      setRecordingTime(0);

      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }

      audioChunksRef.current = [];
    }
  }, [isRecording]);

  return {
    isRecording,
    isProcessing,
    recordingTime,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
