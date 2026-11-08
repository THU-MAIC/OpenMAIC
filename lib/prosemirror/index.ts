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

/**
 * HTML the legacy canvas persists. The live view keeps ProseMirror's caret
 * helpers (`img.ProseMirror-separator`, `br.ProseMirror-trailingBreak`) when
 * a block ends on an inline atom; those are not document content. An empty
 * paragraph's only child is that break, and that `<br>` is already stored.
 * DOMSerializer would drop it, so this copies the view and strips helpers.
 */
export function editorHtmlForSave(dom: HTMLElement): string {
  const clone = dom.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('img.ProseMirror-separator').forEach((node) => node.remove());
  clone.querySelectorAll('br.ProseMirror-trailingBreak').forEach((br) => {
    const parent = br.parentNode;
    if (!parent) return;
    const hasOtherContent = Array.from(parent.childNodes).some((child) => {
      if (child === br) return false;
      if (child.nodeType === Node.TEXT_NODE) return (child.textContent ?? '') !== '';
      return true;
    });
    if (hasOtherContent) br.remove();
  });
  return clone.innerHTML;
}
