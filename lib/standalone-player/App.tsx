import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CircleAlert,
  ChevronLeft,
  ChevronRight,
  Captions,
  FolderKanban,
  List,
  ListChecks,
  Maximize,
  Minimize,
  MousePointerClick,
  Pause,
  Play,
  Presentation,
} from 'lucide-react';
import type { ManifestScene } from '@/lib/export/classroom-zip-types';
import type { PlayerData } from './read-data';
import {
  applyNavigation,
  isMediaToggleKey,
  isPlaybackToggleKey,
  navigationActionForKey,
  sceneHash,
  sceneIndexFromHash,
  type NavigationAction,
} from './navigation';
import { SlideScene } from './scenes/SlideScene';
import { InteractiveScene } from './scenes/InteractiveScene';
import { QuizScene } from './scenes/QuizScene';
import { PblScene } from './scenes/PblScene';
import { UnavailableScene } from './scenes/UnavailableScene';
import { SceneErrorBoundary } from './SceneErrorBoundary';
import { usePlayback, type Playback } from './playback/use-playback';
import { CaptionBar, DiscussionCard, StartOverlay } from './PlaybackOverlays';

function SceneIcon({ type, className }: { type: ManifestScene['type']; className?: string }) {
  switch (type) {
    case 'slide':
      return <Presentation className={className} aria-hidden="true" />;
    case 'interactive':
      return <MousePointerClick className={className} aria-hidden="true" />;
    case 'quiz':
      return <ListChecks className={className} aria-hidden="true" />;
    case 'pbl':
      return <FolderKanban className={className} aria-hidden="true" />;
    default:
      return null;
  }
}

function SceneView({
  scene,
  data,
  playback,
}: {
  scene: ManifestScene;
  data: PlayerData;
  playback: Playback;
}) {
  const { strings, classroomUrl } = data.config;
  const content = scene.content;
  switch (content.type) {
    case 'slide':
      return (
        <SlideScene
          slide={content.canvas}
          strings={strings}
          effects={playback.state.view.effects}
          media={playback.media}
          videos={playback.videos}
        />
      );
    case 'interactive':
      return content.html ? (
        <InteractiveScene
          html={content.html}
          title={scene.title}
          strings={strings}
          widgets={playback.widgets}
        />
      ) : (
        <UnavailableScene message={strings.unsupportedScene} />
      );
    case 'quiz':
      return <QuizScene questions={content.questions ?? []} strings={strings} />;
    case 'pbl':
      return (
        <PblScene
          content={content}
          sceneTitle={scene.title}
          classroomUrl={classroomUrl}
          strings={strings}
        />
      );
    default:
      return <UnavailableScene message={strings.unsupportedScene} />;
  }
}

function keyFields(event: KeyboardEvent) {
  return {
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  };
}

function useFullscreen() {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);
  return { fullscreen, toggle };
}

