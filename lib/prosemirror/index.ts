import { EditorState } from 'prosemirror-state';
import { type DirectEditorProps, EditorView } from 'prosemirror-view';
import { Schema, DOMParser } from 'prosemirror-model';
import { buildPlugins, type PluginOptions } from './plugins/index';
import { schemaNodes, schemaMarks } from './schema/index';

const schema = new Schema({
  nodes: schemaNodes,
  marks: schemaMarks,
});

export const createDocument = (content: string) => {
  const htmlString = `<div>${content}</div>`;
  const parser = new window.DOMParser();
  const element = parser.parseFromString(htmlString, 'text/html').body.firstElementChild;
  return DOMParser.fromSchema(schema).parse(element as Element);
};

export const initProsemirrorEditor = (
  dom: Element,
  content: string,
  props: Omit<DirectEditorProps, 'state'>,
  pluginOptions?: PluginOptions,
) => {
  return new EditorView(dom, {
    state: EditorState.create({
      doc: createDocument(content),
      plugins: buildPlugins(schema, pluginOptions),
    }),
    ...props,
  });
};
