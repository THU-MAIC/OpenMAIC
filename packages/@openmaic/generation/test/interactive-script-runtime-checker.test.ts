import { describe, expect, it } from 'vitest';

import { findInteractiveScriptRuntimeFailure } from '../src/interactive-script-runtime-checker.js';

/** A clean simulation page: every variable is declared, the slider has data-var,
 *  and the handler null-guards before touching the DOM. */
const CLEAN_PAGE = [
  '<html><body>',
  '<input id="density-slider" data-var="density">',
  '<div id="density-display"></div>',
  '<script>',
  '  const state = {};',
  '  const densitySlider = document.getElementById("density-slider");',
  '  const densityDisplay = document.getElementById("density-display");',
  '  densitySlider.addEventListener("input", () => {',
  '    const variable = densitySlider.dataset.var;',
  '    if (!variable) return;',
  '    state[variable] = densitySlider.value;',
  '    if (densityDisplay) densityDisplay.textContent = densitySlider.value;',
  '  });',
  '</script>',
  '</body></html>',
].join('\n');

/** Bug 1: `canvasContainer` is referenced but never declared (the model assumed
 *  the element `id` becomes a global). Throws at top-level. */
const BUG1_UNDECLARED_VAR = [
  '<html><body><div id="canvas-container"></div>',
  '<script>',
  '  const canvas = document.getElementById("canvas-container");',
  '  canvasContainer.clientWidth;',
  '</script>',
  '</body></html>',
].join('\n');

/** Bug 2: the slider is missing its `data-var` attribute, so `dataset.var` is
 *  undefined and the handler reads `state["undefinedDisplay"]` -> TypeError on
 *  the `input` event the platform dispatches during initialization. */
const BUG2_MISSING_DATA_VAR = [
  '<html><body>',
  '<input id="density-slider">',
  '<div id="density-display"></div>',
  '<script>',
  '  const state = {};',
  '  const densitySlider = document.getElementById("density-slider");',
  '  densitySlider.addEventListener("input", () => {',
  '    const variable = densitySlider.dataset.var;',
  '    state[`${variable}Display`].textContent = densitySlider.value;',
  '  });',
  '</script>',
  '</body></html>',
].join('\n');

describe('findInteractiveScriptRuntimeFailure', () => {
  it('accepts a clean interactive page', () => {
    expect(findInteractiveScriptRuntimeFailure(CLEAN_PAGE)).toBeNull();
  });

  it('reports an undeclared variable thrown at top-level (Bug 1)', () => {
    const failure = findInteractiveScriptRuntimeFailure(BUG1_UNDECLARED_VAR);
    expect(failure).not.toBeNull();
    expect(failure!.phase).toBe('top-level');
    expect(failure!.message).toMatch(/canvasContainer is not defined/);
  });

  it('reports a TypeError from a slider handler missing data-var (Bug 2)', () => {
    const failure = findInteractiveScriptRuntimeFailure(BUG2_MISSING_DATA_VAR);
    expect(failure).not.toBeNull();
    expect(failure!.phase).toMatch(/^input:/);
    expect(failure!.message).toMatch(/Cannot set properties of undefined/);
  });

  it.each([
    [
      'widget config JSON',
      '<script type="application/json" id="widget-config">{"type":"simulation"}</script>',
    ],
    ['external scripts', '<script src="https://example.com/widget.js"></script>'],
    [
      'module scripts',
      '<script type="module">import value from "./value.js"; console.log(value);</script>',
    ],
  ])('skips %s because it is not a classic inline script body', (_label, script) => {
    expect(findInteractiveScriptRuntimeFailure(`<html><body>${script}</body></html>`)).toBeNull();
  });
});
