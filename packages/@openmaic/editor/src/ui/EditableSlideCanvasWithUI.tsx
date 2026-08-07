'use client';

import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from 'react';
import { Sigma, Video, Volume2 } from 'lucide-react';
import type { PPTAudioElement, PPTImageElement, PPTLatexElement } from '@openmaic/dsl';
import { EditableSlideCanvas } from '../react/EditableSlideCanvas';
import type { ReorderCommand } from '../react/types';
import type { TextEditorController, TextFormatState } from '../react/text/types';
import { EDITING_UI_STYLES } from './styles';
import { TextToolbarOverlay } from './text/TextToolbarOverlay';
import { LineToolbarOverlay } from './line/LineToolbarOverlay';
import { InsertToolbar } from './insert/InsertToolbar';
import { LatexEditorDialog } from './latex/LatexEditorDialog';
import { LatexToolbarOverlay } from './latex/LatexToolbarOverlay';
import { VideoToolbarOverlay } from './video/VideoToolbarOverlay';
import { VideoInsertPicker } from './video/VideoInsertPicker';
import { AudioToolbarOverlay } from './audio/AudioToolbarOverlay';
import { AudioInsertPicker } from './audio/AudioInsertPicker';
import { ElementToolbarOverlay } from './element/ElementToolbarOverlay';
import { ImageToolbarOverlay } from './element/ImageToolbarOverlay';
import { CanvasContextMenu } from './context/CanvasContextMenu';
import type { LatexEditorResult } from './latex/latex-editor';
import type { EditableSlideCanvasWithUIProps } from './types';

const INSERT_TOOLBAR_RAIL_SIZE = 48;

interface TextFormatEntry {
  readonly elementId: string;
  readonly state: TextFormatState;
}

type LatexDialogState =
  | { readonly mode: 'insert' }
  | { readonly mode: 'edit'; readonly element: PPTLatexElement }
  | null;

