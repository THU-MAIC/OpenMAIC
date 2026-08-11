import { parse, type DefaultTreeAdapterTypes } from 'parse5';

function isElement(
  node: DefaultTreeAdapterTypes.ChildNode,
): node is DefaultTreeAdapterTypes.Element {
  return !node.nodeName.startsWith('#');
}

function insertAt(html: string, offset: number, injection: string): string {
  return html.slice(0, offset) + injection + html.slice(offset);
}

/** Inject markup at the start of the document's parsed head without rewriting authored HTML. */
export function injectIntoDocumentHead(html: string, injection: string): string {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const htmlElement = document.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => isElement(node) && node.tagName === 'html',
  );
  const headElement = htmlElement?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => isElement(node) && node.tagName === 'head',
  );
  const explicitHeadEnd = headElement?.sourceCodeLocation?.startTag?.endOffset;
  if (explicitHeadEnd !== undefined) return insertAt(html, explicitHeadEnd, injection);

  const firstHeadChildOffset = headElement?.childNodes.reduce<number | undefined>((first, node) => {
    const offset = node.sourceCodeLocation?.startOffset;
    if (offset === undefined) return first;
    return first === undefined ? offset : Math.min(first, offset);
  }, undefined);
  if (firstHeadChildOffset !== undefined) return insertAt(html, firstHeadChildOffset, injection);

  const explicitHtmlEnd = htmlElement?.sourceCodeLocation?.startTag?.endOffset;
  if (explicitHtmlEnd !== undefined) {
    return insertAt(html, explicitHtmlEnd, `<head>${injection}</head>`);
  }

  const doctype = document.childNodes.find((node) => node.nodeName === '#documentType');
  const doctypeEnd = doctype?.sourceCodeLocation?.endOffset;
  if (doctypeEnd !== undefined) return insertAt(html, doctypeEnd, `<head>${injection}</head>`);

  return `<head>${injection}</head>${html}`;
}