export function App({ data }: { data: PlayerData }) {
  const { scenes, manifest } = data;
  const { strings } = data.config;
  const count = scenes.length;
  const [index, setIndex] = useState(() => sceneIndexFromHash(window.location.hash, count));
  const [listOpen, setListOpen] = useState(false);
  const { fullscreen, toggle: toggleFullscreen } = useFullscreen();

  // The start overlay invites playback on whichever scene the file opens on
  // (a `#scene-N` link included); any navigation before playing (buttons,
  // keys, the scene list, a hash change) means the learner chose to browse.
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const goTo = useCallback((next: number) => {
    setIndex(next);
    setOverlayDismissed(true);
    // replaceState: scene changes should not flood the history stack, and
    // a reload (or a shared `#scene-N` link) reopens the same scene.
    try {
      history.replaceState(null, '', sceneHash(next));
    } catch {
      // Some file:// contexts refuse history updates; navigation still works.
    }
  }, []);
  const navigate = useCallback(
    (action: NavigationAction) => goTo(applyNavigation(index, action, count)),
    [goTo, index, count],
  );
  const playback = usePlayback(scenes, index, goTo);
  const { mode, started, view } = playback.state;
  const [captionsOn, setCaptionsOn] = useState(true);
  const mainRef = useRef<HTMLElement>(null);
  const playing = mode === 'playing';
  const playLabel = playing
    ? strings.pause
    : mode === 'holding'
      ? strings.playbackContinue
      : strings.play;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Quiz and PBL scenes scroll: with focus inside the scene, Space keeps
      // its native page-down; elsewhere (header, footer, page) it toggles.
      const target = event.target as Node | null;
      const scrollsScene =
        (scenes[index]?.type === 'quiz' || scenes[index]?.type === 'pbl') &&
        !!target &&
        !!mainRef.current?.contains(target);
      if (
        !scrollsScene &&
        isPlaybackToggleKey({
          key: event.key,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          target: event.target as HTMLElement | null,
        })
      ) {
        event.preventDefault();
        playback.toggle();
        return;
      }
      const action = navigationActionForKey({
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        target: event.target as HTMLElement | null,
      });
      if (!action) return;
      event.preventDefault();
      navigate(action);
    };
    // Space on a focused video or audio toggles that element, the same in
    // every browser (WebKit's native controls ignore Space, Chromium's toggle
    // on it); its play/pause events keep playback in step exactly as its
    // native controls do (see `VideoRegistry`). Handled while capturing, and
    // stopped there, so the native controls never see the press.
    const onMediaKey = (event: KeyboardEvent) => {
      if (!isMediaToggleKey({ ...keyFields(event), target: event.target as HTMLElement | null })) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.type !== 'keydown' || event.repeat) return;
      const media = event.target as HTMLMediaElement;
      if (media.paused) void media.play().catch(() => {});
      else media.pause();
    };
    const capture = { capture: true } as const;
    window.addEventListener('keydown', onMediaKey, capture);
    window.addEventListener('keypress', onMediaKey, capture);
    window.addEventListener('keyup', onMediaKey, capture);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onMediaKey, capture);
      window.removeEventListener('keypress', onMediaKey, capture);
      window.removeEventListener('keyup', onMediaKey, capture);
      window.removeEventListener('keydown', onKey);
    };
  }, [navigate, playback, scenes, index]);

  useEffect(() => {
    const onHash = () => {
      setIndex(sceneIndexFromHash(window.location.hash, count));
      setOverlayDismissed(true);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [count]);

  const scene = scenes[index];
  const courseName = manifest.stage?.name ?? '';

  return (
    <div className="flex h-dvh flex-col bg-slate-100 text-slate-900">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={courseName}>
            {courseName}
          </div>
          {scene && (
            <div className="truncate text-xs text-slate-500" data-testid="scene-title">
              {scene.title}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setListOpen((open) => !open)}
          className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          aria-label={strings.scenes}
          aria-expanded={listOpen}
          title={strings.scenes}
        >
          <List className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={toggleFullscreen}
          className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          aria-label={fullscreen ? strings.exitFullscreen : strings.fullscreen}
          title={fullscreen ? strings.exitFullscreen : strings.fullscreen}
        >
          {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
        </button>
      </header>

      {playback.linkedMediaMissing && (
        <div
          className="flex shrink-0 items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
          role="alert"
          data-testid="media-missing"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{strings.linkedFilesUnavailable}</p>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* The caption overlays the scene on wide screens and takes a strip below
            it on narrow or short ones (see `.caption-bar`). */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <main
            ref={mainRef}
            className="relative min-h-0 min-w-0 flex-1"
            data-testid="scene"
            data-scene-index={index}
            data-scene-type={scene?.type}
          >
            {scene ? (
              <SceneErrorBoundary key={index} message={strings.unsupportedScene}>
                <SceneView scene={scene} data={data} playback={playback} />
              </SceneErrorBoundary>
            ) : (
              <UnavailableScene message={strings.emptyClassroom} />
            )}
            {view.discussion !== null && (
              <DiscussionCard
                topic={view.discussion}
                classroomUrl={data.config.classroomUrl}
                strings={strings}
                onDismiss={playback.dismissDiscussion}
              />
            )}
            {scene && !started && !overlayDismissed && (
              <StartOverlay
                label={strings.playbackStart}
                onPlay={playback.play}
                onDismiss={() => setOverlayDismissed(true)}
              />
            )}
          </main>
          {captionsOn && mode !== 'idle' && <CaptionBar text={view.caption ?? ''} />}
        </div>

        {listOpen && (
          <nav
            className="absolute inset-y-0 right-0 z-10 flex w-72 max-w-full flex-col border-l border-slate-200 bg-white shadow-xl"
            aria-label={strings.scenes}
          >
            <div className="flex h-11 shrink-0 items-center border-b border-slate-100 px-4 text-sm font-semibold">
              {strings.scenes}
            </div>
            <ol className="min-h-0 flex-1 overflow-y-auto p-2">
              {scenes.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <button
                    type="button"
                    onClick={() => {
                      goTo(itemIndex);
                      setListOpen(false);
                    }}
                    aria-current={itemIndex === index ? 'step' : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm ${
                      itemIndex === index
                        ? 'bg-violet-50 font-medium text-violet-700'
                        : 'text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <span className="w-6 shrink-0 text-right text-xs tabular-nums text-slate-400">
                      {itemIndex + 1}
                    </span>
                    <SceneIcon type={item.type} className="h-4 w-4 shrink-0 text-slate-400" />
                    <span className="truncate">{item.title}</span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}
      </div>

      <footer className="flex h-14 shrink-0 items-center gap-3 border-t border-slate-200 bg-white px-4">
        <button
          type="button"
          onClick={() => navigate('previous')}
          disabled={index <= 0}
          className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="previous"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          {strings.previous}
        </button>
        <button
          type="button"
          onClick={playback.toggle}
          disabled={!scene}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={playLabel}
          title={playLabel}
          data-testid="play-toggle"
          data-mode={mode}
        >
          {playing ? (
            <Pause className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Play className="h-4 w-4 translate-x-px" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setCaptionsOn((on) => !on)}
          className={`rounded-md p-2 hover:bg-slate-100 ${
            captionsOn ? 'text-violet-600' : 'text-slate-400'
          }`}
          aria-label={strings.captions}
          aria-pressed={captionsOn}
          title={strings.captions}
          data-testid="captions-toggle"
        >
          <Captions className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-violet-500 transition-[width] duration-300"
              style={{ width: count > 0 ? `${((index + 1) / count) * 100}%` : '0%' }}
            />
          </div>
          <span className="shrink-0 text-xs tabular-nums text-slate-500" data-testid="counter">
            {count > 0 ? index + 1 : 0} / {count}
          </span>
        </div>
        <button
          type="button"
          onClick={() => navigate('next')}
          disabled={index >= count - 1}
          className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="next"
        >
          {strings.next}
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </footer>
    </div>
  );
}
