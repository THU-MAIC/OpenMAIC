import { createElement, useMemo, useState } from 'react';
import { Sigma } from 'lucide-react';
import type { PPTLatexElement } from '@openmaic/dsl';
import { LatexEditorDialog } from '../latex/LatexEditorDialog';
import { LatexToolbarOverlay } from '../latex/LatexToolbarOverlay';
import type { LatexEditorResult } from '../latex/latex-editor';
import { createDefaultLatexElement } from './defaultElements';
import type { ElementAdapterContext, ElementEditorAdapter } from './types';
import { deleteElement, reorderElement } from './shared';

type LatexDialogState =
  | { readonly mode: 'insert' }
  | { readonly mode: 'edit'; readonly element: PPTLatexElement }
  | null;

export function useLatexAdapters(
  context: ElementAdapterContext | null,
  selected: PPTLatexElement | null,
): readonly ElementEditorAdapter[] {
  const [dialog, setDialog] = useState<LatexDialogState>(null);

  return useMemo(() => {
    if (!context) return [];
    const labels = context.labels;
    const common = labels.element;
    const adapter: ElementEditorAdapter<PPTLatexElement> = {
      id: 'latex',
      type: 'latex',
      insertType: 'latex',
      insertItem: {
        id: 'insert-latex',
        label: labels.insert.formula,
        tooltip: labels.insert.formula,
        icon: createElement(Sigma, { 'aria-hidden': true }),
        onInvoke: () => setDialog({ mode: 'insert' }),
      },
      overlay: selected ? (
        <LatexToolbarOverlay
          element={selected}
          elementIdPrefix={context.elementIdPrefix}
          toolbarLabel={labels.latex.toolbar}
          editLabel={labels.latex.edit}
          bringToFrontLabel={common.bringToFront}
          sendToBackLabel={common.sendToBack}
          deleteLabel={common.delete}
          onEdit={() => setDialog({ mode: 'edit', element: selected })}
          onBringToFront={() => reorderElement(context, selected.id, 'front')}
          onSendToBack={() => reorderElement(context, selected.id, 'back')}
          onDelete={() => deleteElement(context, selected.id)}
        />
      ) : undefined,
    };
    if (!dialog) return [adapter];

    const complete = (result: LatexEditorResult) => {
      if (dialog.mode === 'edit') {
        context.dispatch(
          [
            {
              type: 'element.update',
              id: dialog.element.id,
              props: {
                latex: result.latex,
                html: result.html,
                width: result.width,
                height: result.height,
              },
            },
          ],
          { origin: 'toolbar' },
        );
      } else {
        const id = context.host.createElementId('latex');
        context.dispatch(
          [{ type: 'element.add', element: createDefaultLatexElement(id, result) }],
          { origin: 'toolbar' },
        );
        context.select({ elementIds: [id], primaryId: id });
      }
      setDialog(null);
    };

    return [
      adapter,
      {
        id: 'latex-dialog',
        overlay: (
          <LatexEditorDialog
            initialLatex={dialog.mode === 'edit' ? dialog.element.latex : ''}
            labels={{
              toolbar: labels.latex.toolbar,
              insertFormula: labels.insert.formula,
              editFormula: labels.latex.edit,
              bringToFront: common.bringToFront,
              sendToBack: common.sendToBack,
              delete: common.delete,
              dialog: labels.latex.dialog,
              source: labels.latex.source,
              preview: labels.latex.preview,
              symbols: labels.latex.symbols,
              presets: labels.latex.presets,
              invalidSource: labels.latex.invalidSource,
              cancel: labels.common.cancel,
              confirm: labels.common.confirm,
            }}
            onConfirm={complete}
            onClose={() => setDialog(null)}
          />
        ),
      },
    ];
  }, [context, dialog, selected]);
}
