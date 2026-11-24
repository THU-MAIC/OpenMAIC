import { EventEmitter } from 'node:events';
import type { Page } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import { collectInteractiveRuntimeErrors, widgetMessage } from '../src/interactive-runtime.js';

describe('interactive runtime collection', () => {
  it('keeps distinct browser exceptions per phase and ignores console and benign noise', () => {
    const page = new EventEmitter();
    const collector = collectInteractiveRuntimeErrors(page as unknown as Page);
    page.emit('console', new Error('Console only'));
    page.emit(
      'pageerror',
      new Error('ResizeObserver loop completed with undelivered notifications.'),
    );
    page.emit('pageerror', 'ResizeObserver loop limit exceeded');
    page.emit('pageerror', new ReferenceError('Missing function'));
    page.emit('pageerror', new ReferenceError('Missing function'));
    collector.beginAction(2, 'REVEAL_ELEMENT');
    page.emit('pageerror', new ReferenceError('Missing function'));
    page.emit('pageerror', 'Rejected\nwith a string');
    collector.dispose();
    page.emit('pageerror', new Error('After disposal'));

    expect(collector.errors).toEqual([
      { phase: 'load', message: 'ReferenceError: Missing function' },
      {
        phase: 'action',
        actionIndex: 2,
        actionType: 'REVEAL_ELEMENT',
        message: 'ReferenceError: Missing function',
      },
      {
        phase: 'action',
        actionIndex: 2,
        actionType: 'REVEAL_ELEMENT',
        message: 'Rejected with a string',
      },
    ]);
  });

  it('bounds the number and length of errors', () => {
    const page = new EventEmitter();
    const collector = collectInteractiveRuntimeErrors(page as unknown as Page);
    for (let i = 0; i < 100; i++) page.emit('pageerror', `${i}: ${'x'.repeat(1_000)}`);
    expect(collector.errors).toHaveLength(20);
    expect(collector.errors[0]?.message).toHaveLength(240);
  });

  it('maps the four classroom widget payloads and skips narration', () => {
    const target = '#part';
    const content = 'Look here';
    const state = { mass: 2 };
    const id = 'action';
    expect(widgetMessage({ id, type: 'widget_highlight', target, content })).toEqual({
      type: 'HIGHLIGHT_ELEMENT',
      target,
      content,
    });
    expect(widgetMessage({ id, type: 'widget_annotation', target, content })).toEqual({
      type: 'ANNOTATE_ELEMENT',
      target,
      content,
    });
    expect(widgetMessage({ id, type: 'widget_reveal', target, content })).toEqual({
      type: 'REVEAL_ELEMENT',
      target,
      content,
    });
    expect(widgetMessage({ id, type: 'widget_setState', state, content })).toEqual({
      type: 'SET_WIDGET_STATE',
      state,
      content,
    });
    expect(widgetMessage({ id, type: 'speech', text: content })).toBeUndefined();
  });
});
