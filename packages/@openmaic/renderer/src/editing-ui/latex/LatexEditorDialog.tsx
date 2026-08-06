'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { renderLatexSource, type LatexEditorResult } from './latex-editor';
import type { LatexEditorLabels } from '../types';

const DEFAULT_LABELS: LatexEditorLabels = {
  toolbar: 'Formula toolbar',
  insertFormula: 'Insert formula',
  editFormula: 'Edit formula',
  bringToFront: 'Bring to front',
  sendToBack: 'Send to back',
  delete: 'Delete',
  dialog: 'Formula editor',
  source: 'LaTeX source',
  preview: 'Preview',
  symbols: 'Symbols',
  presets: 'Presets',
  cancel: 'Cancel',
  confirm: 'Confirm',
  invalidSource: 'The LaTeX source is invalid.',
};

export interface LatexEditorDialogProps {
  readonly initialLatex?: string;
  readonly labels?: Partial<LatexEditorLabels>;
  readonly onConfirm: (result: LatexEditorResult) => void;
  readonly onClose: () => void;
}

export function LatexEditorDialog({
  initialLatex = '',
  labels: providedLabels,
  onConfirm,
  onClose,
}: LatexEditorDialogProps) {
  const labels = { ...DEFAULT_LABELS, ...providedLabels };
  const [latex, setLatex] = useState(initialLatex);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const rendered = useMemo(() => renderLatexSource(latex), [latex]);
  const canConfirm = latex.trim().length > 0 && !('error' in rendered);

  useEffect(() => {
    sourceRef.current?.focus();
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const confirm = () => {
    if (!canConfirm || 'error' in rendered) return;
    const preview = previewRef.current;
    onConfirm({
      latex,
      html: rendered.html,
      width: Math.max(120, Math.ceil(preview?.scrollWidth ?? 0) + 32),
      height: Math.max(48, Math.ceil(preview?.scrollHeight ?? 0) + 32),
    });
  };

  return (
    <div className="maic-editing-ui-latex-backdrop" onPointerDown={onClose}>
      <section
        className="maic-editing-ui-latex-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={labels.dialog}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="maic-editing-ui-latex-main">
          <div className="maic-editing-ui-latex-workspace">
            <label className="maic-editing-ui-latex-source-label" htmlFor="maic-latex-source">
              {labels.source}
            </label>
            <textarea
              ref={sourceRef}
              id="maic-latex-source"
              className="maic-editing-ui-latex-source"
              value={latex}
              onChange={(event) => setLatex(event.target.value)}
              spellCheck={false}
            />
            <div className="maic-editing-ui-latex-preview-shell">
              <span className="maic-editing-ui-latex-preview-label">{labels.preview}</span>
              <div className="maic-editing-ui-latex-preview" data-testid="latex-editor-preview">
                {'error' in rendered || !latex.trim() ? null : (
                  <div
                    ref={previewRef}
                    className="slide-renderer-prose"
                    dangerouslySetInnerHTML={{ __html: rendered.html }}
                  />
                )}
              </div>
              <p className="maic-editing-ui-latex-error" role="status" aria-live="polite">
                {'error' in rendered ? rendered.error || labels.invalidSource : ''}
              </p>
            </div>
          </div>

          {/*
            Temporarily hide the sample palette while the complete PPTist catalog
            is migrated and checked against the KaTeX HTML rendering contract.
            Keep the labels and catalog module for the planned restoration.
          */}
        </div>
        <footer className="maic-editing-ui-latex-footer">
          <button type="button" className="maic-editing-ui-latex-cancel" onClick={onClose}>
            {labels.cancel}
          </button>
          <button
            type="button"
            className="maic-editing-ui-latex-confirm"
            disabled={!canConfirm}
            onClick={confirm}
          >
            {labels.confirm}
          </button>
        </footer>
      </section>
    </div>
  );
}
