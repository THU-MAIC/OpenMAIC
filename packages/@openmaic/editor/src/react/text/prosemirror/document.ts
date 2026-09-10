import {
  DOMParser as ProseMirrorDOMParser,
  DOMSerializer,
  type Node as ProseMirrorNode,
} from 'prosemirror-model';
import { textSchema } from './schema';

const HTML_MARKUP_PATTERN = /<\/?[a-z][^>]*>|<![^>]*>/i;

export function createTextDocument(html: string): ProseMirrorNode {
  const template = document.createElement('template');
  if (HTML_MARKUP_PATTERN.test(html)) {
    template.innerHTML = html;
  } else {
    // Match the renderer's `dangerouslySetInnerHTML` semantics for entities
    // while keeping the tag-free path as text, then make its literal line
    // endings explicit ProseMirror hard breaks.
    const decoded = document.createElement('template');
    decoded.innerHTML = html;
    const lines = (decoded.content.textContent ?? '').split(/\r\n?|\n/);
    lines.forEach((line, index) => {
      if (index > 0) template.content.append(document.createElement('br'));
      template.content.append(document.createTextNode(line));
    });
  }
  return ProseMirrorDOMParser.fromSchema(textSchema).parse(template.content);
}

export function serializeTextDocument(doc: ProseMirrorNode): string {
  const host = document.createElement('div');
  host.appendChild(DOMSerializer.fromSchema(textSchema).serializeFragment(doc.content));
  return host.innerHTML;
}
