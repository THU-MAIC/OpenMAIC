'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LiveTutorSessionResponse,
  PracticeProblem,
  WhiteboardOp,
} from '@/lib/live-tutor/types';
import { sanitizeLiveCaption } from '@/lib/live-tutor/whiteboard-elements';

interface UseLiveCameraTutorOptions {
  topic?: string;
  problem?: PracticeProblem | null;
  sceneContext?: string;
  whiteboardStepsText?: string[];
  language?: string;
  onWhiteboardOps?: (ops: WhiteboardOp[]) => void;
  onProblemAssigned?: (problem: PracticeProblem) => void;
}

export interface LiveTranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

function floatTo16BitPCM(float32: Float32Array): Uint8Array {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

function downsample(buffer: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return buffer;
  const ratio = fromRate / toRate;
  const len = Math.round(buffer.length / ratio);
  const res = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    res[i] = buffer[Math.min(buffer.length - 1, Math.round(i * ratio))];
  }
  return res;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function useLiveCameraTutor({
  topic,
  problem,
  sceneContext,
  whiteboardStepsText = [],
  language,
  onWhiteboardOps,
  onProblemAssigned,
}: UseLiveCameraTutorOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [transportMode, setTransportMode] = useState<'gemini-live' | 'turn-based' | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [camPaused, setCamPaused] = useState(false);
  const [videoSource, setVideoSource] = useState<'camera' | 'screen'>('camera');
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [micLevel, setMicLevel] = useState(0);
  const [liveCaption, setLiveCaption] = useState('');
  const [messages, setMessages] = useState<LiveTranscriptMessage[]>([]);
  const [turnBusy, setTurnBusy] = useState(false);
  const [canShareScreen, setCanShareScreen] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const sessionAttemptRef = useRef(0);
  const sessionAbortRef = useRef<AbortController | null>(null);
  const micMutedRef = useRef(false);
  const camPausedRef = useRef(false);
  const tutorBufRef = useRef('');
  const userBufRef = useRef('');

  const latestPropsRef = useRef({
    topic,
    problem,
    sceneContext,
    whiteboardStepsText,
    language,
    onWhiteboardOps,
    onProblemAssigned,
  });
  useEffect(() => {
    latestPropsRef.current = {
      topic,
      problem,
      sceneContext,
      whiteboardStepsText,
      language,
      onWhiteboardOps,
      onProblemAssigned,
    };
  }, [
    topic,
    problem,
    sceneContext,
    whiteboardStepsText,
    language,
    onWhiteboardOps,
    onProblemAssigned,
  ]);

  useEffect(() => {
    setCanShareScreen(
      typeof navigator !== 'undefined' &&
        Boolean(navigator.mediaDevices) &&
        typeof navigator.mediaDevices.getDisplayMedia === 'function',
    );
  }, []);

  const appendMessage = useCallback((role: 'user' | 'assistant', text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessages((prev) => [
      ...prev.slice(-24),
      { id: `lt-msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role, text: trimmed },
    ]);
  }, []);

  const stopPlayback = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // ignore stopped nodes
      }
    }
    activeSourcesRef.current = [];
    if (playCtxRef.current) {
      nextPlayTimeRef.current = playCtxRef.current.currentTime;
    }
  }, []);

  const playPcm24k = useCallback((base64: string) => {
    try {
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!playCtxRef.current) playCtxRef.current = new AudioContextCtor();
      const ctx = playCtxRef.current;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

      const bin = atob(base64);
      const byteLen = bin.length - (bin.length % 2);
      if (byteLen <= 0) return;
      const bytes = new Uint8Array(byteLen);
      for (let i = 0; i < byteLen; i++) bytes[i] = bin.charCodeAt(i);
      const view = new DataView(bytes.buffer);
      const samples = byteLen / 2;
      const float32 = new Float32Array(samples);
      for (let i = 0; i < samples; i++) float32[i] = view.getInt16(i * 2, true) / 32768;

      const audioBuf = ctx.createBuffer(1, samples, 24000);
      audioBuf.copyToChannel(float32, 0);
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(ctx.destination);

      const now = ctx.currentTime;
      const startAt = nextPlayTimeRef.current > now ? nextPlayTimeRef.current : now + 0.04;
      src.start(startAt);
      nextPlayTimeRef.current = startAt + audioBuf.duration;
      activeSourcesRef.current.push(src);
      src.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter((x) => x !== src);
      };
    } catch {
      // ignore malformed chunk
    }
  }, []);

  const captureFrameDataUrl = useCallback((): string | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return null;
    const maxDim = 768;
    const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.72);
  }, []);

  const startCameraStream = useCallback(
    async (
      preferredFacing: 'environment' | 'user',
      options?: { audio?: boolean; preserveExistingAudio?: boolean },
    ) => {
      const wantAudio = options?.audio ?? true;
      const preserveExistingAudio = options?.preserveExistingAudio ?? false;

      const existingAudioTracks = preserveExistingAudio
        ? (mediaStreamRef.current?.getAudioTracks().filter((t) => t.readyState === 'live') ?? [])
        : [];

      if (mediaStreamRef.current) {
        if (preserveExistingAudio) {
          mediaStreamRef.current.getVideoTracks().forEach((t) => t.stop());
        } else {
          mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        }
      }

      const audioConstraint =
        wantAudio && !preserveExistingAudio
          ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          : false;

      let acquired: MediaStream;
      try {
        acquired = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: preferredFacing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: audioConstraint,
        });
      } catch {
        acquired = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: wantAudio && !preserveExistingAudio,
        });
      }

      const stream =
        existingAudioTracks.length > 0
          ? new MediaStream([...acquired.getVideoTracks(), ...existingAudioTracks])
          : acquired;

      mediaStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      return stream;
    },
    [],
  );

  const stopSession = useCallback(() => {
    sessionAttemptRef.current += 1;
    if (sessionAbortRef.current) {
      sessionAbortRef.current.abort();
      sessionAbortRef.current = null;
    }
    if (frameTimerRef.current) {
      clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }
    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    stopPlayback();
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    micMutedRef.current = false;
    camPausedRef.current = false;
    if (mountedRef.current) {
      setMicLevel(0);
      setMicMuted(false);
      setCamPaused(false);
      setVideoSource('camera');
      setStatus('idle');
      setTransportMode(null);
    }
  }, [stopPlayback]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopSession();
    };
  }, [stopSession]);

  const startSession = useCallback(async () => {
    const attemptId = ++sessionAttemptRef.current;
    const isStale = () => !mountedRef.current || sessionAttemptRef.current !== attemptId;

    if (sessionAbortRef.current) {
      sessionAbortRef.current.abort();
    }
    const controller = new AbortController();
    sessionAbortRef.current = controller;

    setErrorMessage(null);
    setLiveCaption('');
    setStatus('connecting');

    const AudioContextCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!playCtxRef.current) playCtxRef.current = new AudioContextCtor();
    if (playCtxRef.current.state === 'suspended') void playCtxRef.current.resume().catch(() => {});
    nextPlayTimeRef.current = playCtxRef.current.currentTime;
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContextCtor();
    if (audioCtxRef.current.state === 'suspended') {
      void audioCtxRef.current.resume().catch(() => {});
    }

    // Negotiate transport first so turn-based snapshot fallback only requests camera (not mic)
    let sessionInfo: LiveTutorSessionResponse;
    try {
      const resp = await fetch('/api/live-tutor/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      const json = (await resp.json()) as {
        success?: boolean;
        data?: LiveTutorSessionResponse;
        error?: { message?: string };
      } & Partial<LiveTutorSessionResponse>;
      if (!resp.ok) {
        throw new Error(json.error?.message || `HTTP ${resp.status}`);
      }
      sessionInfo = (json.data ?? json) as LiveTutorSessionResponse;
    } catch (err) {
      if (isStale()) return;
      stopSession();
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Failed to start session');
      return;
    }

    if (isStale()) return;

    const needsMic = sessionInfo.mode === 'gemini-live';
    let stream: MediaStream;
    try {
      stream = await startCameraStream(facingMode, { audio: needsMic });
    } catch {
      if (isStale()) return;
      setStatus('error');
      setErrorMessage(
        needsMic
          ? 'Camera and microphone permissions are required.'
          : 'Camera permission is required.',
      );
      return;
    }

    if (isStale()) {
      stream.getTracks().forEach((t) => t.stop());
      if (mediaStreamRef.current === stream) {
        mediaStreamRef.current = null;
      }
      if (videoRef.current && videoRef.current.srcObject === stream) {
        videoRef.current.srcObject = null;
      }
      return;
    }

    if (sessionInfo.mode === 'turn-based') {
      if (audioCtxRef.current) {
        void audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
      setTransportMode('turn-based');
      setStatus('live');
      return;
    }

    setTransportMode('gemini-live');
    const ws = new WebSocket(sessionInfo.wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (isStale() || wsRef.current !== ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        return;
      }
      const cur = latestPropsRef.current;
      const sysLines = [
        'You are a warm, patient Socratic teacher watching a student work in their physical notebook (or shared lesson slide) and guiding them step by step using a shared classroom whiteboard.',
        'Never claim you can see a notebook or written work unless it is actually visible in the camera frame; if you do not see a notebook yet, kindly ask the student to point the camera at their notebook.',
        'Praise what the student did right first. Never blurt out the final answer immediately — point to the specific line or step to check and ask one gentle guiding question.',
        'Keep every spoken reply concise (1 to 3 sentences).',
        'Whenever writing a step, key hint, or LaTeX formula on the whiteboard helps the student follow along, call write_whiteboard_step or write_whiteboard_formula (without surrounding $ delimiters). Whenever a visual sketch (labeled right triangle, angle arc, light rays, forces, coordinate axes, shapes, or arrows) helps explain the concept, call draw_whiteboard_diagram with a clean SVG (viewBox="0 0 600 340", white/light background, clear dark strokes and readable labels).',
        cur.topic ? `Current topic: ${cur.topic}.` : '',
        cur.problem?.statement ? `Assigned problem to solve: ${cur.problem.statement}` : '',
        cur.sceneContext ? `Lesson context:\n${cur.sceneContext.slice(0, 1800)}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      ws.send(
        JSON.stringify({
          setup: {
            model: sessionInfo.model,
            generationConfig: { responseModalities: ['AUDIO'] },
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
                prefixPaddingMs: 300,
              },
              activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
            },
            contextWindowCompression: {
              triggerTokens: 16000,
              slidingWindow: { targetTokens: 8000 },
            },
            tools: [
              {
                functionDeclarations: [
                  {
                    name: 'write_whiteboard_step',
                    description:
                      'Write one clear guiding step or section heading onto the shared student whiteboard.',
                    parameters: {
                      type: 'OBJECT',
                      properties: {
                        content: {
                          type: 'STRING',
                          description: 'Plain text step or heading to write on the whiteboard.',
                        },
                        isHeading: {
                          type: 'BOOLEAN',
                          description: 'True if this is a short problem/section heading.',
                        },
                      },
                      required: ['content'],
                    },
                  },
                  {
                    name: 'write_whiteboard_formula',
                    description:
                      'Write one clean LaTeX math formula onto the shared student whiteboard (no surrounding $ delimiters).',
                    parameters: {
                      type: 'OBJECT',
                      properties: {
                        latex: {
                          type: 'STRING',
                          description: 'LaTeX expression without $ or $$ delimiters.',
                        },
                      },
                      required: ['latex'],
                    },
                  },
                  {
                    name: 'draw_whiteboard_diagram',
                    description:
                      'Draw a labeled vector diagram (triangles, shapes, lines, arrows, light rays, coordinate graphs, free-body diagrams) onto the shared whiteboard as a clean self-contained SVG.',
                    parameters: {
                      type: 'OBJECT',
                      properties: {
                        svg: {
                          type: 'STRING',
                          description:
                            'Self-contained <svg viewBox="0 0 600 340" xmlns="http://www.w3.org/2000/svg">...</svg> using crisp shapes, lines, arrows, and readable text labels (no scripts or external links).',
                        },
                        caption: {
                          type: 'STRING',
                          description: 'Optional short title shown above the diagram.',
                        },
                      },
                      required: ['svg'],
                    },
                  },
                  {
                    name: 'clear_whiteboard',
                    description: 'Clear the shared whiteboard before starting a fresh problem.',
                    parameters: {
                      type: 'OBJECT',
                      properties: {},
                    },
                  },
                ],
              },
            ],
            systemInstruction: { parts: [{ text: sysLines }] },
          },
        }),
      );
    };

    ws.onmessage = async (event) => {
      if (isStale() || wsRef.current !== ws) return;
      try {
        const raw = typeof event.data === 'string' ? event.data : await event.data.text();
        const msg = JSON.parse(raw) as Record<string, unknown>;

        if ('setupComplete' in msg) {
          setStatus('live');

          // Start 1 fps notebook/slide JPEG frame loop
          frameTimerRef.current = setInterval(() => {
            if (
              !wsRef.current ||
              wsRef.current.readyState !== WebSocket.OPEN ||
              camPausedRef.current
            ) {
              return;
            }
            const dataUrl = captureFrameDataUrl();
            if (!dataUrl) return;
            const b64 = dataUrl.split(',')[1];
            if (!b64) return;
            wsRef.current.send(
              JSON.stringify({
                realtimeInput: { video: { mimeType: 'image/jpeg', data: b64 } },
              }),
            );
          }, 1000);

          // Start 16 kHz PCM16 microphone loop
          const aCtx = audioCtxRef.current;
          if (aCtx) {
            const source = aCtx.createMediaStreamSource(stream);
            const processor = aCtx.createScriptProcessor(4096, 1, 1);
            const silent = aCtx.createGain();
            silent.gain.value = 0;

            processor.onaudioprocess = (e) => {
              if (
                !wsRef.current ||
                wsRef.current.readyState !== WebSocket.OPEN ||
                micMutedRef.current
              ) {
                setMicLevel(0);
                return;
              }
              const input = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
              const rms = Math.sqrt(sum / input.length);
              setMicLevel(Math.min(100, Math.round(rms * 450)));

              const down = downsample(input, aCtx.sampleRate, 16000);
              const pcmBytes = floatTo16BitPCM(down);
              wsRef.current.send(
                JSON.stringify({
                  realtimeInput: {
                    audio: { mimeType: 'audio/pcm;rate=16000', data: bytesToBase64(pcmBytes) },
                  },
                }),
              );
            };
            source.connect(processor);
            processor.connect(silent);
            silent.connect(aCtx.destination);
          }

          const curProb = latestPropsRef.current.problem?.statement;
          const greetPrompt = curProb
            ? `Greet the student warmly in one short sentence, invite them to start working on "${curProb}", and ask them to show their notebook to the camera when they are ready.`
            : 'Greet the student warmly in one short sentence and ask them to show their notebook to the camera or tell you what question they would like help with.';

          ws.send(
            JSON.stringify({
              clientContent: {
                turns: [{ role: 'user', parts: [{ text: greetPrompt }] }],
                turnComplete: true,
              },
            }),
          );
          return;
        }

        // Handle Gemini Live whiteboard tool calls
        const toolCall = msg.toolCall as
          | {
              functionCalls?: Array<{
                id?: string;
                name?: string;
                args?: Record<string, unknown>;
              }>;
            }
          | undefined;

        if (toolCall?.functionCalls?.length) {
          const ops: WhiteboardOp[] = [];
          const responses: Array<Record<string, unknown>> = [];
          for (const fc of toolCall.functionCalls) {
            const args = fc.args ?? {};
            if (fc.name === 'write_whiteboard_step' && typeof args.content === 'string') {
              ops.push({
                op: args.isHeading ? 'add_heading' : 'add_step',
                content: args.content,
              });
            } else if (fc.name === 'write_whiteboard_formula' && typeof args.latex === 'string') {
              ops.push({ op: 'add_formula', content: args.latex });
            } else if (fc.name === 'draw_whiteboard_diagram' && typeof args.svg === 'string') {
              ops.push({
                op: 'add_diagram',
                content: args.svg,
                caption: typeof args.caption === 'string' ? args.caption : undefined,
              });
            } else if (fc.name === 'clear_whiteboard') {
              ops.push({ op: 'clear' });
            }
            responses.push({
              id: fc.id,
              name: fc.name,
              response: { result: 'ok' },
            });
          }
          if (ops.length > 0) {
            latestPropsRef.current.onWhiteboardOps?.(ops);
          }
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({
                toolResponse: { functionResponses: responses },
              }),
            );
          }
        }

        const serverContent = msg.serverContent as
          | {
              interrupted?: boolean;
              turnComplete?: boolean;
              modelTurn?: {
                parts?: Array<{
                  text?: string;
                  thought?: boolean;
                  inlineData?: { mimeType?: string; data?: string };
                }>;
              };
              outputTranscription?: { text?: string };
              inputTranscription?: { text?: string };
            }
          | undefined;

        if (!serverContent) return;

        if (serverContent.interrupted) {
          stopPlayback();
          if (tutorBufRef.current) {
            appendMessage('assistant', sanitizeLiveCaption(tutorBufRef.current));
            tutorBufRef.current = '';
          }
        }

        for (const p of serverContent.modelTurn?.parts ?? []) {
          if (p.inlineData?.mimeType?.startsWith('audio/pcm') && p.inlineData.data) {
            playPcm24k(p.inlineData.data);
          }
          if (p.text && !p.thought) {
            tutorBufRef.current += p.text;
            const cleaned = sanitizeLiveCaption(tutorBufRef.current);
            if (cleaned) setLiveCaption(cleaned);
          }
        }

        if (serverContent.outputTranscription?.text) {
          tutorBufRef.current += serverContent.outputTranscription.text;
          const cleaned = sanitizeLiveCaption(tutorBufRef.current);
          if (cleaned) setLiveCaption(cleaned);
        }
        if (serverContent.inputTranscription?.text) {
          userBufRef.current += serverContent.inputTranscription.text;
          setLiveCaption(userBufRef.current.trim());
        }

        if (serverContent.turnComplete) {
          if (userBufRef.current) {
            appendMessage('user', userBufRef.current);
            userBufRef.current = '';
          }
          if (tutorBufRef.current) {
            appendMessage('assistant', sanitizeLiveCaption(tutorBufRef.current));
            tutorBufRef.current = '';
          }
        }
      } catch {
        // ignore non-JSON frames
      }
    };

    ws.onerror = () => {
      if (isStale() || wsRef.current !== ws) return;
      setStatus('error');
      setErrorMessage('Live tutor WebSocket error');
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      stopSession();
    };
  }, [
    appendMessage,
    captureFrameDataUrl,
    facingMode,
    playPcm24k,
    startCameraStream,
    stopPlayback,
    stopSession,
  ]);

  const sendStudentTurn = useCallback(
    async (promptText?: string) => {
      const text = promptText?.trim() || 'Please check my notebook work and guide my next step.';
      const dataUrl = !camPausedRef.current ? captureFrameDataUrl() : null;

      if (transportMode === 'gemini-live' && wsRef.current?.readyState === WebSocket.OPEN) {
        if (playCtxRef.current?.state === 'suspended') {
          void playCtxRef.current.resume().catch(() => {});
        }
        if (dataUrl) {
          const b64 = dataUrl.split(',')[1];
          if (b64) {
            wsRef.current.send(
              JSON.stringify({
                realtimeInput: { video: { mimeType: 'image/jpeg', data: b64 } },
              }),
            );
          }
        }
        appendMessage('user', text);
        tutorBufRef.current = '';
        wsRef.current.send(
          JSON.stringify({
            clientContent: {
              turns: [{ role: 'user', parts: [{ text }] }],
              turnComplete: true,
            },
          }),
        );
        return;
      }

      // Provider-neutral turn-based multimodal fallback
      setTurnBusy(true);
      setErrorMessage(null);
      appendMessage('user', text);
      try {
        const cur = latestPropsRef.current;
        const resp = await fetch('/api/live-tutor/turn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'tutor-turn',
            topic: cur.topic,
            sceneContext: cur.sceneContext,
            problem: cur.problem?.statement,
            message: text,
            imageDataUrl: dataUrl ?? undefined,
            history: messages.slice(-8).map((m) => ({ role: m.role, text: m.text })),
            whiteboardSteps: cur.whiteboardStepsText,
            language: cur.language,
          }),
        });
        const json = (await resp.json()) as {
          data?: { reply?: string; whiteboardOps?: WhiteboardOp[] };
          reply?: string;
          whiteboardOps?: WhiteboardOp[];
          error?: { message?: string };
        };
        if (!resp.ok) {
          throw new Error(json.error?.message || `HTTP ${resp.status}`);
        }
        const payload = json.data ?? json;
        const reply = payload.reply ?? '';
        if (reply) {
          appendMessage('assistant', reply);
          setLiveCaption(reply);
          if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const utter = new SpeechSynthesisUtterance(reply);
            window.speechSynthesis.speak(utter);
          }
        }
        if (payload.whiteboardOps?.length) {
          cur.onWhiteboardOps?.(payload.whiteboardOps);
        }
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to evaluate notebook snapshot',
        );
      } finally {
        setTurnBusy(false);
      }
    },
    [appendMessage, captureFrameDataUrl, messages, transportMode],
  );

  const generatePracticeProblem = useCallback(async () => {
    setTurnBusy(true);
    setErrorMessage(null);
    try {
      const cur = latestPropsRef.current;
      const resp = await fetch('/api/live-tutor/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate-problem',
          topic: cur.topic,
          sceneContext: cur.sceneContext,
          language: cur.language,
        }),
      });
      const json = (await resp.json()) as {
        data?: { problem?: PracticeProblem };
        problem?: PracticeProblem;
        error?: { message?: string };
      };
      if (!resp.ok) throw new Error(json.error?.message || `HTTP ${resp.status}`);
      const nextProblem = (json.data ?? json).problem;
      if (nextProblem) {
        cur.onProblemAssigned?.(nextProblem);
        const ops: WhiteboardOp[] = [
          { op: 'clear' },
          { op: 'add_heading', content: nextProblem.targetConcept || 'Practice Problem' },
          { op: 'add_step', content: nextProblem.statement },
        ];
        if (nextProblem.formulaLatex) {
          ops.push({ op: 'add_formula', content: nextProblem.formulaLatex });
        }
        cur.onWhiteboardOps?.(ops);

        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              clientContent: {
                turns: [
                  {
                    role: 'user',
                    parts: [
                      {
                        text: `New practice problem assigned: "${nextProblem.statement}". Briefly read the problem to the student and invite them to start step 1 in their notebook.`,
                      },
                    ],
                  },
                ],
                turnComplete: true,
              },
            }),
          );
        }
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to generate problem');
    } finally {
      setTurnBusy(false);
    }
  }, []);

  const toggleMic = useCallback(() => {
    setMicMuted((prev) => {
      const next = !prev;
      micMutedRef.current = next;
      return next;
    });
  }, []);

  const toggleCam = useCallback(() => {
    setCamPaused((prev) => {
      const next = !prev;
      camPausedRef.current = next;
      return next;
    });
  }, []);

  const flipCamera = useCallback(async () => {
    const next = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(next);
    if (status === 'live' && videoSource === 'camera') {
      await startCameraStream(next, { audio: false, preserveExistingAudio: true });
    }
  }, [facingMode, startCameraStream, status, videoSource]);

  const toggleScreenShare = useCallback(async () => {
    if (!canShareScreen) return;
    if (videoSource === 'camera') {
      try {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        screenStreamRef.current = screen;
        setVideoSource('screen');
        if (videoRef.current) {
          videoRef.current.srcObject = screen;
          await videoRef.current.play().catch(() => {});
        }
        screen.getVideoTracks()[0]?.addEventListener('ended', () => {
          screenStreamRef.current = null;
          setVideoSource('camera');
          if (videoRef.current && mediaStreamRef.current) {
            videoRef.current.srcObject = mediaStreamRef.current;
            void videoRef.current.play().catch(() => {});
          }
        });
      } catch {
        // user cancelled screen picker
      }
    } else {
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }
      setVideoSource('camera');
      if (videoRef.current && mediaStreamRef.current) {
        videoRef.current.srcObject = mediaStreamRef.current;
        await videoRef.current.play().catch(() => {});
      }
    }
  }, [canShareScreen, videoSource]);

  return {
    videoRef,
    canvasRef,
    status,
    transportMode,
    errorMessage,
    micMuted,
    camPaused,
    videoSource,
    micLevel,
    liveCaption,
    messages,
    turnBusy,
    canShareScreen,
    startSession,
    stopSession,
    sendStudentTurn,
    generatePracticeProblem,
    toggleMic,
    toggleCam,
    flipCamera,
    toggleScreenShare,
  };
}
