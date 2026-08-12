'use client';

import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { EditorVideoContent } from './video/EditorVideoContent';
import { EDITING_UI_STYLES } from './styles';
import { resolveEditorHost } from './host';
import { resolveEditorLabels, resolveLineToolbarLabels, resolveTextToolbarLabels } from './labels';
import { useHostElementEditorAdapters } from './adapters/registry';
import { useCreationAdapter } from './adapters/creation';
import { useTextEditorAdapter } from './adapters/text';
import { useLineEditorAdapter } from './adapters/line';
import { BUILTIN_SHAPE_PATH_FORMULAS } from './adapters/shapeFormulas';
import { resolveEditorInsertItems } from './adapters/insertRegistry';
import { useEditorDispatcher } from './runtime/useEditorDispatcher';
import { useEditorCommands } from './runtime/useEditorCommands';
import { EditorCanvasViewport } from './surface/EditorCanvasViewport';
import { EditorChrome } from './surface/EditorChrome';
import type { EditableSlideCanvasWithUIProps } from './types';

const INSERT_TOOLBAR_RAIL_SIZE = 48;

export function EditableSlideCanvasWithUI({
  slide,
  documentSlide = slide,
  host,
  selection,
  onSelectionChange,
  onTransaction,
  insertItems,
  insertToolbarPlacement = 'top',
  scale,
  onScaleChange,
  elementIdPrefix = 'slide-element-',
  hiddenElementIds,
  snapping,
  grid,
  ruler,
  className,
  style,
}: EditableSlideCanvasWithUIProps) {
  const [insertToolbarRailSize, setInsertToolbarRailSize] = useState(INSERT_TOOLBAR_RAIL_SIZE);
  const resolvedHost = useMemo(() => resolveEditorHost(host), [host]);
  const labels = useMemo(
    () => resolveEditorLabels(resolvedHost.locale, resolvedHost.translate),
    [resolvedHost.locale, resolvedHost.translate],
  );
  const textLabels = useMemo(
    () => resolveTextToolbarLabels(resolvedHost.locale, undefined, resolvedHost.translate),
    [resolvedHost.locale, resolvedHost.translate],
  );
  const lineLabels = useMemo(
    () => resolveLineToolbarLabels(resolvedHost.locale, undefined, resolvedHost.translate),
    [resolvedHost.locale, resolvedHost.translate],
  );
  const { content, dispatch } = useEditorDispatcher(documentSlide, onTransaction);
  const adapterContext = useMemo(
    () => ({
      slide: documentSlide,
      selection,
      hiddenElementIds,
      elementIdPrefix,
      host: resolvedHost,
      labels,
      dispatch,
      select: onSelectionChange,
    }),
    [
      dispatch,
      documentSlide,
      elementIdPrefix,
      hiddenElementIds,
      labels,
      onSelectionChange,
      resolvedHost,
      selection,
    ],
  );
  const creation = useCreationAdapter({
    context: adapterContext,
    host: resolvedHost,
    dispatch,
    onSelectionChange,
  });
  const elementAdapters = useHostElementEditorAdapters(adapterContext);
  const textAdapter = useTextEditorAdapter({
    selection,
    elementIdPrefix,
    labels: textLabels,
    dispatch,
    onSelectionChange,
  });
  const lineOverlay = useLineEditorAdapter({
    slide,
    selection,
    hiddenElementIds,
    elementIdPrefix,
    labels: lineLabels,
    dispatch,
    onSelectionChange,
  });
  const contextMenu = useEditorCommands({
    content,
    selection,
    hiddenElementIds,
    host: resolvedHost,
    labels,
    editorFocused: textAdapter.editorFocused,
    onTransaction,
    onSelectionChange,
    onClearCreation: creation.clear,
  });
  const resolvedInsertItems = useMemo(
    () =>
      resolveEditorInsertItems(
        [...creation.insertContributions, ...elementAdapters.insertContributions],
        insertItems,
      ),
    [creation.insertContributions, elementAdapters.insertContributions, insertItems],
  );
  const hasInsertToolbar = resolvedInsertItems.length > 0;
  const handleInsertToolbarRailSizeChange = useCallback((size: number) => {
    setInsertToolbarRailSize((current) => (current === size ? current : size));
  }, []);
  const canvasViewportStyle = useMemo<CSSProperties>(() => {
    if (!hasInsertToolbar) return { position: 'relative', width: '100%', height: '100%' };
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
  }, [hasInsertToolbar, insertToolbarPlacement, insertToolbarRailSize]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <style dangerouslySetInnerHTML={{ __html: EDITING_UI_STYLES }} />
      <EditorCanvasViewport
        style={canvasViewportStyle}
        contextMenu={contextMenu}
        selection={selection}
        onSelectionChange={onSelectionChange}
        canvasProps={{
          slide,
          scale,
          onScaleChange,
          selection,
          onSelectionChange,
          onElementsChange: dispatch,
          elementIdPrefix,
          hiddenElementIds,
          snapping,
          grid,
          ruler,
          className,
          style,
          shapePathFormulas: BUILTIN_SHAPE_PATH_FORMULAS,
          renderVideo: (element) => <EditorVideoContent element={element} />,
          videoInteractive: false,
          tableEditMaskLabel: labels.table.doubleClickToEdit,
          ...creation.canvasProps,
          ...textAdapter.canvasCallbacks,
        }}
      />
      <EditorChrome
        insertToolbar={
          hasInsertToolbar
            ? {
                items: resolvedInsertItems,
                label: labels.insert.toolbar,
                placement: insertToolbarPlacement,
              }
            : undefined
        }
        onInsertToolbarRailSizeChange={handleInsertToolbarRailSizeChange}
        overlays={[textAdapter.overlay, lineOverlay, ...elementAdapters.overlays]}
      />
    </div>
  );
}
