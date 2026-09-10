import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(
  process.cwd(),
  'components/edit/surfaces/slide/RendererEditorCanvas.tsx',
);
const editorReadmePath = resolve(process.cwd(), 'packages/@openmaic/editor/README.md');
const packageSmokePath = resolve(process.cwd(), 'scripts/smoke-test-package-tarballs.mjs');

describe('renderer editor app boundary', () => {
  it('uses one generic host bridge without element-specific editor configuration', () => {
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('host={');
    for (const forbidden of [
      'latexEditor=',
      'videoEditor=',
      'videoInsert=',
      'audioEditor=',
      'audioInsert=',
      'imageEditor=',
      'elementToolbar=',
      'insertToolbar=',
      'createDefaultLatexElement',
      'PPTVideoElement',
      'PPTAudioElement',
      'PPTImageElement',
      'PPTLineElement',
      'SHAPE_PATH_FORMULAS',
      'shapePathFormulas=',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps document persistence in the app transaction sink', () => {
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('applyTransactionForScene(sceneId, transaction)');
    expect(source).toContain('onTransaction={applyTransaction}');
    expect(source).toContain('onSelectionChange={handleSelectionChange}');
    expect(source).toContain('documentSlide={content.canvas}');
  });

  it('documents a complete third-party controlled-state and style setup', () => {
    const readme = readFileSync(editorReadmePath, 'utf8');

    expect(readme).toContain('import { applyEditorTransaction, createEditorHistory');
    expect(readme).toContain(
      'setHistory((current) => applyEditorTransaction(current, transaction))',
    );
    expect(readme).toContain("import '@openmaic/renderer/fonts.css';");
    expect(readme).toContain("import 'katex/dist/katex.min.css';");
    expect(readme).toContain('Tailwind 4');
  });

  it('smoke-tests every published editor entry from packed artifacts', () => {
    const smoke = readFileSync(packageSmokePath, 'utf8');

    expect(smoke).toContain("from '@openmaic/editor';");
    expect(smoke).toContain("from '@openmaic/editor/core';");
    expect(smoke).toContain("from '@openmaic/editor/react';");
    expect(smoke).toContain("from '@openmaic/editor/ui';");
  });
});