export function EditableSlideCanvasWithUI({
  textToolbar,
  lineToolbar,
  insertToolbar,
  latexEditor,
  videoEditor,
  videoInsert,
  audioEditor,
  audioInsert,
  elementToolbar,
  imageEditor,
  contextMenu,
  onTextEditorChange,
  onTextFormatChange,
  onElementsChange,
  onSelectionChange,
  elementIdPrefix,
  ...canvasProps
}: EditableSlideCanvasWithUIProps) {
  const [controller, setController] = useState<TextEditorController | null>(null);
  const [formatEntry, setFormatEntry] = useState<TextFormatEntry | null>(null);
  const [latexDialog, setLatexDialog] = useState<LatexDialogState>(null);
  const [insertToolbarRailSize, setInsertToolbarRailSize] = useState(INSERT_TOOLBAR_RAIL_SIZE);
  const editingId = canvasProps.selection?.editingId ?? '';
  const activeController = controller?.elementId === editingId ? controller : null;
  const activeFormat = formatEntry?.elementId === editingId ? formatEntry.state : null;
  const selectedLine = useMemo(() => {
    const elementIds = canvasProps.selection?.elementIds ?? [];
    if (elementIds.length !== 1) return null;
    const elementId = canvasProps.selection?.primaryId ?? elementIds[0];
    if (canvasProps.hiddenElementIds?.includes(elementId)) return null;
    const element = canvasProps.slide.elements.find((candidate) => candidate.id === elementId);
    return element?.type === 'line' && !element.lock ? element : null;
  }, [canvasProps.hiddenElementIds, canvasProps.selection, canvasProps.slide.elements]);
  const activeLatexEditor = latexEditor === false ? null : latexEditor;
  const activeVideoEditor = videoEditor === false ? null : videoEditor;
  const activeVideoInsert = videoInsert === false ? null : videoInsert;
  const activeAudioEditor = audioEditor === false ? null : audioEditor;
  const activeAudioInsert = audioInsert === false ? null : audioInsert;
  const activeElementToolbar = elementToolbar === false ? null : elementToolbar;
  const activeImageEditor = imageEditor === false ? null : imageEditor;
  const activeContextMenu = contextMenu === false ? null : contextMenu;
  const selectedLatex = useMemo(() => {
    if (!activeLatexEditor) return null;
    const elementIds = canvasProps.selection?.elementIds ?? [];
    if (elementIds.length !== 1) return null;
    const elementId = canvasProps.selection?.primaryId ?? elementIds[0];
    if (canvasProps.hiddenElementIds?.includes(elementId)) return null;
    const element = canvasProps.slide.elements.find((candidate) => candidate.id === elementId);
    return element?.type === 'latex' && !element.lock ? element : null;
  }, [
    activeLatexEditor,
    canvasProps.hiddenElementIds,
    canvasProps.selection,
    canvasProps.slide.elements,
  ]);

  const latexLabels = activeLatexEditor?.labels;
  const latexToolbarLabel = latexLabels?.toolbar ?? 'Formula toolbar';
  const latexInsertLabel = latexLabels?.insertFormula ?? 'Insert formula';
  const latexEditLabel = latexLabels?.editFormula ?? 'Edit formula';
  const latexBringToFrontLabel = latexLabels?.bringToFront ?? 'Bring to front';
  const latexSendToBackLabel = latexLabels?.sendToBack ?? 'Send to back';
  const latexDeleteLabel = latexLabels?.delete ?? 'Delete';
  const videoInsertLabels = activeVideoInsert?.labels;
  const resolvedVideoInsertLabels = {
    insertVideo: videoInsertLabels?.insertVideo ?? 'Insert video',
    videoDrop: videoInsertLabels?.videoDrop ?? 'Drop a video or click to choose a file',
    videoOr: videoInsertLabels?.videoOr ?? 'or paste a video URL',
    videoUrlPlaceholder: videoInsertLabels?.videoUrlPlaceholder ?? 'https://...',
    videoInsert: videoInsertLabels?.videoInsert ?? 'Insert',
  };
  const selectedVideo = useMemo(() => {
    if (!activeVideoEditor) return null;
    const elementIds = canvasProps.selection?.elementIds ?? [];
    if (elementIds.length !== 1) return null;
    const elementId = canvasProps.selection?.primaryId ?? elementIds[0];
    if (canvasProps.hiddenElementIds?.includes(elementId)) return null;
    const element = canvasProps.slide.elements.find((candidate) => candidate.id === elementId);
    return element?.type === 'video' && !element.lock ? element : null;
  }, [
    activeVideoEditor,
    canvasProps.hiddenElementIds,
    canvasProps.selection,
    canvasProps.slide.elements,
  ]);
  const videoLabels = activeVideoEditor?.labels;
  const resolvedVideoLabels = {
    toolbar: videoLabels?.toolbar ?? 'Video toolbar',
    poster: videoLabels?.poster ?? 'Set poster',
    bringToFront: videoLabels?.bringToFront ?? 'Bring to front',
    sendToBack: videoLabels?.sendToBack ?? 'Send to back',
    delete: videoLabels?.delete ?? 'Delete',
  };
  const audioInsertLabels = activeAudioInsert?.labels;
  const resolvedAudioInsertLabels = {
    insertAudio: audioInsertLabels?.insertAudio ?? 'Insert audio',
    audioDrop: audioInsertLabels?.audioDrop ?? 'Drop audio or click to choose a file',
    audioOr: audioInsertLabels?.audioOr ?? 'or paste an audio URL',
    audioUrlPlaceholder: audioInsertLabels?.audioUrlPlaceholder ?? 'https://...',
    audioInsert: audioInsertLabels?.audioInsert ?? 'Insert',
  };
  const selectedAudio = useMemo(() => {
    if (!activeAudioEditor) return null;
    const elementIds = canvasProps.selection?.elementIds ?? [];
    if (elementIds.length !== 1) return null;
    const elementId = canvasProps.selection?.primaryId ?? elementIds[0];
    if (canvasProps.hiddenElementIds?.includes(elementId)) return null;
    const element = canvasProps.slide.elements.find((candidate) => candidate.id === elementId);
    return element?.type === 'audio' && !element.lock ? element : null;
  }, [
    activeAudioEditor,
    canvasProps.hiddenElementIds,
    canvasProps.selection,
    canvasProps.slide.elements,
  ]);
  const audioLabels = activeAudioEditor?.labels;
  const resolvedAudioLabels = {
    toolbar: audioLabels?.toolbar ?? 'Audio toolbar',
    preview: audioLabels?.preview ?? 'Preview audio',
    pause: audioLabels?.pause ?? 'Pause preview',
    loop: audioLabels?.loop ?? 'Loop',
    bringToFront: audioLabels?.bringToFront ?? 'Bring to front',
    sendToBack: audioLabels?.sendToBack ?? 'Send to back',
    delete: audioLabels?.delete ?? 'Delete',
  };
  const selectedElement = useMemo(() => {
    if (!activeElementToolbar) return null;
    const elementIds = canvasProps.selection?.elementIds ?? [];
    if (elementIds.length !== 1) return null;
    const elementId = canvasProps.selection?.primaryId ?? elementIds[0];
    if (canvasProps.hiddenElementIds?.includes(elementId)) return null;
    const element = canvasProps.slide.elements.find((candidate) => candidate.id === elementId);
    return element && ['shape', 'table', 'chart'].includes(element.type) && !element.lock
      ? element
      : null;
  }, [
    activeElementToolbar,
    canvasProps.hiddenElementIds,
    canvasProps.selection,
    canvasProps.slide.elements,
  ]);
  const selectedImage = useMemo(() => {
    if (!activeImageEditor) return null;
    const elementIds = canvasProps.selection?.elementIds ?? [];
    if (elementIds.length !== 1) return null;
    const elementId = canvasProps.selection?.primaryId ?? elementIds[0];
    if (canvasProps.hiddenElementIds?.includes(elementId)) return null;
    const element = canvasProps.slide.elements.find((candidate) => candidate.id === elementId);
    return element?.type === 'image' && !element.lock ? element : null;
  }, [
    activeImageEditor,
    canvasProps.hiddenElementIds,
    canvasProps.selection,
    canvasProps.slide.elements,
  ]);
  const resolvedElementToolbarLabels = {
    toolbar: activeElementToolbar?.labels?.toolbar ?? 'Element toolbar',
    bringToFront: activeElementToolbar?.labels?.bringToFront ?? 'Bring to front',
    sendToBack: activeElementToolbar?.labels?.sendToBack ?? 'Send to back',
    delete: activeElementToolbar?.labels?.delete ?? 'Delete',
  };
  const resolvedImageEditorLabels = {
    toolbar: activeImageEditor?.labels?.toolbar ?? 'Image toolbar',
    replace: activeImageEditor?.labels?.replace ?? 'Replace image',
    flipH: activeImageEditor?.labels?.flipH ?? 'Flip horizontally',
    flipV: activeImageEditor?.labels?.flipV ?? 'Flip vertically',
    bringToFront: activeImageEditor?.labels?.bringToFront ?? 'Bring to front',
    sendToBack: activeImageEditor?.labels?.sendToBack ?? 'Send to back',
    delete: activeImageEditor?.labels?.delete ?? 'Delete',
  };
  const resolvedInsertToolbar = useMemo(() => {
    if (!insertToolbar || (!activeLatexEditor && !activeVideoInsert && !activeAudioInsert)) {
      return insertToolbar;
    }
    const items = [...insertToolbar.items];
    if (activeLatexEditor) {
      items.push({
        id: 'insert-latex',
        label: latexInsertLabel,
        tooltip: latexInsertLabel,
        icon: createElement(Sigma, { 'aria-hidden': true }),
        onInvoke: () => setLatexDialog({ mode: 'insert' }),
      });
    }
    if (activeVideoInsert) {
      items.push({
        id: 'insert-video',
        label: resolvedVideoInsertLabels.insertVideo,
        tooltip: resolvedVideoInsertLabels.insertVideo,
        icon: createElement(Video, { 'aria-hidden': true }),
        renderPopover: ({ close }) => (
          <VideoInsertPicker
            labels={resolvedVideoInsertLabels}
            onInsert={(result) => {
              activeVideoInsert.onInsert(result);
              close();
            }}
          />
        ),
      });
    }
    if (activeAudioInsert) {
      items.push({
        id: 'insert-audio',
        label: resolvedAudioInsertLabels.insertAudio,
        tooltip: resolvedAudioInsertLabels.insertAudio,
        icon: createElement(Volume2, { 'aria-hidden': true }),
        renderPopover: ({ close }) => (
          <AudioInsertPicker
            labels={resolvedAudioInsertLabels}
            onInsert={(result) => {
              activeAudioInsert.onInsert(result);
              close();
            }}
          />
        ),
      });
    }
    return {
      ...insertToolbar,
      items,
    };
  }, [
    activeLatexEditor,
    activeAudioInsert,
    activeVideoInsert,
    insertToolbar,
    latexInsertLabel,
    resolvedAudioInsertLabels,
    resolvedVideoInsertLabels,
  ]);
  const insertToolbarPlacement = resolvedInsertToolbar
    ? (resolvedInsertToolbar.placement ?? 'top')
    : 'top';
  const handleInsertToolbarRailSizeChange = useCallback((size: number) => {
    setInsertToolbarRailSize((current) => (current === size ? current : size));
  }, []);
  const canvasViewportStyle = useMemo<CSSProperties>(() => {
    if (!resolvedInsertToolbar) {
      return { position: 'relative', width: '100%', height: '100%' };
    }
    if (insertToolbarPlacement === 'top') {
      return {
        bottom: 0,
        left: 0,
        position: 'absolute',
        right: 0,
        top: `${insertToolbarRailSize}px`,
      };
    }
    return {
      bottom: 0,
      left: `${insertToolbarRailSize}px`,
      position: 'absolute',
      right: 0,
      top: 0,
    };
  }, [insertToolbarPlacement, insertToolbarRailSize, resolvedInsertToolbar]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- selection changes must clear stale editor state before a later re-selection.
    setController((current) => (current?.elementId === editingId ? current : null));
    setFormatEntry((current) => (current?.elementId === editingId ? current : null));
  }, [editingId]);

  const handleTextEditorChange = useCallback(
    (nextController: TextEditorController | null) => {
      if (nextController === null) {
        setController((current) => (current?.elementId === editingId ? null : current));
        setFormatEntry((current) => (current?.elementId === editingId ? null : current));
      } else if (nextController.elementId === editingId) {
        setController(nextController);
      }
      onTextEditorChange?.(nextController);
    },
    [editingId, onTextEditorChange],
  );

  const handleTextFormatChange = useCallback(
    (elementId: string, state: TextFormatState) => {
      if (elementId === editingId) setFormatEntry({ elementId, state });
      onTextFormatChange?.(elementId, state);
    },
    [editingId, onTextFormatChange],
  );

  const emitReorder = useCallback(
    (command: Extract<ReorderCommand, 'front' | 'back'>) => {
      if (!editingId || !onElementsChange) return;
      onElementsChange([{ type: 'element.reorder', id: editingId, command }]);
    },
    [editingId, onElementsChange],
  );

  const emitLineReorder = useCallback(
    (command: Extract<ReorderCommand, 'front' | 'back'>) => {
      if (!selectedLine || !onElementsChange) return;
      onElementsChange([{ type: 'element.reorder', id: selectedLine.id, command }]);
    },
    [onElementsChange, selectedLine],
  );

  const deleteSelectedLine = useCallback(() => {
    if (!selectedLine || !onElementsChange) return;
    onElementsChange([{ type: 'element.delete', ids: [selectedLine.id] }]);
    onSelectionChange?.({ elementIds: [] });
  }, [onElementsChange, onSelectionChange, selectedLine]);

  const deleteActiveText = useCallback(() => {
    if (!editingId || !onElementsChange) return;
    onElementsChange([{ type: 'element.delete', ids: [editingId] }]);
    onSelectionChange?.({ elementIds: [] });
  }, [editingId, onElementsChange, onSelectionChange]);

  const completeLatex = useCallback(
    (result: LatexEditorResult) => {
      if (!activeLatexEditor || !latexDialog) return;
      if (latexDialog.mode === 'edit') activeLatexEditor.onUpdate(latexDialog.element.id, result);
      else activeLatexEditor.onInsert(result);
      setLatexDialog(null);
    },
    [activeLatexEditor, latexDialog],
  );

  const elementActions =
    onElementsChange && activeController?.kind !== 'table-cell'
      ? {
          onBringToFront: () => emitReorder('front'),
          onSendToBack: () => emitReorder('back'),
          onDelete: deleteActiveText,
        }
      : {};

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <style dangerouslySetInnerHTML={{ __html: EDITING_UI_STYLES }} />
      <div data-editing-ui-canvas-viewport="" style={canvasViewportStyle}>
        {activeContextMenu ? (
          <CanvasContextMenu
            {...activeContextMenu}
            elements={canvasProps.slide.elements}
            selection={canvasProps.selection ?? { elementIds: [] }}
            onSelectionChange={onSelectionChange ?? (() => undefined)}
          >
            <EditableSlideCanvas
              {...canvasProps}
              elementIdPrefix={elementIdPrefix}
              onElementsChange={onElementsChange}
              onSelectionChange={onSelectionChange}
              onTextEditorChange={handleTextEditorChange}
              onTextFormatChange={handleTextFormatChange}
            />
          </CanvasContextMenu>
        ) : (
          <EditableSlideCanvas
            {...canvasProps}
            elementIdPrefix={elementIdPrefix}
            onElementsChange={onElementsChange}
            onSelectionChange={onSelectionChange}
            onTextEditorChange={handleTextEditorChange}
            onTextFormatChange={handleTextFormatChange}
          />
        )}
      </div>
      {resolvedInsertToolbar !== false && resolvedInsertToolbar ? (
        <InsertToolbar
          {...resolvedInsertToolbar}
          onRailSizeChange={handleInsertToolbarRailSizeChange}
        />
      ) : null}
      {textToolbar !== false && activeController && activeFormat ? (
        <TextToolbarOverlay
          elementId={editingId}
          elementIdPrefix={elementIdPrefix ?? 'slide-element-'}
          format={activeFormat}
          onCommand={(command) => activeController.execute(command)}
          {...elementActions}
          {...textToolbar}
        />
      ) : null}
      {lineToolbar !== false && selectedLine && onElementsChange ? (
        <LineToolbarOverlay
          element={selectedLine}
          elementIdPrefix={elementIdPrefix ?? 'slide-element-'}
          onChange={onElementsChange}
          onBringToFront={() => emitLineReorder('front')}
          onSendToBack={() => emitLineReorder('back')}
          onDelete={deleteSelectedLine}
          {...lineToolbar}
        />
      ) : null}
      {selectedLatex && activeLatexEditor ? (
        <LatexToolbarOverlay
          element={selectedLatex}
          elementIdPrefix={elementIdPrefix ?? 'slide-element-'}
          toolbarLabel={latexToolbarLabel}
          editLabel={latexEditLabel}
          bringToFrontLabel={latexBringToFrontLabel}
          sendToBackLabel={latexSendToBackLabel}
          deleteLabel={latexDeleteLabel}
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
      ) : null}
      {selectedVideo && activeVideoEditor ? (
        <VideoToolbarOverlay
          element={selectedVideo}
          elementIdPrefix={elementIdPrefix ?? 'slide-element-'}
          labels={resolvedVideoLabels}
          renderPosterPicker={activeVideoEditor.renderPosterPicker}
          onPosterChange={(poster) => activeVideoEditor.onPosterChange(selectedVideo.id, poster)}
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
      ) : null}
      {selectedAudio && activeAudioEditor ? (
        <AudioToolbarOverlay
          element={selectedAudio as PPTAudioElement}
          elementIdPrefix={elementIdPrefix ?? 'slide-element-'}
          labels={resolvedAudioLabels}
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
      ) : null}
      {selectedElement && activeElementToolbar ? (
        <ElementToolbarOverlay
          element={selectedElement}
          elementIdPrefix={elementIdPrefix ?? 'slide-element-'}
          labels={resolvedElementToolbarLabels}
          onBringToFront={
            activeElementToolbar.onBringToFront
              ? () => activeElementToolbar.onBringToFront?.(selectedElement.id)
              : undefined
          }
          onSendToBack={
            activeElementToolbar.onSendToBack
              ? () => activeElementToolbar.onSendToBack?.(selectedElement.id)
              : undefined
          }
          onDelete={
            activeElementToolbar.onDelete
              ? () => activeElementToolbar.onDelete?.(selectedElement.id)
              : undefined
          }
        />
      ) : null}
      {selectedImage && activeImageEditor ? (
        <ImageToolbarOverlay
          element={selectedImage as PPTImageElement}
          elementIdPrefix={elementIdPrefix ?? 'slide-element-'}
          labels={resolvedImageEditorLabels}
          renderPicker={activeImageEditor.renderPicker}
          onReplace={
            activeImageEditor.onReplace
              ? (src) => activeImageEditor.onReplace?.(selectedImage.id, src)
              : undefined
          }
          onFlip={
            activeImageEditor.onFlip
              ? (axis) => activeImageEditor.onFlip?.(selectedImage, axis)
              : undefined
          }
          onBringToFront={
            activeImageEditor.onBringToFront
              ? () => activeImageEditor.onBringToFront?.(selectedImage.id)
              : undefined
          }
          onSendToBack={
            activeImageEditor.onSendToBack
              ? () => activeImageEditor.onSendToBack?.(selectedImage.id)
              : undefined
          }
          onDelete={
            activeImageEditor.onDelete
              ? () => activeImageEditor.onDelete?.(selectedImage.id)
              : undefined
          }
        />
      ) : null}
      {latexDialog && activeLatexEditor ? (
        <LatexEditorDialog
          initialLatex={latexDialog.mode === 'edit' ? latexDialog.element.latex : ''}
          labels={latexLabels}
          onConfirm={completeLatex}
          onClose={() => setLatexDialog(null)}
        />
      ) : null}
    </div>
  );
}
