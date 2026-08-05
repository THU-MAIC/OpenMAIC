import { EditorState } from 'prosemirror-state';
import { type DirectEditorProps, EditorView } from 'prosemirror-view';
import { textSchema } from './schema';
import { buildPlugins, type PluginOptions } from './plugins';
import { createTextDocument } from './document';

export type InitTextEditorOptions = Omit<DirectEditorProps, 'state'> & PluginOptions;

export function initTextEditor(
  element: Element,
  content: string,
  options: InitTextEditorOptions,
): EditorView {
  const state = EditorState.create({
    doc: createTextDocument(content),
    schema: textSchema,
    plugins: buildPlugins(textSchema, options),
  });
  return new EditorView(element, { state, ...options });
}

export { createTextDocument, serializeTextDocument } from './document';
export { textSchema } from './schema';
