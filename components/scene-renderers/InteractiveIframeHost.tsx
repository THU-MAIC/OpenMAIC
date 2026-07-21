'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Mic, MicOff, Settings2 } from 'lucide-react';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import {
  useInteractiveIframePool,
  type IframePoolEntry,
  type IframeRect,
} from '@/lib/store/interactive-iframe-pool';
import { useSceneRuntimeErrors } from '@/lib/store/scene-runtime-errors';

/**
 * Stable host for interactive scene iframes (#619).
 *
 * Mounted once at the `Stage` root — outside the mode-swap / scene subtree that
 * unmounts and remounts — so the iframe elements it renders survive Pro mode
 * toggles, scene switches, and any PlaybackChromeRoot remount. The in-tree
 * `InteractiveRenderer` is only a placeholder that registers content and reports
 * the on-screen rect; the actual iframes live here, portaled into a stable host
 * node and positioned over each scene's rect via `position: fixed`.
 *
 * Portal target follows `document.fullscreenElement` so the iframe stays inside
 * the fullscreen subtree during presentation mode (which calls requestFullscreen
 * on the playback stage, not on body); otherwise it lives on `document.body`.
 * A low z-index keeps it under Radix dialogs (e.g. the scene-switch confirm)
 * while still covering the canvas box during interactive playback AND Pro-mode
 * editing — the editor agent fixes interactive HTML, so the teacher must see the
 * live page while editing. Visibility is driven by the placeholder's ownership
 * (gone → hidden, never unmounted), so the document is preserved for a
 * zero-reload return.
 */
