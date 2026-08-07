'use client';

import { createElement, useMemo, useState, type ReactNode } from 'react';
import { Sigma, Video, Volume2 } from 'lucide-react';
import type {
  PPTAudioElement,
  PPTElement,
  PPTImageElement,
  PPTLatexElement,
  Slide,
} from '@openmaic/dsl';
import type { Selection } from '../react/types';
import { AudioToolbarOverlay } from './audio/AudioToolbarOverlay';
import { ElementToolbarOverlay } from './element/ElementToolbarOverlay';
import { ImageToolbarOverlay } from './element/ImageToolbarOverlay';
import { LatexEditorDialog } from './latex/LatexEditorDialog';
import { LatexToolbarOverlay } from './latex/LatexToolbarOverlay';
import { VideoToolbarOverlay } from './video/VideoToolbarOverlay';
import { AudioInsertPicker } from './audio/AudioInsertPicker';
import { VideoInsertPicker } from './video/VideoInsertPicker';
import type {
  AudioEditorOptions,
  AudioInsertOptions,
  ElementToolbarOptions,
  ImageEditorOptions,
  InsertToolbarItem,
  LatexEditorOptions,
  VideoEditorOptions,
  VideoInsertOptions,
} from './types';
import type { LatexEditorResult } from './latex/latex-editor';

interface ElementEditorAdapterOptions {
  readonly slide: Slide;
  readonly selection?: Selection;
  readonly hiddenElementIds?: readonly string[];
  readonly elementIdPrefix: string;
  readonly latexEditor?: LatexEditorOptions | false;
  readonly videoEditor?: VideoEditorOptions | false;
  readonly videoInsert?: VideoInsertOptions | false;
  readonly audioEditor?: AudioEditorOptions | false;
  readonly audioInsert?: AudioInsertOptions | false;
  readonly elementToolbar?: ElementToolbarOptions | false;
  readonly imageEditor?: ImageEditorOptions | false;
}

interface ElementEditorAdapter {
  readonly id: string;
  readonly insertItem?: InsertToolbarItem;
  readonly overlay?: ReactNode;
}

type LatexDialogState =
  | { readonly mode: 'insert' }
  | { readonly mode: 'edit'; readonly element: PPTLatexElement }
  | null;

function selectedElement(
  slide: Slide,
  selection: Selection | undefined,
  hiddenElementIds: readonly string[] | undefined,
): PPTElement | null {
  const elementIds = selection?.elementIds ?? [];
  if (elementIds.length !== 1) return null;
  const id = selection?.primaryId ?? elementIds[0];
  if (hiddenElementIds?.includes(id)) return null;
  return slide.elements.find((element) => element.id === id && !element.lock) ?? null;
}

/**
 * Internal registry for built-in element editing affordances. Adding a new
 * element editor only requires one adapter entry here; the canvas shell stays
 * agnostic of element types.
 */
