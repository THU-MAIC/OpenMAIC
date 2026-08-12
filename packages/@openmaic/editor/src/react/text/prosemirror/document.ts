import {
  DOMParser as ProseMirrorDOMParser,
  DOMSerializer,
  type Node as ProseMirrorNode,
} from 'prosemirror-model';
import { textSchema } from './schema';

export function createTextDocument(html: string): ProseMirrorNode {
  const template = document.createElement('template');
  template.innerHTML = html;
  return ProseMirrorDOMParser.fromSchema(textSchema).parse(template.content);
}

export function serializeTextDocument(doc: ProseMirrorNode): string {
  const host = document.createElement('div');
  host.appendChild(DOMSerializer.fromSchema(textSchema).serializeFragment(doc.content));
  return host.innerHTML;
}