export function InteractiveIframeHost() {
  const entries = useInteractiveIframePool((s) => s.entries);
  const activeSceneId = useInteractiveIframePool((s) => s.activeSceneId);
  const reset = useInteractiveIframePool((s) => s.reset);
  const setActiveScene = useWidgetIframeStore((s) => s.setActiveScene);

  // Portal into the fullscreen element when one is active (presentation mode
  // fullscreens the stage, and a body-portaled iframe would not be part of that
  // subtree, so it would vanish). Falls back to body otherwise.
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  useEffect(() => {
    const sync = () => setPortalTarget(document.fullscreenElement ?? document.body);
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  // Keep the messaging store's active scene in lock-step (its legacy fallback
  // path resolves the current widget by active scene when no id is passed).
  useEffect(() => {
    setActiveScene(activeSceneId);
  }, [activeSceneId, setActiveScene]);

  // The host is mounted once per classroom (inside Stage). When it unmounts —
  // e.g. on classroom switch — drop the pool so a new classroom doesn't briefly
  // render the previous one's stale iframes.
  useEffect(() => reset, [reset]);

  if (!portalTarget) return null;

  return createPortal(
    <>
      {Object.entries(entries).map(([sceneId, entry]) => (
        <InteractiveSceneLayer
          key={sceneId}
          sceneId={sceneId}
          entry={entry}
          visible={entry.owner !== null && sceneId === activeSceneId}
        />
      ))}
    </>,
    portalTarget,
  );
}

function InteractiveSceneLayer({ sceneId, entry, visible }: PooledIframeProps) {
  const rect = entry.rect;
  const hasRecording = /getUserMedia|MediaRecorder|SpeechRecognition|recording|录音/i.test(
    entry.srcDoc || entry.src || '',
  );
  const shown = visible && rect !== null && rect.width > 0 && rect.height > 0;

  return (
    <>
      <PooledIframe sceneId={sceneId} entry={entry} visible={visible} />
      {hasRecording && shown && rect && (
        <MicrophoneControls sceneId={sceneId} rect={rect} />
      )}
    </>
  );
}

interface PooledIframeProps {
  readonly sceneId: string;
  readonly entry: IframePoolEntry;
  readonly visible: boolean;
}

/**
 * One persisted iframe. Stays mounted as long as its pool entry exists (only
 * evicted by LRU), so its document is preserved across scene/mode changes.
 * `srcDoc` / `src` come straight from the entry and only change when the
 * content changes — that is the single intended reload path.
 *
 * Security: the sandbox intentionally omits `allow-same-origin`.
 * Combining `allow-scripts` with `allow-same-origin` on a srcDoc iframe
 * effectively negates sandbox protections — the embedded document is treated
 * as same-origin with the parent and can access cookies, localStorage, and
 * the parent DOM. Since the HTML may originate from LLM output or imported
 * classroom JSON, keeping the iframe in a unique (null) origin prevents
 * any embedded script from reaching the host application's state.
 * postMessage communication (the only parent↔iframe channel used here)
 * works correctly with a null origin because the host sends with
 * targetOrigin='*'.
 */
function PooledIframe({ sceneId, entry, visible }: PooledIframeProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const registerIframe = useWidgetIframeStore((s) => s.registerIframe);

  // Register the postMessage callback for this scene (moved here from the
  // placeholder, since the iframe now lives in the host). Stable per scene:
  // the callback reads contentWindow lazily at send time.
  useEffect(() => {
    const send = (type: string, payload: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage({ type, ...payload }, '*');
    };
    registerIframe(sceneId, send);
    return () => registerIframe(sceneId, null);
  }, [sceneId, registerIframe]);

  // Capture runtime errors the iframe's error shim posts out (see iframe.ts), so
  // the editor agent can diagnose a blank/broken page. Matched to THIS iframe by
  // event.source (sandboxed null-origin iframes still postMessage to the parent).
  //
  // The errors that matter most (a JSON.parse that aborts setup) fire while srcDoc
  // parses — possibly BEFORE this passive effect subscribes. The shim buffers every
  // error and re-emits it on request, so after subscribing we ask for a replay to
  // recover anything posted pre-subscription. Re-subscribed per document version
  // (entry.srcDoc) so each fresh page gets its own replay request; addError dedups
  // the live + replayed copies. iframeRef is read lazily, so the handler is stable.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as
        | { __maicInteractive?: boolean; kind?: string; errorKind?: string; message?: unknown }
        | undefined;
      if (!d || d.__maicInteractive !== true || d.kind !== 'runtime-error') return;
      const kind = typeof d.errorKind === 'string' ? d.errorKind : 'error';
      const msg = typeof d.message === 'string' ? d.message : String(d.message ?? '');
      useSceneRuntimeErrors.getState().addError(sceneId, `[${kind}] ${msg}`);
    };
    window.addEventListener('message', onMessage);
    iframeRef.current?.contentWindow?.postMessage({ __maicErrorReplayRequest: true }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [sceneId, entry.srcDoc]);

  // A content change reloads the iframe; drop the previous render's errors so the
  // captured set reflects the CURRENT page (e.g. after the agent applies a fix).
  useEffect(() => {
    useSceneRuntimeErrors.getState().clearScene(sceneId);
  }, [sceneId, entry.srcDoc]);

  const rect = entry.rect;
  // Require a real measured box before showing — a null or zero-size rect means
  // the slot hasn't laid out yet; showing then would flash a 0x0 iframe pinned
  // at the viewport origin.
  const shown = visible && rect !== null && rect.width > 0 && rect.height > 0;
  const style: CSSProperties = {
    position: 'fixed',
    left: rect?.left ?? 0,
    top: rect?.top ?? 0,
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
    border: 0,
    borderRadius: '0.5rem', // matches the canvas box's rounded-lg
    overflow: 'hidden',
    zIndex: 1,
    // visibility (not display) — display:none can drop the document on re-show.
    visibility: shown ? 'visible' : 'hidden',
    pointerEvents: shown ? 'auto' : 'none',
  };

  return (
    <iframe
      ref={iframeRef}
      srcDoc={entry.srcDoc}
      src={entry.srcDoc ? undefined : entry.src}
      style={style}
      title={`Interactive Scene ${sceneId}`}
      allow="microphone"
      sandbox="allow-scripts allow-forms allow-popups"
    />
  );
}

interface MicrophoneControlsProps {
  readonly sceneId: string;
  readonly rect: IframeRect;
}

function MicrophoneControls({ sceneId, rect }: MicrophoneControlsProps) {
  const sendMessage = useWidgetIframeStore((s) => s.getSendMessage(sceneId));
  const [muted, setMuted] = useState(false);
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      // Device labels are hidden until permission is granted. Requesting and
      // immediately releasing a short-lived stream makes the picker useful
      // without competing with the widget's active recording stream.
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      permissionStream.getTracks().forEach((track) => track.stop());
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((device) => device.kind === 'audioinput'));
      setError(null);
    } catch {
      setError('无法访问麦克风，请检查浏览器权限');
    }
  }, []);

  useEffect(() => {
    sendMessage?.('maic-microphone-control', { muted, deviceId });
  }, [deviceId, muted, sendMessage]);

  useEffect(() => {
    if (!open) return;
    const onDeviceChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
  }, [open, refreshDevices]);

  const panelStyle: CSSProperties = {
    position: 'fixed',
    right: `max(12px, calc(100vw - ${rect.left + rect.width}px + 12px))`,
    bottom: `max(12px, calc(100vh - ${rect.top + rect.height}px + 12px))`,
    zIndex: 3,
  };

  return (
    <div style={panelStyle} className="flex items-end gap-1.5" data-testid="microphone-controls">
      {open && (
        <div className="w-56 rounded-xl border border-white/20 bg-gray-950/90 p-2.5 text-white shadow-xl backdrop-blur-md">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-white/80">
            <Settings2 className="h-3.5 w-3.5" />
            <span>选择麦克风 / Select microphone</span>
          </div>
          <select
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
            className="w-full rounded-md border border-white/15 bg-white/10 px-2 py-1.5 text-xs outline-none"
            aria-label="选择麦克风 / Select microphone"
          >
            <option value="" className="text-gray-900">系统默认 / System default</option>
            {devices.map((device, index) => (
              <option key={device.deviceId || `audio-input-${index}`} value={device.deviceId} className="text-gray-900">
                {device.label || `麦克风 ${index + 1} / Microphone ${index + 1}`}
              </option>
            ))}
          </select>
          {error && <p className="mt-1.5 text-[10px] text-rose-300">{error}</p>}
        </div>
      )}
      <button
        type="button"
        onClick={() => setMuted((value) => !value)}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-gray-950/85 text-white shadow-lg backdrop-blur-md transition hover:bg-gray-800"
        aria-label={muted ? '取消静音 / Unmute microphone' : '静音麦克风 / Mute microphone'}
        title={muted ? '取消静音 / Unmute' : '静音麦克风 / Mute'}
      >
        {muted ? <MicOff className="h-4 w-4 text-rose-300" /> : <Mic className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={() =>
          setOpen((value) => {
            const next = !value;
            if (next) void refreshDevices();
            return next;
          })
        }
        className="flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-gray-950/85 text-white shadow-lg backdrop-blur-md transition hover:bg-gray-800"
        aria-label="麦克风设置 / Microphone settings"
        title="麦克风设置 / Microphone settings"
      >
        <Settings2 className="h-4 w-4" />
      </button>
    </div>
  );
}
