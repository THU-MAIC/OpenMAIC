import { setTimeout } from 'node:timers/promises';
import type { Action } from '@openmaic/dsl';
import type { Frame, Page } from 'puppeteer-core';

export const INTERACTIVE_RUNTIME_DEADLINE_MS = 3_000;
const OBSERVATION_MS = 75;
const MAX_ERRORS = 20;
const MAX_MESSAGE_CHARS = 240;

type WidgetMessage =
  | { type: 'SET_WIDGET_STATE'; state: Record<string, unknown>; content?: string }
  | {
      type: 'HIGHLIGHT_ELEMENT' | 'ANNOTATE_ELEMENT' | 'REVEAL_ELEMENT';
      target: string;
      content?: string;
    };

// Match lib/action/engine.ts and InteractiveIframeHost: only the widget fields
// go over postMessage, without the DSL action id or the narration action.
export function widgetMessage(action: Action): WidgetMessage | undefined {
  switch (action.type) {
    case 'widget_setState':
      return { type: 'SET_WIDGET_STATE', state: action.state, content: action.content };
    case 'widget_highlight':
      return { type: 'HIGHLIGHT_ELEMENT', target: action.target, content: action.content };
    case 'widget_annotation':
      return { type: 'ANNOTATE_ELEMENT', target: action.target, content: action.content };
    case 'widget_reveal':
      return { type: 'REVEAL_ELEMENT', target: action.target, content: action.content };
  }
}

type RuntimeErrorSource =
  | { phase: 'load' }
  | { phase: 'action'; actionIndex: number; actionType: WidgetMessage['type'] };

export type InteractiveRuntimeError = RuntimeErrorSource & { message: string };

export function collectInteractiveRuntimeErrors(page: Page) {
  const errors: InteractiveRuntimeError[] = [];
  const seen = new Set<string>();
  let source: RuntimeErrorSource = { phase: 'load' };
  // Chromium emits pageerror for uncaught exceptions and unhandled rejections,
  // including primitive reasons. Console logging and resource errors are separate.
  const onError = (error: unknown) => {
    if (errors.length >= MAX_ERRORS) return;
    const description = error instanceof Error ? error.toString() : String(error);
    // Keep this filter aligned with the iframe error shim in lib/utils/iframe.ts.
    if (
      /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/.test(
        description,
      )
    )
      return;
    const message = (description.replace(/\s+/g, ' ').trim() || 'Uncaught JavaScript error').slice(
      0,
      MAX_MESSAGE_CHARS,
    );
    const key = `${source.phase === 'load' ? 'load' : source.actionIndex}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push({ ...source, message });
  };
  page.on('pageerror', onError);

  return {
    errors,
    beginAction(actionIndex: number, actionType: WidgetMessage['type']) {
      source = { phase: 'action', actionIndex, actionType };
    },
    dispose: () => page.off('pageerror', onError),
  };
}

async function observeFrame(frame: Frame): Promise<void> {
  // Allow microtasks, rejection reporting and short timers to run, then verify
  // the frame is still responsive before advancing to the next action.
  await setTimeout(OBSERVATION_MS);
  const loaded = await frame.evaluate(() => location.href === 'about:srcdoc');
  if (!loaded) throw new Error('Interactive iframe navigated away during the runtime check');
}

export async function replayInteractiveActions(
  page: Page,
  frame: Frame,
  actions: readonly Action[],
  collector: ReturnType<typeof collectInteractiveRuntimeErrors>,
): Promise<void> {
  await observeFrame(frame);
  for (const [index, action] of actions.entries()) {
    const message = widgetMessage(action);
    if (!message) continue;
    collector.beginAction(index, message.type);
    await page.evaluate((data) => {
      const target = document.querySelector('iframe')?.contentWindow;
      if (!target) throw new Error('Interactive iframe is missing during action replay');
      target.postMessage({ ...data, content: data.content }, '*');
    }, message);
    await observeFrame(frame);
  }
}