export function useBuiltinElementEditorAdapters({
  slide,
  selection,
  hiddenElementIds,
  elementIdPrefix,
  latexEditor,
  videoEditor,
  videoInsert,
  audioEditor,
  audioInsert,
  elementToolbar,
  imageEditor,
}: ElementEditorAdapterOptions): {
  readonly insertItems: readonly InsertToolbarItem[];
  readonly overlays: readonly ReactNode[];
} {
  const [latexDialog, setLatexDialog] = useState<LatexDialogState>(null);
  const selected = useMemo(
    () => selectedElement(slide, selection, hiddenElementIds),
    [hiddenElementIds, selection, slide],
  );

  return useMemo(() => {
    const activeLatexEditor = latexEditor === false ? null : latexEditor;
    const activeVideoEditor = videoEditor === false ? null : videoEditor;
    const activeVideoInsert = videoInsert === false ? null : videoInsert;
    const activeAudioEditor = audioEditor === false ? null : audioEditor;
    const activeAudioInsert = audioInsert === false ? null : audioInsert;
    const activeElementToolbar = elementToolbar === false ? null : elementToolbar;
    const activeImageEditor = imageEditor === false ? null : imageEditor;

    const adapters: ElementEditorAdapter[] = [];

    if (activeLatexEditor) {
      const labels = activeLatexEditor.labels;
      const selectedLatex = selected?.type === 'latex' ? selected : null;
      adapters.push({
        id: 'latex',
        insertItem: {
          id: 'insert-latex',
          label: labels?.insertFormula ?? 'Insert formula',
          tooltip: labels?.insertFormula ?? 'Insert formula',
          icon: createElement(Sigma, { 'aria-hidden': true }),
          onInvoke: () => setLatexDialog({ mode: 'insert' }),
        },
        overlay: selectedLatex ? (
          <LatexToolbarOverlay
            element={selectedLatex}
            elementIdPrefix={elementIdPrefix}
            toolbarLabel={labels?.toolbar ?? 'Formula toolbar'}
            editLabel={labels?.editFormula ?? 'Edit formula'}
            bringToFrontLabel={labels?.bringToFront ?? 'Bring to front'}
            sendToBackLabel={labels?.sendToBack ?? 'Send to back'}
            deleteLabel={labels?.delete ?? 'Delete'}
            onEdit={() => setLatexDialog({ mode: 'edit', element: selectedLatex })}
            onBringToFront={
              activeLatexEditor.onBringToFront
                ? () => activeLatexEditor.onBringToFront?.(selectedLatex.id)
                : undefined
            }
            onSendToBack={
              activeLatexEditor.onSendToBack
                ? () => activeLatexEditor.onSendToBack?.(selectedLatex.id)
                : undefined
            }
            onDelete={
              activeLatexEditor.onDelete
                ? () => activeLatexEditor.onDelete?.(selectedLatex.id)
                : undefined
            }
          />
        ) : undefined,
      });
    }

    if (activeVideoInsert || activeVideoEditor) {
      const labels = activeVideoEditor?.labels;
      const insertLabels = activeVideoInsert?.labels;
      const selectedVideo = selected?.type === 'video' ? selected : null;
      adapters.push({
        id: 'video',
        insertItem: activeVideoInsert
          ? {
              id: 'insert-video',
              label: insertLabels?.insertVideo ?? 'Insert video',
              tooltip: insertLabels?.insertVideo ?? 'Insert video',
              icon: createElement(Video, { 'aria-hidden': true }),
              renderPopover: ({ close }) => (
                <VideoInsertPicker
                  labels={{
                    insertVideo: insertLabels?.insertVideo ?? 'Insert video',
                    videoDrop: insertLabels?.videoDrop ?? 'Drop a video or click to choose a file',
                    videoOr: insertLabels?.videoOr ?? 'or paste a video URL',
                    videoUrlPlaceholder: insertLabels?.videoUrlPlaceholder ?? 'https://...',
                    videoInsert: insertLabels?.videoInsert ?? 'Insert',
                  }}
                  onInsert={(result) => {
                    activeVideoInsert.onInsert(result);
                    close();
                  }}
                />
              ),
            }
          : undefined,
        overlay:
          selectedVideo && activeVideoEditor ? (
            <VideoToolbarOverlay
              element={selectedVideo}
              elementIdPrefix={elementIdPrefix}
              labels={{
                toolbar: labels?.toolbar ?? 'Video toolbar',
                poster: labels?.poster ?? 'Set poster',
                bringToFront: labels?.bringToFront ?? 'Bring to front',
                sendToBack: labels?.sendToBack ?? 'Send to back',
                delete: labels?.delete ?? 'Delete',
              }}
              renderPosterPicker={activeVideoEditor.renderPosterPicker}
              onPosterChange={(poster) =>
                activeVideoEditor.onPosterChange(selectedVideo.id, poster)
              }
              onBringToFront={
                activeVideoEditor.onBringToFront
                  ? () => activeVideoEditor.onBringToFront?.(selectedVideo.id)
                  : undefined
              }
              onSendToBack={
                activeVideoEditor.onSendToBack
                  ? () => activeVideoEditor.onSendToBack?.(selectedVideo.id)
                  : undefined
              }
              onDelete={
                activeVideoEditor.onDelete
                  ? () => activeVideoEditor.onDelete?.(selectedVideo.id)
                  : undefined
              }
            />
          ) : undefined,
      });
    }

    if (activeAudioInsert || activeAudioEditor) {
      const labels = activeAudioEditor?.labels;
      const insertLabels = activeAudioInsert?.labels;
      const selectedAudio = selected?.type === 'audio' ? selected : null;
      adapters.push({
        id: 'audio',
        insertItem: activeAudioInsert
          ? {
              id: 'insert-audio',
              label: insertLabels?.insertAudio ?? 'Insert audio',
              tooltip: insertLabels?.insertAudio ?? 'Insert audio',
              icon: createElement(Volume2, { 'aria-hidden': true }),
              renderPopover: ({ close }) => (
                <AudioInsertPicker
                  labels={{
                    insertAudio: insertLabels?.insertAudio ?? 'Insert audio',
                    audioDrop: insertLabels?.audioDrop ?? 'Drop audio or click to choose a file',
                    audioOr: insertLabels?.audioOr ?? 'or paste an audio URL',
                    audioUrlPlaceholder: insertLabels?.audioUrlPlaceholder ?? 'https://...',
                    audioInsert: insertLabels?.audioInsert ?? 'Insert',
                  }}
                  onInsert={(result) => {
                    activeAudioInsert.onInsert(result);
                    close();
                  }}
                />
              ),
            }
          : undefined,
        overlay:
          selectedAudio && activeAudioEditor ? (
            <AudioToolbarOverlay
              element={selectedAudio as PPTAudioElement}
              elementIdPrefix={elementIdPrefix}
              labels={{
                toolbar: labels?.toolbar ?? 'Audio toolbar',
                preview: labels?.preview ?? 'Preview audio',
                pause: labels?.pause ?? 'Pause preview',
                loop: labels?.loop ?? 'Loop',
                bringToFront: labels?.bringToFront ?? 'Bring to front',
                sendToBack: labels?.sendToBack ?? 'Send to back',
                delete: labels?.delete ?? 'Delete',
              }}
              onLoopChange={(loop) => activeAudioEditor.onLoopChange(selectedAudio.id, loop)}
              onBringToFront={
                activeAudioEditor.onBringToFront
                  ? () => activeAudioEditor.onBringToFront?.(selectedAudio.id)
                  : undefined
              }
              onSendToBack={
                activeAudioEditor.onSendToBack
                  ? () => activeAudioEditor.onSendToBack?.(selectedAudio.id)
                  : undefined
              }
              onDelete={
                activeAudioEditor.onDelete
                  ? () => activeAudioEditor.onDelete?.(selectedAudio.id)
                  : undefined
              }
            />
          ) : undefined,
      });
    }

    if (activeElementToolbar && selected && ['shape', 'table', 'chart'].includes(selected.type)) {
      const labels = activeElementToolbar.labels;
      adapters.push({
        id: 'generic',
        overlay: (
          <ElementToolbarOverlay
            element={selected}
            elementIdPrefix={elementIdPrefix}
            labels={{
              toolbar: labels?.toolbar ?? 'Element toolbar',
              bringToFront: labels?.bringToFront ?? 'Bring to front',
              sendToBack: labels?.sendToBack ?? 'Send to back',
              delete: labels?.delete ?? 'Delete',
            }}
            onBringToFront={
              activeElementToolbar.onBringToFront
                ? () => activeElementToolbar.onBringToFront?.(selected.id)
                : undefined
            }
            onSendToBack={
              activeElementToolbar.onSendToBack
                ? () => activeElementToolbar.onSendToBack?.(selected.id)
                : undefined
            }
            onDelete={
              activeElementToolbar.onDelete
                ? () => activeElementToolbar.onDelete?.(selected.id)
                : undefined
            }
          />
        ),
      });
    }

    if (activeImageEditor && selected?.type === 'image') {
      const labels = activeImageEditor.labels;
      adapters.push({
        id: 'image',
        overlay: (
          <ImageToolbarOverlay
            element={selected as PPTImageElement}
            elementIdPrefix={elementIdPrefix}
            labels={{
              toolbar: labels?.toolbar ?? 'Image toolbar',
              replace: labels?.replace ?? 'Replace image',
              flipH: labels?.flipH ?? 'Flip horizontally',
              flipV: labels?.flipV ?? 'Flip vertically',
              bringToFront: labels?.bringToFront ?? 'Bring to front',
              sendToBack: labels?.sendToBack ?? 'Send to back',
              delete: labels?.delete ?? 'Delete',
            }}
            renderPicker={activeImageEditor.renderPicker}
            onReplace={
              activeImageEditor.onReplace
                ? (src) => activeImageEditor.onReplace?.(selected.id, src)
                : undefined
            }
            onFlip={
              activeImageEditor.onFlip
                ? (axis) => activeImageEditor.onFlip?.(selected, axis)
                : undefined
            }
            onBringToFront={
              activeImageEditor.onBringToFront
                ? () => activeImageEditor.onBringToFront?.(selected.id)
                : undefined
            }
            onSendToBack={
              activeImageEditor.onSendToBack
                ? () => activeImageEditor.onSendToBack?.(selected.id)
                : undefined
            }
            onDelete={
              activeImageEditor.onDelete
                ? () => activeImageEditor.onDelete?.(selected.id)
                : undefined
            }
          />
        ),
      });
    }

    if (latexDialog && activeLatexEditor) {
      const completeLatex = (result: LatexEditorResult) => {
        if (latexDialog.mode === 'edit') activeLatexEditor.onUpdate(latexDialog.element.id, result);
        else activeLatexEditor.onInsert(result);
        setLatexDialog(null);
      };
      adapters.push({
        id: 'latex-dialog',
        overlay: (
          <LatexEditorDialog
            initialLatex={latexDialog.mode === 'edit' ? latexDialog.element.latex : ''}
            labels={activeLatexEditor.labels}
            onConfirm={completeLatex}
            onClose={() => setLatexDialog(null)}
          />
        ),
      });
    }

    return {
      insertItems: adapters.flatMap((adapter) => (adapter.insertItem ? [adapter.insertItem] : [])),
      overlays: adapters.flatMap((adapter) => (adapter.overlay ? [adapter.overlay] : [])),
    };
  }, [
    audioEditor,
    audioInsert,
    elementToolbar,
    imageEditor,
    latexEditor,
    videoEditor,
    videoInsert,
    elementIdPrefix,
    latexDialog,
    selected,
  ]);
}
