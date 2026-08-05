import type {
  TextAutoSizeIntent,
  TextContentChange,
  TextEditCommand,
  TextEditorController,
  TextFormatState,
} from '@openmaic/renderer/editing';
import {
  registerActiveTextEditor,
  type TextCommandPayload,
} from '@/lib/prosemirror/active-editor-registry';
import type { TextAttrs } from '@/lib/prosemirror/utils';
import type { SlideContent } from '@/lib/types/stage';
import { applyRendererEditIntents } from './renderer-edit-intents';
import { useSlideEditSession } from './slide-edit-session';

function assertNever(value: never): never {
  throw new Error(`Unsupported renderer text command: ${String(value)}`);
}

export function mapToolbarCommand(payload: TextCommandPayload): TextEditCommand {
  switch (payload.command) {
    case 'bold':
    case 'em':
    case 'underline':
      return { command: payload.command };
    case 'fontname':
    case 'fontsize':
    case 'forecolor':
      return { command: payload.command, value: payload.value ?? '' };
    case 'align-left':
      return { command: 'align', value: 'left' };
    case 'align-center':
      return { command: 'align', value: 'center' };
    case 'align-right':
      return { command: 'align', value: 'right' };
    case 'bulletList':
      return { command: 'bulletList', value: payload.value };
    default:
      return assertNever(payload.command);
  }
}

export function connectRendererTextController(controller: TextEditorController): () => void {
  return registerActiveTextEditor(controller.elementId, (payload) => {
    controller.execute(mapToolbarCommand(payload));
  });
}

export function mapRendererTextFormatState(state: TextFormatState): TextAttrs {
  return {
    bold: state.bold,
    em: state.em,
    underline: state.underline,
    strikethrough: state.strikethrough,
    superscript: state.superscript,
    subscript: state.subscript,
    code: state.code,
    color: state.color,
    backcolor: state.backcolor,
    fontsize: state.fontsize,
    fontname: state.fontname,
    link: state.link,
    align: state.align,
    bulletList: state.bulletList,
    orderedList: state.orderedList,
    blockquote: state.blockquote,
  };
}

export function commitRendererTextChange(content: SlideContent, change: TextContentChange): void {
  const next = applyRendererEditIntents(content, [change.intent]);
  if (next === content) return;
  useSlideEditSession.getState().commitContent(next, change.history === 'record');
}

export function commitRendererTextAutoSize(
  content: SlideContent,
  intent: TextAutoSizeIntent,
): void {
  const next = applyRendererEditIntents(content, [intent]);
  if (next === content) return;
  useSlideEditSession.getState().commitContent(next, false);
}
