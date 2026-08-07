'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { SlideContent } from '@openmaic/dsl';
import { createEditorTransactionFromIntents, type EditorHistoryMode } from '../core';
import { EditableSlideCanvas } from '../react/EditableSlideCanvas';
import {
  createCanvasCommands,
  createClipboardPasteState,
  createElementClipboard,
  useCanvasShortcuts,
  type CanvasCommands,
} from '../react';
import type { ReorderCommand, Selection } from '../react/types';
import type { TextEditorController, TextFormatState } from '../react/text/types';
import { EDITING_UI_STYLES } from './styles';
import { TextToolbarOverlay } from './text/TextToolbarOverlay';
import { LineToolbarOverlay } from './line/LineToolbarOverlay';
import { InsertToolbar } from './insert/InsertToolbar';
import { CanvasContextMenu } from './context/CanvasContextMenu';
import { EditorVideoContent } from './video/EditorVideoContent';
import { useBuiltinElementEditorAdapters } from './elementAdapters';
import { useHostElementEditorAdapters } from './adapters/registry';
import { resolveEditorHost } from './host';
import { resolveEditorLabels } from './labels';
import { createHostInsertItems, type EditorCreationMode } from './adapters/insert';
import { createDefaultLineElement, createDefaultTextElement } from './adapters/defaultElements';
import { BUILTIN_SHAPE_PATH_FORMULAS } from './adapters/shapeFormulas';
import type { CanvasContextMenuOptions, EditableSlideCanvasWithUIProps } from './types';

const INSERT_TOOLBAR_RAIL_SIZE = 48;
const EMPTY_COMMANDS: CanvasCommands = {
  clearSelection: () => undefined,
  selectAll: () => undefined,
  deleteSelection: () => undefined,
  lockSelection: () => undefined,
  copySelection: async () => undefined,
  cutSelection: async () => undefined,
  pasteElements: async () => undefined,
  unlockTarget: () => undefined,
  toggleGroup: () => undefined,
  reorderTarget: () => undefined,
  alignSelection: () => undefined,
};

interface TextFormatEntry {
  readonly elementId: string;
  readonly state: TextFormatState;
}

export function EditableSlideCanvasWithUI({
  host,
  documentSlide,
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
  onTextContentChange,
  onTextAutoSize,
  onTextFocusChange,
  onTableCellChange,
  onTextCreate,
  onLineCreate,
  onLineCreateCancel,
  onTransaction,
  onSelectionChange,
  elementIdPrefix,
  ...canvasProps
}: EditableSlideCanvasWithUIProps) {
  const [controller, setController] = useState<TextEditorController | null>(null);
  const [formatEntry, setFormatEntry] = useState<TextFormatEntry | null>(null);
  const [insertToolbarRailSize, setInsertToolbarRailSize] = useState(INSERT_TOOLBAR_RAIL_SIZE);
  const [creationMode, setCreationMode] = useState<EditorCreationMode>(null);
  const [editorFocused, setEditorFocused] = useState(false);
  const editingId = canvasProps.selection?.editingId ?? '';
  const activeController = controller?.elementId === editingId ? controller : null;
  const activeFormat = formatEntry?.elementId === editingId ? formatEntry.state : null;
  const commandSlide = documentSlide ?? canvasProps.slide;
  const content = useMemo<SlideContent>(
    () => ({ type: 'slide', canvas: commandSlide }),
    [commandSlide],
  );
  const resolvedHost = useMemo(() => (host ? resolveEditorHost(host) : null), [host]);
  const editorLabels = useMemo(
    () => (resolvedHost ? resolveEditorLabels(resolvedHost.locale) : null),
    [resolvedHost],
  );
  const clipboard = useMemo(() => createElementClipboard(), []);
  const clipboardPasteState = useMemo(() => createClipboardPasteState(), []);
  const hasIntentSink = Boolean(onTransaction || onElementsChange);
  const emitIntents = useCallback(
    (
      intents: Parameters<typeof createEditorTransactionFromIntents>[0]['intents'],
      options: {
        origin?: 'canvas' | 'toolbar' | 'agent' | 'system';
        history?: EditorHistoryMode;
      } = {},
    ) => {
      if (onTransaction) {
        const transaction = createEditorTransactionFromIntents({ content, intents, ...options });
        if (transaction) onTransaction(transaction);
        return;
      }
      onElementsChange?.([...intents]);
    },
    [content, onElementsChange, onTransaction],
  );
  const handleCanvasTextContentChange = useCallback(
    (
      change: NonNullable<EditableSlideCanvasWithUIProps['onTextContentChange']> extends (
        value: infer T,
      ) => void
        ? T
        : never,
    ) => {
      if (onTransaction || onElementsChange)
        emitIntents([change.intent], { history: change.history });
      else onTextContentChange?.(change);
    },
    [emitIntents, onElementsChange, onTextContentChange, onTransaction],
  );
  const handleCanvasTextAutoSize = useCallback(
    (
      intent: NonNullable<EditableSlideCanvasWithUIProps['onTextAutoSize']> extends (
        value: infer T,
      ) => void
        ? T
        : never,
    ) => {
      if (onTransaction || onElementsChange)
        emitIntents([intent], { origin: 'system', history: 'neutral' });
      else onTextAutoSize?.(intent);
    },
    [emitIntents, onElementsChange, onTextAutoSize, onTransaction],
  );
  const handleCanvasTableCellChange = useCallback(
    (
      change: NonNullable<EditableSlideCanvasWithUIProps['onTableCellChange']> extends (
        value: infer T,
      ) => void
        ? T
        : never,
    ) => {
      if (onTransaction || onElementsChange)
        emitIntents([change.intent], { history: change.history });
      else onTableCellChange?.(change);
    },
    [emitIntents, onElementsChange, onTableCellChange, onTransaction],
  );
  const selectedLine = useMemo(() => {
    const elementIds = canvasProps.selection?.elementIds ?? [];
    if (elementIds.length !== 1) return null;
    const elementId = canvasProps.selection?.primaryId ?? elementIds[0];
    if (canvasProps.hiddenElementIds?.includes(elementId)) return null;
    const element = canvasProps.slide.elements.find((candidate) => candidate.id === elementId);
    return element?.type === 'line' && !element.lock ? element : null;
  }, [canvasProps.hiddenElementIds, canvasProps.selection, canvasProps.slide.elements]);
  const { insertItems: adapterInsertItems, overlays: elementEditorOverlays } =
    useBuiltinElementEditorAdapters({
      slide: canvasProps.slide,
      selection: canvasProps.selection,
      hiddenElementIds: canvasProps.hiddenElementIds,
      elementIdPrefix: elementIdPrefix ?? 'slide-element-',
      latexEditor: host ? false : latexEditor,
      videoEditor: host ? false : videoEditor,
      videoInsert: host ? false : videoInsert,
      audioEditor: host ? false : audioEditor,
      audioInsert: host ? false : audioInsert,
      elementToolbar: host ? false : elementToolbar,
      imageEditor: host ? false : imageEditor,
    });
  const hostAdapterContext = useMemo(
    () =>
      resolvedHost && editorLabels && hasIntentSink
        ? {
            slide: commandSlide,
            selection: canvasProps.selection,
            hiddenElementIds: canvasProps.hiddenElementIds,
            elementIdPrefix: elementIdPrefix ?? 'slide-element-',
            host: resolvedHost,
            labels: editorLabels,
            dispatch: emitIntents,
            select: (selection: Selection) => onSelectionChange?.(selection),
          }
        : null,
    [
      canvasProps.hiddenElementIds,
      canvasProps.selection,
      commandSlide,
      editorLabels,
      elementIdPrefix,
      emitIntents,
      onSelectionChange,
      resolvedHost,
      hasIntentSink,
    ],
  );
  const hostAdapters = useHostElementEditorAdapters(hostAdapterContext);
  const hostInsertItems = useMemo(
    () =>
      hostAdapterContext
        ? createHostInsertItems(hostAdapterContext, creationMode, setCreationMode)
        : [],
    [creationMode, hostAdapterContext],
  );
  const resolvedInsertToolbar = useMemo(() => {
    if (insertToolbar === false) return false;
    const base =
      insertToolbar ??
      (hostAdapterContext ? { label: editorLabels?.insert.toolbar, items: [] } : undefined);
    if (!base) return undefined;
    return {
      ...base,
      items: [
        ...base.items,
        ...hostInsertItems,
        ...adapterInsertItems,
        ...hostAdapters.insertItems,
      ],
    };
  }, [
    adapterInsertItems,
    editorLabels?.insert.toolbar,
    hostAdapterContext,
    hostAdapters.insertItems,
    hostInsertItems,
    insertToolbar,
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

  const handleEditorFocusChange = useCallback(
    (focused: boolean) => {
      setEditorFocused(focused);
      onTextFocusChange?.(focused);
    },
    [onTextFocusChange],
  );

  const handleHostTextCreate = useCallback(
    (rect: Parameters<NonNullable<EditableSlideCanvasWithUIProps['onTextCreate']>>[0]) => {
      if (!resolvedHost) {
        onTextCreate?.(rect);
        return;
      }
      const id = resolvedHost.createElementId('text');
      emitIntents([{ type: 'element.add', element: createDefaultTextElement(id, rect) }], {
        origin: 'toolbar',
      });
      setCreationMode(null);
      onSelectionChange?.({ elementIds: [id], primaryId: id, editingId: id });
    },
    [emitIntents, onSelectionChange, onTextCreate, resolvedHost],
  );

  const handleHostLineCreate = useCallback(
    (geometry: Parameters<NonNullable<EditableSlideCanvasWithUIProps['onLineCreate']>>[0]) => {
      if (!resolvedHost || creationMode?.type !== 'line') {
        onLineCreate?.(geometry);
        return;
      }
      const id = resolvedHost.createElementId('line');
      emitIntents(
        [
          {
            type: 'element.add',
            element: createDefaultLineElement(id, geometry, creationMode.preset),
          },
        ],
        { origin: 'toolbar' },
      );
      setCreationMode(null);
      onSelectionChange?.({ elementIds: [id], primaryId: id });
    },
    [creationMode, emitIntents, onLineCreate, onSelectionChange, resolvedHost],
  );

  const hostCommands = useMemo(
    () =>
      resolvedHost && onTransaction && onSelectionChange
        ? createCanvasCommands({
            content,
            selection: canvasProps.selection ?? { elementIds: [] },
            hiddenElementIds: canvasProps.hiddenElementIds,
            onTransaction,
            onSelectionChange,
            createElementId: resolvedHost.createElementId,
            clipboard,
            clipboardPasteState,
          })
        : null,
    [
      canvasProps.hiddenElementIds,
      canvasProps.selection,
      clipboard,
      clipboardPasteState,
      content,
      onSelectionChange,
      onTransaction,
      resolvedHost,
    ],
  );
  const shortcutCommands = useMemo<CanvasCommands>(() => {
    if (!hostCommands) return EMPTY_COMMANDS;
    return {
      ...hostCommands,
      clearSelection: () => {
        setCreationMode(null);
        hostCommands.clearSelection();
      },
    };
  }, [hostCommands]);
  useCanvasShortcuts(shortcutCommands, {
    enabled: Boolean(hostCommands && resolvedHost?.shortcutsEnabled && !editorFocused),
  });

  const hostContextMenu = useMemo<CanvasContextMenuOptions | null>(() => {
    if (!hostCommands || !editorLabels) return null;
    return {
      labels: editorLabels.contextMenu,
      onSelectAll: hostCommands.selectAll,
      onCopy: hostCommands.copySelection,
      onCut: hostCommands.cutSelection,
      onPaste: hostCommands.pasteElements,
      onUnlock: hostCommands.unlockTarget,
      onLock: hostCommands.lockSelection,
      onDelete: hostCommands.deleteSelection,
      onToggleGroup: hostCommands.toggleGroup,
      onReorder: hostCommands.reorderTarget,
      onAlign: hostCommands.alignSelection,
    };
  }, [editorLabels, hostCommands]);
  const activeContextMenu = contextMenu === false ? null : (contextMenu ?? hostContextMenu);

  const emitReorder = useCallback(
    (command: Extract<ReorderCommand, 'front' | 'back'>) => {
      if (!editingId) return;
      emitIntents([{ type: 'element.reorder', id: editingId, command }], { origin: 'toolbar' });
    },
    [editingId, emitIntents],
  );

  const emitLineReorder = useCallback(
    (command: Extract<ReorderCommand, 'front' | 'back'>) => {
      if (!selectedLine) return;
      emitIntents([{ type: 'element.reorder', id: selectedLine.id, command }], {
        origin: 'toolbar',
      });
    },
    [emitIntents, selectedLine],
  );

  const deleteSelectedLine = useCallback(() => {
    if (!selectedLine) return;
    emitIntents([{ type: 'element.delete', ids: [selectedLine.id] }], { origin: 'toolbar' });
    onSelectionChange?.({ elementIds: [] });
  }, [emitIntents, onSelectionChange, selectedLine]);

  const deleteActiveText = useCallback(() => {
    if (!editingId) return;
    emitIntents([{ type: 'element.delete', ids: [editingId] }], { origin: 'toolbar' });
    onSelectionChange?.({ elementIds: [] });
  }, [editingId, emitIntents, onSelectionChange]);

  const elementActions =
    (onTransaction || onElementsChange) && activeController?.kind !== 'table-cell'
      ? {
          onBringToFront: () => emitReorder('front'),
          onSendToBack: () => emitReorder('back'),
          onDelete: deleteActiveText,
        }
      : {};
  const resolvedTextToolbar =
    textToolbar ?? (resolvedHost ? { locale: resolvedHost.locale } : undefined);
  const resolvedLineToolbar =
    lineToolbar ?? (resolvedHost ? { locale: resolvedHost.locale } : undefined);
  const creatingText = resolvedHost ? creationMode?.type === 'text' : canvasProps.creatingText;
  const creatingLine = resolvedHost ? creationMode?.type === 'line' : canvasProps.creatingLine;

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
              shapePathFormulas={
                resolvedHost ? BUILTIN_SHAPE_PATH_FORMULAS : canvasProps.shapePathFormulas
              }
              renderVideo={
                resolvedHost
                  ? (element) => <EditorVideoContent element={element} />
                  : canvasProps.renderVideo
              }
              videoInteractive={resolvedHost ? false : canvasProps.videoInteractive}
              creatingText={creatingText}
              onTextCreate={handleHostTextCreate}
              creatingLine={creatingLine}
              onLineCreate={handleHostLineCreate}
              onLineCreateCancel={() => {
                if (resolvedHost) setCreationMode(null);
                else onLineCreateCancel?.();
              }}
              tableEditMaskLabel={
                editorLabels?.table.doubleClickToEdit ?? canvasProps.tableEditMaskLabel
              }
              onElementsChange={hasIntentSink ? (intents) => emitIntents(intents) : undefined}
              onTextContentChange={
                hasIntentSink || onTextContentChange ? handleCanvasTextContentChange : undefined
              }
              onTextAutoSize={
                hasIntentSink || onTextAutoSize ? handleCanvasTextAutoSize : undefined
              }
              onTextFocusChange={handleEditorFocusChange}
              onTableCellChange={
                hasIntentSink || onTableCellChange ? handleCanvasTableCellChange : undefined
              }
              onSelectionChange={onSelectionChange}
              onTextEditorChange={handleTextEditorChange}
              onTextFormatChange={handleTextFormatChange}
            />
          </CanvasContextMenu>
        ) : (
          <EditableSlideCanvas
            {...canvasProps}
            elementIdPrefix={elementIdPrefix}
            shapePathFormulas={
              resolvedHost ? BUILTIN_SHAPE_PATH_FORMULAS : canvasProps.shapePathFormulas
            }
            renderVideo={
              resolvedHost
                ? (element) => <EditorVideoContent element={element} />
                : canvasProps.renderVideo
            }
            videoInteractive={resolvedHost ? false : canvasProps.videoInteractive}
            creatingText={creatingText}
            onTextCreate={handleHostTextCreate}
            creatingLine={creatingLine}
            onLineCreate={handleHostLineCreate}
            onLineCreateCancel={() => {
              if (resolvedHost) setCreationMode(null);
              else onLineCreateCancel?.();
            }}
            tableEditMaskLabel={
              editorLabels?.table.doubleClickToEdit ?? canvasProps.tableEditMaskLabel
            }
            onElementsChange={hasIntentSink ? (intents) => emitIntents(intents) : undefined}
            onTextContentChange={
              hasIntentSink || onTextContentChange ? handleCanvasTextContentChange : undefined
            }
            onTextAutoSize={hasIntentSink || onTextAutoSize ? handleCanvasTextAutoSize : undefined}
            onTextFocusChange={handleEditorFocusChange}
            onTableCellChange={
              hasIntentSink || onTableCellChange ? handleCanvasTableCellChange : undefined
            }
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
      {resolvedTextToolbar !== false && activeController && activeFormat ? (
        <TextToolbarOverlay
          elementId={editingId}
          elementIdPrefix={elementIdPrefix ?? 'slide-element-'}
          format={activeFormat}
          onCommand={(command) => activeController.execute(command)}
          {...elementActions}
          {...resolvedTextToolbar}
        />
      ) : null}
      {resolvedLineToolbar !== false && selectedLine && (onTransaction || onElementsChange) ? (
        <LineToolbarOverlay
          element={selectedLine}
          elementIdPrefix={elementIdPrefix ?? 'slide-element-'}
          onChange={(intents) => emitIntents(intents, { origin: 'toolbar' })}
          onBringToFront={() => emitLineReorder('front')}
          onSendToBack={() => emitLineReorder('back')}
          onDelete={deleteSelectedLine}
          {...resolvedLineToolbar}
        />
      ) : null}
      {elementEditorOverlays.map((overlay, index) => (
        <span key={index}>{overlay}</span>
      ))}
      {hostAdapters.overlays.map((overlay, index) => (
        <span key={`host-${index}`}>{overlay}</span>
      ))}
    </div>
  );
}
